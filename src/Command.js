const assert = require('assert');

/**
 * @class Command
 * @desc Wraps an RPC command name and its arguments for sending across a request queue.
 * Used together with {@link RpcClient} and {@link RpcServer}.
 */
class Command {
  /**
   * @param {String} command - RPC command name.
   * @param {Array<*>} args - Arguments to pass to the RPC handler.
   * @example
   * const command = new Command('commandName', [{ foo: 'bar' }, [1, 2, 3]]);
   */
  constructor(command, args = []) {
    this.command = command;
    this.args = args;
  }

  /**
   * Static helper for creating new instances of a Command.
   * @static
   * @returns {Command}
   */
  static create(...args) {
    return new this(...args);
  }

  /**
   * Deserializes a Command previously packed with {@link Command#pack}.
   * @static
   * @param {Buffer} buffer
   * @returns {Command}
   */
  static fromBuffer(buffer) {
    const obj = JSON.parse(buffer.toString('utf-8'));

    assert(obj.command, 'Expect command field to be present and not false in serialized command');
    assert(typeof obj.command === 'string', 'Expect command field to be string');
    assert(obj.args, 'Expect args field to be present and not false in serialized command');
    assert(obj.args instanceof Array, 'Expect args field to be array');

    return new Command(obj.command, obj.args);
  }

  /**
   * Packs the command into a buffer for sending across a queue.
   * @returns {Buffer}
   */
  pack() {
    return Buffer.from(JSON.stringify({ command: this.command, args: this.args }));
  }
}

module.exports = Command;
