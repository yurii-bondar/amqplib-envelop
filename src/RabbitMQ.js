const { EventEmitter } = require('events');
const amqplib = require('amqplib');

/**
 * @class RabbitMQ
 * @desc Wrapper class for working with RabbitMQ.
 * @fires RabbitMQ#reconnect - After a dropped connection/channel has been re-established
 * and previously asserted exchanges/queues/bindings/consumers have been restored. Useful
 * for consumers (like {@link RpcClient}) that hold state tied to the channel, such as an
 * exclusive reply queue, and need to recreate it after a reconnect.
 */
class RabbitMQ extends EventEmitter {
  /**
   * @private
   * @desc Interval in seconds between timeouts for heartbeat pulses in the connection
   * between the client and the RabbitMQ server. Used to check activity and connection status.
   * @type {number}
   */
  #HEARTBEAT = 60;

  /**
   * @private
   * @desc Time (in milliseconds) within which the client must establish a connection with the
   * RabbitMQ server. If the connection is not established within this period,
   * a timeout error may occur.
   * @type {number}
   */
  #CONNECTION_TIMEOUT = 30_000;

  /**
   * @private
   * @desc Whether the instance should automatically try to reconnect (and restore
   * previously asserted exchanges/queues/bindings/consumers) when the connection
   * or channel is unexpectedly closed.
   * @type {boolean}
   */
  #reconnect = true;

  /**
   * @private
   * @desc Delay (in milliseconds) between reconnection attempts.
   * @type {number}
   */
  #reconnectDelay = 5000;

  /**
   * @private
   * @desc Guards against scheduling overlapping reconnection attempts.
   * @type {boolean}
   */
  #reconnecting = false;

  /**
   * @private
   * @desc Set while `closeConnection` is intentionally closing the connection/channel,
   * so the resulting 'close' events do not trigger a reconnect attempt.
   * @type {boolean}
   */
  #closingIntentionally = false;

  /**
   * @private
   * @desc Exchanges asserted via {@link assertExchange}, keyed by exchange name.
   * Replayed after a reconnect.
   * @type {Map<string, object>}
   */
  #exchanges = new Map();

  /**
   * @private
   * @desc Queues asserted via {@link assertQueue}, keyed by queue name.
   * Replayed after a reconnect.
   * @type {Map<string, object>}
   */
  #queues = new Map();

  /**
   * @private
   * @desc Bindings created via {@link bindQueue}, keyed by `queue|source|pattern`.
   * Replayed after a reconnect.
   * @type {Map<string, object>}
   */
  #bindings = new Map();

  /**
   * @private
   * @desc Consumers registered via {@link consume}, keyed by queue name.
   * Replayed after a reconnect.
   * @type {Map<string, object>}
   */
  #consumers = new Map();

  /**
   * @static
   * @desc Active instance of RabbitMQ.
   * @type {RabbitMQ|null}
   */
  static activeInstance = null;

  /**
   * @static
   * @private
   * @desc In-flight initialization promise, used so concurrent calls to
   * {@link initAndGetInstance} share a single connection attempt instead of racing.
   * @type {Promise<RabbitMQ>|null}
   */
  static #initPromise = null;

  /**
   * @static
   * @private
   * @desc Whether {@link registerGracefulShutdown} has already attached process listeners.
   * @type {boolean}
   */
  static #shutdownRegistered = false;

  /**
   * @param {object} connection - Connection configuration.
   * @param {boolean} [connection.reconnect=true] - Automatically reconnect and restore
   * exchanges/queues/bindings/consumers if the connection or channel closes unexpectedly.
   * @param {number} [connection.reconnectDelay=5000] - Delay (ms) between reconnect attempts.
   */
  constructor(connection) {
    super();
    this.connectionArgs = connection;
    this.connection = null;
    this.channel = null;
    this.#reconnect = connection?.reconnect !== false;
    this.#reconnectDelay = connection?.reconnectDelay ?? 5000;
  }

  async init() {
    try {
      await this.#establishConnection();
    } catch (err) {
      console.error(`${__filename}/init error:`, err?.message);
      this.#scheduleReconnect();
    }
  }

