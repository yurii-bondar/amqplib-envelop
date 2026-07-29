const Command = require('../src/Command');

describe('Command', () => {
  it('stores the command name and args', () => {
    const command = new Command('doThing', [1, 'two', { three: 3 }]);

    expect(command.command).toBe('doThing');
    expect(command.args).toEqual([1, 'two', { three: 3 }]);
  });

  it('defaults args to an empty array', () => {
    const command = new Command('ping');

    expect(command.args).toEqual([]);
  });

  it('create() is a static factory equivalent to new', () => {
    const command = Command.create('doThing', [1]);

    expect(command).toBeInstanceOf(Command);
    expect(command.command).toBe('doThing');
    expect(command.args).toEqual([1]);
  });

  it('pack() then fromBuffer() round-trips the command', () => {
    const command = new Command('getMovie', ['Endgame']);
    const restored = Command.fromBuffer(command.pack());

    expect(restored).toBeInstanceOf(Command);
    expect(restored.command).toBe('getMovie');
    expect(restored.args).toEqual(['Endgame']);
  });

  it('pack() produces a Buffer', () => {
    const command = new Command('ping');

    expect(Buffer.isBuffer(command.pack())).toBe(true);
    expect(JSON.parse(command.pack().toString())).toEqual({ command: 'ping', args: [] });
  });

  it('fromBuffer() throws when the command field is missing', () => {
    const buffer = Buffer.from(JSON.stringify({ args: [] }));

    expect(() => Command.fromBuffer(buffer)).toThrow(/command field/);
  });

  it('fromBuffer() throws when the command field is not a string', () => {
    const buffer = Buffer.from(JSON.stringify({ command: 123, args: [] }));

    expect(() => Command.fromBuffer(buffer)).toThrow(/command field to be string/);
  });

  it('fromBuffer() throws when the args field is missing', () => {
    const buffer = Buffer.from(JSON.stringify({ command: 'ping' }));

    expect(() => Command.fromBuffer(buffer)).toThrow(/args field/);
  });

  it('fromBuffer() throws when the args field is not an array', () => {
    const buffer = Buffer.from(JSON.stringify({ command: 'ping', args: 'nope' }));

    expect(() => Command.fromBuffer(buffer)).toThrow(/args field to be array/);
  });
});
