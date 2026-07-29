const RpcServer = require('../src/RpcServer');
const Command = require('../src/Command');
const CommandResult = require('../src/CommandResult');

function createFakeRabbitmq() {
  return {
    consume: jest.fn().mockResolvedValue({ consumerTag: 'consumer-tag' }),
    ack: jest.fn().mockResolvedValue(undefined),
    channel: {
      sendToQueue: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('RpcServer', () => {
  it('throws without a RabbitMQ instance', () => {
    expect(() => new RpcServer(null, 'queue')).toThrow(/connected RabbitMQ instance/);
  });

  it('throws without a queue name', () => {
    expect(() => new RpcServer(createFakeRabbitmq(), '')).toThrow(/request queue name/);
  });

  it('registers a default ping command that returns pong', () => {
    const server = new RpcServer(createFakeRabbitmq(), 'rpc.queue');

    expect(server.commands.get('ping')()).toBe('pong');
  });

  it('addCommand() registers a handler and is chainable', () => {
    const server = new RpcServer(createFakeRabbitmq(), 'rpc.queue');
    const handler = () => 'result';

    const returned = server.addCommand('doThing', handler);

    expect(returned).toBe(server);
    expect(server.commands.get('doThing')).toBe(handler);
  });

  describe('start()', () => {
    it('consumes the request queue with noAck: false by default', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');

      await server.start();

      expect(rabbitmq.consume).toHaveBeenCalledWith('rpc.queue', expect.any(Function), { noAck: false });
      expect(server.consumerTag).toBe('consumer-tag');
    });

    it('merges custom consumer options', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');

      await server.start({ consumerTag: 'custom-tag' });

      expect(rabbitmq.consume).toHaveBeenCalledWith(
        'rpc.queue',
        expect.any(Function),
        { noAck: false, consumerTag: 'custom-tag' },
      );
    });

    it('leaves consumerTag null when consume() fails to return one', async () => {
      const rabbitmq = createFakeRabbitmq();
      rabbitmq.consume.mockResolvedValueOnce(undefined);
      const server = new RpcServer(rabbitmq, 'rpc.queue');

      await server.start();

      expect(server.consumerTag).toBeNull();
    });
  });

  describe('message handling', () => {
    async function startAndGetHandler(rabbitmq, server) {
      await server.start();
      return rabbitmq.consume.mock.calls[0][1];
    }

    it('replies with a success CommandResult for a known command', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      server.addCommand('add', (a, b) => a + b);
      const handler = await startAndGetHandler(rabbitmq, server);

      const msg = {
        content: new Command('add', [2, 3]).pack(),
        properties: { replyTo: 'reply.queue', correlationId: 'corr-1' },
      };

      await handler(msg);

      expect(rabbitmq.channel.sendToQueue).toHaveBeenCalledTimes(1);
      const [replyTo, buffer, options] = rabbitmq.channel.sendToQueue.mock.calls[0];
      expect(replyTo).toBe('reply.queue');
      expect(options).toEqual({ correlationId: 'corr-1' });
      const result = CommandResult.fromBuffer(buffer);
      expect(result.state).toBe(CommandResult.STATES.SUCCESS);
      expect(result.data).toBe(5);
      expect(rabbitmq.ack).toHaveBeenCalledWith(msg);
    });

    it('awaits async command handlers', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      server.addCommand('getMovie', async (title) => ({ title, year: 2019 }));
      const handler = await startAndGetHandler(rabbitmq, server);

      const msg = {
        content: new Command('getMovie', ['Endgame']).pack(),
        properties: { replyTo: 'reply.queue', correlationId: 'corr-2' },
      };

      await handler(msg);

      const result = CommandResult.fromBuffer(rabbitmq.channel.sendToQueue.mock.calls[0][1]);
      expect(result.data).toEqual({ title: 'Endgame', year: 2019 });
    });

    it('replies with an error CommandResult for an unknown command', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      const handler = await startAndGetHandler(rabbitmq, server);

      const msg = {
        content: new Command('unknown', []).pack(),
        properties: { replyTo: 'reply.queue', correlationId: 'corr-3' },
      };

      await handler(msg);

      const result = CommandResult.fromBuffer(rabbitmq.channel.sendToQueue.mock.calls[0][1]);
      expect(result.state).toBe(CommandResult.STATES.ERROR);
      expect(result.data.message).toMatch(/Unknown command "unknown"/);
      expect(rabbitmq.ack).toHaveBeenCalledWith(msg);
    });

    it('replies with an error CommandResult when a handler throws', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      server.addCommand('boom', () => { throw new Error('kaboom'); });
      const handler = await startAndGetHandler(rabbitmq, server);

      const msg = {
        content: new Command('boom', []).pack(),
        properties: { replyTo: 'reply.queue', correlationId: 'corr-4' },
      };

      await handler(msg);

      const result = CommandResult.fromBuffer(rabbitmq.channel.sendToQueue.mock.calls[0][1]);
      expect(result.state).toBe(CommandResult.STATES.ERROR);
      expect(result.data.message).toBe('kaboom');
    });

    it('does not reply when the message has no replyTo, but still acks', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      const handler = await startAndGetHandler(rabbitmq, server);

      const msg = {
        content: new Command('ping', []).pack(),
        properties: { correlationId: 'corr-5' },
      };

      await handler(msg);

      expect(rabbitmq.channel.sendToQueue).not.toHaveBeenCalled();
      expect(rabbitmq.ack).toHaveBeenCalledWith(msg);
    });

    it('ignores a falsy message (e.g. consumer cancellation notification)', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      const handler = await startAndGetHandler(rabbitmq, server);

      await handler(null);

      expect(rabbitmq.channel.sendToQueue).not.toHaveBeenCalled();
      expect(rabbitmq.ack).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('cancels the active consumer', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');
      await server.start();

      await server.stop();

      expect(rabbitmq.channel.cancel).toHaveBeenCalledWith('consumer-tag');
      expect(server.consumerTag).toBeNull();
    });

    it('is a no-op when there is no active consumer', async () => {
      const rabbitmq = createFakeRabbitmq();
      const server = new RpcServer(rabbitmq, 'rpc.queue');

      await expect(server.stop()).resolves.toBeUndefined();
      expect(rabbitmq.channel.cancel).not.toHaveBeenCalled();
    });
  });
});
