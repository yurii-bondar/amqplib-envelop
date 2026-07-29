const assert = require('assert');

/**
 * @class CommandResult
 * @desc Wraps the (de)serialized result of a {@link Command}, sent by {@link RpcServer}
 * back to {@link RpcClient} in response to a command request.
 */
class CommandResult {
  /**
   * @param {String} state - One of {@link CommandResult.STATES}.
   * @param {*} data - Any value understood by `JSON.stringify` (or an `Error`).
   * @example
   * const success = new CommandResult(CommandResult.STATES.SUCCESS, ['some', 'data']);
   * const failure = new CommandResult(CommandResult.STATES.ERROR, new Error('boom'));
   */
  constructor(state, data) {
    this.state = state;
    this.data = data;
  }

  /**
   * @static
   * @returns {{SUCCESS: String, ERROR: String}}
   */
  static get STATES() {
    return {
      ERROR: 'error',
      SUCCESS: 'success',
    };
  }

  /**
   * @private
   * @static
   * @desc `JSON.stringify` replacer that serializes `Error` instances.
   */
  static replacer(key, value) {
    if (value instanceof Error) {
      return {
        code: value.code,
        message: value.message,
        name: value.name,
        stack: value.stack,
      };
    }
    return value;
  }

  /**
   * Static helper for creating new instances of {@link CommandResult}.
   * @static
   * @returns {CommandResult}
   */
  static create(...args) {
    return new this(...args);
  }

  /**
   * Deserializes a CommandResult previously packed with {@link CommandResult#pack}.
   * @static
   * @param {Buffer} buffer
   * @returns {CommandResult}
   */
  static fromBuffer(buffer) {
    const obj = JSON.parse(buffer.toString('utf-8'));

    assert(obj.state, 'Expect state field to be present and not false in serialized command result');
    assert(
      obj.state === CommandResult.STATES.SUCCESS || obj.state === CommandResult.STATES.ERROR,
      `Expect state field to be one of ${CommandResult.STATES.SUCCESS}, ${CommandResult.STATES.ERROR}`,
    );

    if (obj.state === CommandResult.STATES.ERROR) {
      const error = new Error(obj.data?.message);
      error.stack = obj.data?.stack;
      error.code = obj.data?.code;
      error.name = obj.data?.name;
      obj.data = error;
    }

    return new CommandResult(obj.state, obj.data);
  }

  /**
   * Packs the result into a buffer for sending across a queue.
   * @returns {Buffer}
   */
  pack() {
    return Buffer.from(
      JSON.stringify({ state: this.state, data: this.data }, CommandResult.replacer),
    );
  }
}

module.exports = CommandResult;
