const CommandResult = require('../src/CommandResult');

describe('CommandResult', () => {
  it('exposes SUCCESS/ERROR states', () => {
    expect(CommandResult.STATES).toEqual({ SUCCESS: 'success', ERROR: 'error' });
  });

  it('create() is a static factory equivalent to new', () => {
    const result = CommandResult.create(CommandResult.STATES.SUCCESS, 42);

    expect(result).toBeInstanceOf(CommandResult);
    expect(result.state).toBe('success');
    expect(result.data).toBe(42);
  });

  it('pack() then fromBuffer() round-trips a success result', () => {
    const result = new CommandResult(CommandResult.STATES.SUCCESS, { title: 'Endgame', year: 2019 });
    const restored = CommandResult.fromBuffer(result.pack());

    expect(restored.state).toBe(CommandResult.STATES.SUCCESS);
    expect(restored.data).toEqual({ title: 'Endgame', year: 2019 });
  });

  it('pack() then fromBuffer() round-trips an error result as an Error instance', () => {
    const original = new Error('boom');
    original.code = 'EBOOM';
    const result = new CommandResult(CommandResult.STATES.ERROR, original);
    const restored = CommandResult.fromBuffer(result.pack());

    expect(restored.state).toBe(CommandResult.STATES.ERROR);
    expect(restored.data).toBeInstanceOf(Error);
    expect(restored.data.message).toBe('boom');
    expect(restored.data.code).toBe('EBOOM');
    expect(restored.data.stack).toBe(original.stack);
  });

  it('pack() produces a Buffer', () => {
    const result = new CommandResult(CommandResult.STATES.SUCCESS, 'pong');

    expect(Buffer.isBuffer(result.pack())).toBe(true);
  });

  it('fromBuffer() throws when the state field is missing', () => {
    const buffer = Buffer.from(JSON.stringify({ data: 'pong' }));

    expect(() => CommandResult.fromBuffer(buffer)).toThrow(/state field/);
  });

  it('fromBuffer() throws when the state field is not success/error', () => {
    const buffer = Buffer.from(JSON.stringify({ state: 'pending', data: null }));

    expect(() => CommandResult.fromBuffer(buffer)).toThrow(/one of success, error/);
  });
});
