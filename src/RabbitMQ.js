const amqplib = require('amqplib');

/**
 * @class RabbitMQ
 * @desc Wrapper class for working with RabbitMQ.
 */
class RabbitMQ {
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
   * @static
   * @desc Active instance of RabbitMQ.
   * @type {RabbitMQ|null}
   */
  static activeInstance = null;

  constructor(connection) {
    this.connectionArgs = connection;
    this.connection = null;
    this.channel = null;
  }

  async init() {
    try {
      this.connection = await amqplib.connect(this.getConnectionString());
      this.channel = await this.connection.createChannel();
    } catch (err) {
      console.error(`${__filename}/init error:`, err?.message);
    }
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
   * @param {object} connection - Connection configuration.
   * @returns {RabbitMQ} - Active instance of RabbitMQ.
   */
  static async initAndGetInstance(connection) {
    if (!RabbitMQ.activeInstance) {
      RabbitMQ.activeInstance = new RabbitMQ(connection);
      await RabbitMQ.activeInstance.init();
    }
    return RabbitMQ.activeInstance;
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
    } catch (err) {
      console.error(`${__filename}/bindQueue error:`, err?.message);
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
  async assertExchange({ name: exchange, type, options }) {
    try {
      await this.channel.assertExchange(exchange, type, options);
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
      await this.channel.consume(name, callback, consumerOptions);
    } catch (err) {
      console.error(`${__filename}/consume error:`, err?.message);
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
   * @desc Closes the channel and connection if they exist
   * @return {Promise<void>}
   */
  async closeConnection() {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
    } catch (err) {
      console.error(`${__filename}/closeConnection error:`, err?.message);
    }
  }
}

module.exports = RabbitMQ;