  /**
   * @private
   * @desc Opens the connection and channel, and attaches error/close listeners to them.
   */
  async #establishConnection() {
    this.connection = await amqplib.connect(this.getConnectionString());
    this.#attachConnectionListeners();
    this.channel = await this.connection.createChannel();
    this.#attachChannelListeners();
  }

  /**
   * @private
   * @desc Logs connection-level errors and triggers a reconnect on unexpected close,
   * so a dropped connection cannot crash the process with an unhandled 'error' event.
   */
  #attachConnectionListeners() {
    this.connection.on('error', (err) => {
      console.error(`${__filename}/connection error:`, err?.message);
    });
    this.connection.on('close', () => {
      if (this.#closingIntentionally) return;
      console.error(`${__filename}/connection closed unexpectedly`);
      this.#scheduleReconnect();
    });
  }

  /**
   * @private
   * @desc Logs channel-level errors and triggers a reconnect on unexpected close.
   */
  #attachChannelListeners() {
    this.channel.on('error', (err) => {
      console.error(`${__filename}/channel error:`, err?.message);
    });
    this.channel.on('close', () => {
      if (this.#closingIntentionally) return;
      console.error(`${__filename}/channel closed unexpectedly`);
      this.#scheduleReconnect();
    });
  }

  /**
   * @private
   * @desc Schedules a reconnection attempt after {@link #reconnectDelay} milliseconds.
   * On success, replays previously asserted exchanges/queues/bindings/consumers.
   * On failure, reschedules itself.
   */
  #scheduleReconnect() {
    if (!this.#reconnect || this.#reconnecting || this.#closingIntentionally) return;
    this.#reconnecting = true;

    setTimeout(async () => {
      this.#reconnecting = false;
      if (this.#closingIntentionally) return;

      try {
        this.connection = null;
        this.channel = null;
        await this.#establishConnection();
        await this.#restoreState();
        this.emit('reconnect');
      } catch (err) {
        console.error(`${__filename}/reconnect error:`, err?.message);
        if (this.connection) {
          try {
            await this.connection.close();
          } catch (closeErr) {
            console.error(`${__filename}/reconnect cleanup error:`, closeErr?.message);
          }
        }
        this.connection = null;
        this.channel = null;
        this.#scheduleReconnect();
      }
    }, this.#reconnectDelay);
  }

  /**
   * @private
   * @desc Re-applies exchanges, queues, bindings and consumers that were set up before
   * a reconnect, in dependency order (exchanges, then queues, then bindings, then consumers).
   */
  async #restoreState() {
    await Promise.all(
      [...this.#exchanges.values()].map((exchange) => this.assertExchange(exchange)),
    );
    await Promise.all(
      [...this.#queues.values()].map((queue) => this.assertQueue(queue)),
    );
    await Promise.all(
      [...this.#bindings.values()].map((binding) => this.bindQueue(binding)),
    );
    await Promise.all(
      [...this.#consumers.values()].map(({ queueConfig, callback, consumerOptions }) => (
        this.consume(queueConfig, callback, consumerOptions)
      )),
    );
  }

  getConnectionString() {
    const {
      protocol = 'amqp:',
      hostname,
      vhost = '',
      port = 5672,
      user,
      password,
      connectionName,
    } = this.connectionArgs;
    return `${protocol}//${user}:${password}@${hostname}:${port}/${vhost}?${this.connectionQuery(connectionName)}`;
  }

  connectionQuery(connectionName) {
    const clientProperties = `${encodeURIComponent(`{"connection_name":"${connectionName}"}`)}`;
    return `heartbeat=${this.#HEARTBEAT}&connection_timeout=${this.#CONNECTION_TIMEOUT}&client_properties=${clientProperties}`;
  }

  /**
   * @returns {RabbitMQ|null} - active instance of RabbitMQ or null
   */
  static getActiveInstance() {
    return RabbitMQ.activeInstance;
  }

  /**
   * Method for initialization and obtaining the active instance of RabbitMQ.
   * Concurrent calls share a single connection attempt instead of racing.
   * @param {object} connection - Connection configuration.
   * @returns {RabbitMQ} - Active instance of RabbitMQ.
   */
  static async initAndGetInstance(connection) {
    if (RabbitMQ.activeInstance) {
      return RabbitMQ.activeInstance;
    }

    if (!RabbitMQ.#initPromise) {
      RabbitMQ.#initPromise = (async () => {
        const instance = new RabbitMQ(connection);
        await instance.init();
        RabbitMQ.activeInstance = instance;
        return instance;
      })();
    }

    try {
      return await RabbitMQ.#initPromise;
    } finally {
      RabbitMQ.#initPromise = null;
    }
  }

  /**
   * Registers SIGINT/SIGTERM handlers that close the active RabbitMQ connection before
   * the process exits. Opt-in: call this explicitly if you want the library to manage
   * shutdown for you, instead of doing it manually (see README "Using (worker)").
   * @param {string[]} [signals=['SIGINT', 'SIGTERM']] - Signals to listen for.
   */
  static registerGracefulShutdown(signals = ['SIGINT', 'SIGTERM']) {
    if (RabbitMQ.#shutdownRegistered) {
      return;
    }
    RabbitMQ.#shutdownRegistered = true;

    const shutdown = async () => {
      try {
        if (RabbitMQ.activeInstance) {
          await RabbitMQ.activeInstance.closeConnection();
        }
      } catch (err) {
        console.error(`${__filename}/registerGracefulShutdown error:`, err?.message);
      } finally {
        process.exit(0);
      }
    };

    signals.forEach((signal) => process.once(signal, shutdown));
  }

  /**
   * Binding a queue to an exchange with the specified parameters.
   * @param {object} bindConfig - Configuration for binding a queue to an exchange.
   * @param {string} bindConfig.queue - Queue name.
   * @param {string} bindConfig.source - Exchange name to which the queue is bound.
   * @param {string} bindConfig.pattern - Binding pattern (routing key or pattern).
   */
  async bindQueue(bindConfig) {
    try {
      const { queue, source, pattern } = bindConfig;
      await this.channel.bindQueue(queue, source, pattern);
      this.#bindings.set(`${queue}|${source}|${pattern}`, bindConfig);
    } catch (err) {
      console.error(`${__filename}/bindQueue error:`, err?.message);
    }
  }

  /**
   * Unbinding a queue from an exchange with the specified parameters.
   * @param {object} bindConfig - Configuration for unbinding a queue from an exchange.
   * @param {string} bindConfig.queue - Queue name.
   * @param {string} bindConfig.source - Exchange name to unbind the queue from.
   * @param {string} bindConfig.pattern - Binding pattern (routing key or pattern).
   */
  async unbindQueue(bindConfig) {
    try {
      const { queue, source, pattern } = bindConfig;
      await this.channel.unbindQueue(queue, source, pattern);
      this.#bindings.delete(`${queue}|${source}|${pattern}`);
    } catch (err) {
      console.error(`${__filename}/unbindQueue error:`, err?.message);
    }
  }

  /**
   * Checking the existence of a queue and creating it if it does not exist.
   * @param {object} queueConfig - Queue configuration.
   * @param {string} queueConfig.name - Queue name.
   * @param {boolean} [queueConfig.durable=true] - Marks the queue as durable (persisted).
   * @param {object} [queueConfig.arguments] - Additional arguments for the queue.
   */
  async assertQueue(queueConfig) {
    try {
      const { name, durable = true, arguments: queueArguments } = queueConfig;
      await this.channel.assertQueue(name, { durable, arguments: queueArguments });
      this.#queues.set(name, queueConfig);
    } catch (err) {
      console.error(`${__filename}/assertQueue error:`, err?.message);
    }
  }

  /**
   * Deleting a queue.
   * @param {String} queue - Queue name.
   * @param {Object} options - Additional queue options (ifUnused, ifEmpty, etc.).
   */
  async deleteQueue(queue, options) {
    try {
      await this.channel.deleteQueue(queue, options);
      this.#queues.delete(queue);
      this.#consumers.delete(queue);
    } catch (err) {
      console.error(`${__filename}/deleteQueue error:`, err?.message);
    }
  }

  /**
   * Checking the existence of an exchange and creating it if it does not exist.
   * @param {string} exchange - Exchange name.
   * @param {string} type - Exchange type (e.g., 'direct', 'fanout', 'topic').
   * @param {object} [options] - Additional options for creating the exchange.
   */
  async assertExchange(exchangeConfig) {
    try {
      const { name: exchange, type, options } = exchangeConfig;
      await this.channel.assertExchange(exchange, type, options);
      this.#exchanges.set(exchange, exchangeConfig);
    } catch (err) {
      console.error(`${__filename}/assertExchange error:`, err?.message);
    }
  }

  /**
   * Consuming messages from a queue with the ability to specify parameters.
   * @param {object|string} queueConfig - Queue configuration or just the queue name
   * (if specified as a string).
   * @param {function} callback - Message handler function.
   * @param {object} consumerOptions - additional configurations for consume setting up
   * @returns {object|undefined} - amqplib's `{ consumerTag }`, or undefined on error.
   */
  async consume(queueConfig, callback, consumerOptions) {
    try {
      const {
        name,
        durable = true,
        arguments: queueArguments,
        prefetch = 1,
      } = typeof queueConfig === 'string' ? { name: queueConfig } : queueConfig;

      this.channel.prefetch(prefetch);
      await this.channel.assertQueue(name, {
        durable,
        arguments: queueArguments,
      });
      const consumeResult = await this.channel.consume(name, callback, consumerOptions);
      this.#consumers.set(name, { queueConfig, callback, consumerOptions });
      return consumeResult;
    } catch (err) {
      console.error(`${__filename}/consume error:`, err?.message);
      return undefined;
    }
  }

  /**
   * Sending a message to a queue.
   * @param {string} queue - Queue name.
   * @param {object} message - Message object.
   * @param {object} [options] - Options for sending the message.
   */
  async sendToQueue(queue, message, options) {
    try {
      const messageBuffer = Buffer.from(JSON.stringify(message));
      return this.channel.sendToQueue(queue, messageBuffer, options);
    } catch (err) {
      console.error(`${__filename}/sendToQueue error:`, err?.message);
      return false;
    }
  }

  /**
   * Confirming message receipt.
   * @param {object} msg - Message object.
   */
  async ack(msg) {
    try {
      await this.channel.ack(msg);
    } catch (err) {
      console.error(`${__filename}/ack error:`, err?.message);
    }
  }

  /**
   * Negative message acknowledgment.
   * @param {object} msg - Message object.
   * @param {boolean} [requeue=true] - Requeue the message (default is true).
   */
  async nack(msg, requeue = true) {
    try {
      await this.channel.nack(msg, false, requeue);
    } catch (err) {
      console.error(`${__filename}/nack error:`, err?.message);
    }
  }

  /**
   * Getting the message object as JSON.
   * @param {object} message - Message object.
   * @returns {object|null} - Message object as JSON or null in case of error.
   */
  // eslint-disable-next-line class-methods-use-this
  getMsgObj(message) {
    try {
      return JSON.parse(message.content.toString());
    } catch (err) {
      console.error(`${__filename}/getMsgObj error:`, err?.message);
      return null;
    }
  }

  /**
   * @method closeConnection
   * @desc Closes the channel and connection if they exist, and clears any tracked
   * exchanges/queues/bindings/consumers so they are not replayed by a reconnect.
   * @return {Promise<void>}
   */
  async closeConnection() {
    this.#closingIntentionally = true;
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
      this.#exchanges.clear();
      this.#queues.clear();
      this.#bindings.clear();
      this.#consumers.clear();
    } catch (err) {
      console.error(`${__filename}/closeConnection error:`, err?.message);
    } finally {
      this.#closingIntentionally = false;
    }
  }
}

module.exports = RabbitMQ;
