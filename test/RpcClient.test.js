const { EventEmitter } = require('events');
const RpcClient = require('../src/RpcClient');
const CommandResult = require('../src/CommandResult');
const Command = require('../src/Command');

function createFakeRabbitmq() {
  const rabbitmq = new EventEmitter();
  rabbitmq.channel = {
    assertQueue: jest.fn().mockResolvedValue({ queue: 'amq.gen-reply-1' }),
    consume: jest.fn(),
    sendToQueue: jest.fn(),
  };
  return rabbitmq;
}

describe('RpcClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('throws without a RabbitMQ instance', () => {
    expect(() => new RpcClient(null, 'queue')).toThrow(/connected RabbitMQ instance/);
  });

  it('throws without a queue name', () => {
    expect(() => new RpcClient(createFakeRabbitmq(), '')).toThrow(/request queue name/);
  });

  it('registers a reconnect listener on construction', () => {
    const rabbitmq = createFakeRabbitmq();

    // eslint-disable-next-line no-new
    new RpcClient(rabbitmq, 'rpc.queue');

    expect(rabbitmq.listenerCount('reconnect')).toBe(1);
  });

  it('rejects sendCommand() before init() has been called', async () => {
    const client = new RpcClient(createFakeRabbitmq(), 'rpc.queue');

    await expect(client.sendCommand('ping')).rejects.toThrow(/not initialized/);
  });

  describe('init()', () => {
    it('creates an exclusive reply queue and starts consuming it', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = new RpcClient(rabbitmq, 'rpc.queue');

      await client.init();

      expect(rabbitmq.channel.assertQueue).toHaveBeenCalledWith('', { exclusive: true });
      expect(client.replyQueue).toBe('amq.gen-reply-1');
      expect(rabbitmq.channel.consume).toHaveBeenCalledWith(
        'amq.gen-reply-1',
        expect.any(Function),
        { noAck: true },
      );
    });
  });

  describe('sendCommand()', () => {
    async function initClient(rabbitmq, timeout) {
      const client = new RpcClient(rabbitmq, 'rpc.queue', timeout);
      await client.init();
      return client;
    }

    it('sends a packed Command to the request queue with correlation metadata', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = await initClient(rabbitmq, 5000);

      client.sendCommand('getMovie', ['Endgame'], { persistent: true });

      expect(rabbitmq.channel.sendToQueue).toHaveBeenCalledTimes(1);
      const [queue, buffer, properties] = rabbitmq.channel.sendToQueue.mock.calls[0];
      expect(queue).toBe('rpc.queue');
      expect(Command.fromBuffer(buffer)).toEqual(new Command('getMovie', ['Endgame']));
      expect(properties).toEqual({
        persistent: true,
        correlationId: '1',
        replyTo: 'amq.gen-reply-1',
        expiration: '5000',
      });
    });

    it('resolves with the data from a successful reply', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = await initClient(rabbitmq, 5000);
      const replyHandler = rabbitmq.channel.consume.mock.calls[0][1];

      const promise = client.sendCommand('getMovie', ['Endgame']);
      const { correlationId } = rabbitmq.channel.sendToQueue.mock.calls[0][2];

      replyHandler({
        properties: { correlationId },
        content: new CommandResult(CommandResult.STATES.SUCCESS, { title: 'Endgame' }).pack(),
      });

      await expect(promise).resolves.toEqual({ title: 'Endgame' });
    });

    it('rejects with the error data from a failed reply', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = await initClient(rabbitmq, 5000);
      const replyHandler = rabbitmq.channel.consume.mock.calls[0][1];

      const promise = client.sendCommand('boom');
      const { correlationId } = rabbitmq.channel.sendToQueue.mock.calls[0][2];

      replyHandler({
        properties: { correlationId },
        content: new CommandResult(CommandResult.STATES.ERROR, new Error('kaboom')).pack(),
      });

      await expect(promise).rejects.toThrow('kaboom');
    });

    it('ignores replies for unknown/expired correlation ids', async () => {
      const rabbitmq = createFakeRabbitmq();
      await initClient(rabbitmq, 5000);
      const replyHandler = rabbitmq.channel.consume.mock.calls[0][1];

      expect(() => replyHandler({
        properties: { correlationId: 'unknown' },
        content: new CommandResult(CommandResult.STATES.SUCCESS, null).pack(),
      })).not.toThrow();
      expect(() => replyHandler(null)).not.toThrow();
    });

    it('rejects when no reply arrives before the timeout', async () => {
      jest.useFakeTimers();
      const rabbitmq = createFakeRabbitmq();
      const client = await initClient(rabbitmq, 1000);

      const promise = client.sendCommand('getMovie', ['Endgame']);
      const assertion = expect(promise).rejects.toThrow(/timed out after 1000ms/);

      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it('increments the correlation id for each call', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = await initClient(rabbitmq, 5000);

      client.sendCommand('a');
      client.sendCommand('b');

      const ids = rabbitmq.channel.sendToQueue.mock.calls.map((call) => call[2].correlationId);
      expect(ids).toEqual(['1', '2']);
    });
  });

  describe('reconnect handling', () => {
    it('recreates the reply queue and consumer when the RabbitMQ instance reconnects', async () => {
      const rabbitmq = createFakeRabbitmq();
      const client = new RpcClient(rabbitmq, 'rpc.queue');
      await client.init();

      rabbitmq.channel.assertQueue.mockResolvedValueOnce({ queue: 'amq.gen-reply-2' });

      rabbitmq.emit('reconnect');
      await Promise.resolve();
      await Promise.resolve();

      expect(rabbitmq.channel.assertQueue).toHaveBeenCalledTimes(2);
      expect(client.replyQueue).toBe('amq.gen-reply-2');
    });

    it('logs instead of throwing if recreating the reply queue fails', async () => {
      const rabbitmq = createFakeRabbitmq();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const client = new RpcClient(rabbitmq, 'rpc.queue');
      await client.init();

      rabbitmq.channel.assertQueue.mockRejectedValueOnce(new Error('down'));

      rabbitmq.emit('reconnect');
      await Promise.resolve();
      await Promise.resolve();

      expect(console.error).toHaveBeenCalledWith('RpcClient reconnect error:', 'down');
    });
  });

  describe('close()', () => {
    it('removes the reconnect listener', () => {
      const rabbitmq = createFakeRabbitmq();
      const client = new RpcClient(rabbitmq, 'rpc.queue');

      expect(rabbitmq.listenerCount('reconnect')).toBe(1);

      client.close();

      expect(rabbitmq.listenerCount('reconnect')).toBe(0);
    });
  });
});
