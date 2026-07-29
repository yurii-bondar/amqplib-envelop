const Command = require('./Command');
const CommandResult = require('./CommandResult');

/**
 * @class RpcServer
 * @desc Listens on a request queue, dispatches incoming {@link Command}s to registered
 * handlers, and replies with a {@link CommandResult} on the queue named in the request.
 * Built on top of an already-connected {@link RabbitMQ} instance.
 */
class RpcServer {
  /**
   * @param {RabbitMQ} rabbitmq - A connected RabbitMQ instance (see `initAndGetInstance`).
   * @param {string} queue - Name of the queue to receive command requests on.
   */
  constructor(rabbitmq, queue) {
    if (!rabbitmq) {
      throw new Error('RpcServer requires a connected RabbitMQ instance');
    }
    if (!queue) {
      throw new Error('RpcServer requires a request queue name');
    }

    this.rabbitmq = rabbitmq;
    this.queue = queue;
    this.commands = new Map();
    this.consumerTag = null;

    this.addCommand('ping', () => 'pong');
  }

  /**
   * Registers a handler for a command name.
   * @param {string} command - Command name.
   * @param {function(...*): *} handler - Handler, may be async, receives the command args.
   * @returns {RpcServer}
   */
  addCommand(command, handler) {
    this.commands.set(command, handler);
    return this;
  }

  /**
   * Starts consuming command requests from the request queue.
   * @param {object} [consumerOptions] - Additional consume() options.
   */
  async start(consumerOptions = {}) {
    const result = await this.rabbitmq.consume(
      this.queue,
      (msg) => this.#handleMessage(msg),
      { noAck: false, ...consumerOptions },
    );
    this.consumerTag = result?.consumerTag ?? null;
  }

  async #handleMessage(msg) {
    if (!msg) return;

    const { replyTo, correlationId } = msg.properties;

    try {
      const command = Command.fromBuffer(msg.content);
      const handler = this.commands.get(command.command);

      if (!handler) {
        throw new Error(`Unknown command "${command.command}"`);
      }

      const data = await handler(...command.args);
      const result = new CommandResult(CommandResult.STATES.SUCCESS, data);

      if (replyTo) {
        this.rabbitmq.channel.sendToQueue(replyTo, result.pack(), { correlationId });
      }
    } catch (err) {
      const result = new CommandResult(CommandResult.STATES.ERROR, err);

      if (replyTo) {
        this.rabbitmq.channel.sendToQueue(replyTo, result.pack(), { correlationId });
      }
    } finally {
      await this.rabbitmq.ack(msg);
    }
  }

  /**
   * Stops consuming command requests.
   */
  async stop() {
    if (this.consumerTag && this.rabbitmq.channel) {
      await this.rabbitmq.channel.cancel(this.consumerTag);
    }
    this.consumerTag = null;
  }
}

module.exports = RpcServer;
