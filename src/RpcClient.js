const Command = require('./Command');
const CommandResult = require('./CommandResult');

const DEFAULT_TIMEOUT = 4000;

/**
 * @class RpcClient
 * @desc Sends {@link Command} requests to an RPC queue and resolves with the data from
 * the matching {@link CommandResult} produced by an {@link RpcServer}. Built on top of an
 * already-connected {@link RabbitMQ} instance.
 */
class RpcClient {
  /**
   * @param {RabbitMQ} rabbitmq - A connected RabbitMQ instance (see `initAndGetInstance`).
   * @param {string} queue - Name of the request queue the RpcServer is listening on.
   * @param {number} [timeout=4000] - Time (ms) to wait for a reply before rejecting.
   */
  constructor(rabbitmq, queue, timeout = DEFAULT_TIMEOUT) {
    if (!rabbitmq) {
      throw new Error('RpcClient requires a connected RabbitMQ instance');
    }
    if (!queue) {
      throw new Error('RpcClient requires a request queue name');
    }

    this.rabbitmq = rabbitmq;
    this.queue = queue;
    this.timeout = timeout;
    this.cmdNumber = 0;
    this.requests = new Map();
    this.replyQueue = null;

    this.#onReconnect = () => this.#createReplyQueue()
      .catch((err) => console.error('RpcClient reconnect error:', err?.message));
    this.rabbitmq.on('reconnect', this.#onReconnect);
  }

  #onReconnect;

  /**
   * Creates an exclusive reply queue and starts listening for replies.
   * Must be called (and awaited) before {@link sendCommand}. Automatically re-run
   * whenever the underlying RabbitMQ instance reconnects, since an exclusive queue
   * does not survive a dropped connection.
   * @returns {Promise<RpcClient>}
   */
  async init() {
    await this.#createReplyQueue();
    return this;
  }

  async #createReplyQueue() {
    const { queue } = await this.rabbitmq.channel.assertQueue('', { exclusive: true });
    this.replyQueue = queue;
    await this.rabbitmq.channel.consume(
      this.replyQueue,
      (msg) => this.#dispatchReply(msg),
      { noAck: true },
    );
  }

  /**
   * Stops listening for replies and removes the reconnect listener.
   */
  close() {
    this.rabbitmq.off('reconnect', this.#onReconnect);
  }

  #dispatchReply(msg) {
    if (!msg) return;

    const { correlationId } = msg.properties;
    const context = this.requests.get(correlationId);
    if (!context) return;

    this.requests.delete(correlationId);
    clearTimeout(context.timer);

    try {
      const result = CommandResult.fromBuffer(msg.content);
      if (result.state === CommandResult.STATES.ERROR) {
        context.reject(result.data);
      } else {
        context.resolve(result.data);
      }
    } catch (err) {
      context.reject(err);
    }
  }

  /**
   * Sends a command to the RPC server and resolves with its result, or rejects on
   * error / timeout.
   * @param {string} command - Command name.
   * @param {Array<*>} [args] - Arguments to pass to the RpcServer handler.
   * @param {object} [messageOptions] - Additional sendToQueue() options.
   * @returns {Promise<*>}
   */
  sendCommand(command, args = [], messageOptions = {}) {
    if (!this.replyQueue) {
      return Promise.reject(new Error('RpcClient is not initialized, call init() first'));
    }

    const cmd = new Command(command, args);
    const correlationId = String((this.cmdNumber += 1));
    const properties = {
      ...messageOptions,
      correlationId,
      replyTo: this.replyQueue,
      expiration: String(this.timeout),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(correlationId);
        reject(new Error(`RPC command "${command}" timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.requests.set(correlationId, { resolve, reject, timer });
      this.rabbitmq.channel.sendToQueue(this.queue, cmd.pack(), properties);
    });
  }
}

module.exports = RpcClient;
