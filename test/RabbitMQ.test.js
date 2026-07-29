const { createFakeChannel, createFakeConnection } = require('./helpers/amqpMocks');

const CONFIG = {
  hostname: 'localhost',
  user: 'guest',
  password: 'guest',
  connectionName: 'test',
  reconnectDelay: 1000,
};

describe('RabbitMQ', () => {
  let RabbitMQ;
  let amqplib;
  let channel;
  let connection;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.doMock('amqplib', () => ({ connect: jest.fn() }));
    // eslint-disable-next-line global-require
    amqplib = require('amqplib');

    channel = createFakeChannel();
    connection = createFakeConnection();
    connection.createChannel.mockResolvedValue(channel);
    amqplib.connect.mockResolvedValue(connection);

    // eslint-disable-next-line global-require
    RabbitMQ = require('../src/RabbitMQ');
  });

  afterEach(() => {
    jest.dontMock('amqplib');
    jest.useRealTimers();
  });

  describe('getConnectionString / connectionQuery', () => {
    it('builds the amqp connection string from connection args', () => {
      const instance = new RabbitMQ({
        hostname: 'rabbit.local',
        port: 1234,
        user: 'u',
        password: 'p',
        vhost: 'my-vhost',
        connectionName: 'my-app',
      });

      const connectionString = instance.getConnectionString();

      expect(connectionString).toBe(
        'amqp://u:p@rabbit.local:1234/my-vhost?heartbeat=60&connection_timeout=30000'
        + `&client_properties=${encodeURIComponent('{"connection_name":"my-app"}')}`,
      );
    });

    it('defaults protocol, vhost and port', () => {
      const instance = new RabbitMQ({ hostname: 'h', user: 'u', password: 'p' });

      expect(instance.getConnectionString()).toContain('amqp://u:p@h:5672/?');
    });
  });

  describe('init()', () => {
    it('connects and creates a channel', async () => {
      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      expect(amqplib.connect).toHaveBeenCalledWith(instance.getConnectionString());
      expect(connection.createChannel).toHaveBeenCalledTimes(1);
      expect(instance.connection).toBe(connection);
      expect(instance.channel).toBe(channel);
    });

    it('logs and schedules a reconnect when the initial connect fails', async () => {
      jest.useFakeTimers();
      amqplib.connect.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce(connection);

      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      expect(instance.channel).toBeNull();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/init error:'), 'unreachable');

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);

      expect(amqplib.connect).toHaveBeenCalledTimes(2);
      expect(instance.channel).toBe(channel);
    });
  });

  describe('initAndGetInstance() / getActiveInstance()', () => {
    it('returns null before any instance has been created', () => {
      expect(RabbitMQ.getActiveInstance()).toBeNull();
    });

    it('shares a single connection attempt across concurrent calls', async () => {
      const [a, b] = await Promise.all([
        RabbitMQ.initAndGetInstance(CONFIG),
        RabbitMQ.initAndGetInstance(CONFIG),
      ]);

      expect(a).toBe(b);
      expect(amqplib.connect).toHaveBeenCalledTimes(1);
      expect(RabbitMQ.getActiveInstance()).toBe(a);
    });

    it('reuses the active instance on subsequent calls', async () => {
      const first = await RabbitMQ.initAndGetInstance(CONFIG);
      const second = await RabbitMQ.initAndGetInstance(CONFIG);

      expect(second).toBe(first);
      expect(amqplib.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('connection/channel error events', () => {
    it('logs connection-level errors without throwing', async () => {
      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      connection.emit('error', new Error('conn boom'));

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/connection error:'), 'conn boom');
    });

    it('logs channel-level errors without throwing', async () => {
      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      channel.emit('error', new Error('chan boom'));

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/channel error:'), 'chan boom');
    });
  });

  describe('registerGracefulShutdown()', () => {
    it('registers SIGINT/SIGTERM handlers that close the active connection and exit', async () => {
      const handlers = {};
      jest.spyOn(process, 'once').mockImplementation((event, cb) => {
        handlers[event] = cb;
        return process;
      });
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);

      RabbitMQ.registerGracefulShutdown();

      expect(process.once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(process.once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

      RabbitMQ.activeInstance = { closeConnection: jest.fn().mockResolvedValue(undefined) };
      await handlers.SIGINT();

      expect(RabbitMQ.activeInstance.closeConnection).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('logs and still exits if closing the connection during shutdown fails', async () => {
      const handlers = {};
      jest.spyOn(process, 'once').mockImplementation((event, cb) => {
        handlers[event] = cb;
        return process;
      });
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);

      RabbitMQ.registerGracefulShutdown();

      RabbitMQ.activeInstance = { closeConnection: jest.fn().mockRejectedValue(new Error('shutdown fail')) };
      await handlers.SIGTERM();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('/registerGracefulShutdown error:'),
        'shutdown fail',
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('only registers process listeners once', () => {
      jest.spyOn(process, 'once').mockImplementation(() => process);
      jest.spyOn(process, 'exit').mockImplementation(() => undefined);

      RabbitMQ.registerGracefulShutdown();
      process.once.mockClear();
      RabbitMQ.registerGracefulShutdown();

      expect(process.once).not.toHaveBeenCalled();
    });
  });

  describe('exchange/queue/binding operations', () => {
    let instance;

    beforeEach(async () => {
      instance = new RabbitMQ(CONFIG);
      await instance.init();
    });

    it('assertExchange() delegates to the channel', async () => {
      await instance.assertExchange({ name: 'films', type: 'topic', options: { durable: true } });

      expect(channel.assertExchange).toHaveBeenCalledWith('films', 'topic', { durable: true });
    });

    it('assertExchange() logs and swallows channel errors', async () => {
      channel.assertExchange.mockRejectedValueOnce(new Error('nope'));

      await expect(instance.assertExchange({ name: 'films', type: 'topic' })).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/assertExchange error:'), 'nope');
    });

    it('assertQueue() defaults durable to true', async () => {
      await instance.assertQueue({ name: 'marvel' });

      expect(channel.assertQueue).toHaveBeenCalledWith('marvel', { durable: true, arguments: undefined });
    });

    it('assertQueue() forwards durable and arguments', async () => {
      await instance.assertQueue({ name: 'marvel', durable: false, arguments: { 'x-foo': 1 } });

      expect(channel.assertQueue).toHaveBeenCalledWith('marvel', { durable: false, arguments: { 'x-foo': 1 } });
    });

    it('assertQueue() logs and swallows channel errors', async () => {
      channel.assertQueue.mockRejectedValueOnce(new Error('queue fail'));

      await expect(instance.assertQueue({ name: 'marvel' })).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/assertQueue error:'), 'queue fail');
    });

    it('deleteQueue() delegates to the channel', async () => {
      await instance.deleteQueue('marvel', { ifEmpty: true });

      expect(channel.deleteQueue).toHaveBeenCalledWith('marvel', { ifEmpty: true });
    });

    it('deleteQueue() logs and swallows channel errors', async () => {
      channel.deleteQueue.mockRejectedValueOnce(new Error('delete fail'));

      await expect(instance.deleteQueue('marvel')).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/deleteQueue error:'), 'delete fail');
    });

    it('bindQueue() delegates to the channel', async () => {
      await instance.bindQueue({ queue: 'marvel', source: 'films', pattern: 'marvel.*' });

      expect(channel.bindQueue).toHaveBeenCalledWith('marvel', 'films', 'marvel.*');
    });

    it('bindQueue() logs and swallows channel errors', async () => {
      channel.bindQueue.mockRejectedValueOnce(new Error('bind fail'));

      await expect(instance.bindQueue({ queue: 'marvel', source: 'films', pattern: '*' })).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/bindQueue error:'), 'bind fail');
    });

    it('unbindQueue() delegates to the channel', async () => {
      await instance.unbindQueue({ queue: 'marvel', source: 'films', pattern: 'marvel.*' });

      expect(channel.unbindQueue).toHaveBeenCalledWith('marvel', 'films', 'marvel.*');
    });

    it('unbindQueue() logs and swallows channel errors', async () => {
      channel.unbindQueue.mockRejectedValueOnce(new Error('unbind fail'));

      await expect(instance.unbindQueue({ queue: 'marvel', source: 'films', pattern: '*' })).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/unbindQueue error:'), 'unbind fail');
    });
  });

  describe('consume()', () => {
    let instance;

    beforeEach(async () => {
      instance = new RabbitMQ(CONFIG);
      await instance.init();
    });

    it('accepts a plain queue name and applies defaults', async () => {
      const cb = jest.fn();
      const result = await instance.consume('marvel', cb, { consumerTag: 'tag' });

      expect(channel.prefetch).toHaveBeenCalledWith(1);
      expect(channel.assertQueue).toHaveBeenCalledWith('marvel', { durable: true, arguments: undefined });
      expect(channel.consume).toHaveBeenCalledWith('marvel', cb, { consumerTag: 'tag' });
      expect(result).toEqual({ consumerTag: 'consumer-tag' });
    });

    it('accepts a queue config object with custom prefetch/durable/arguments', async () => {
      const cb = jest.fn();
      await instance.consume(
        {
          name: 'marvel', durable: false, arguments: { 'x-foo': 1 }, prefetch: 5,
        },
        cb,
      );

      expect(channel.prefetch).toHaveBeenCalledWith(5);
      expect(channel.assertQueue).toHaveBeenCalledWith('marvel', { durable: false, arguments: { 'x-foo': 1 } });
    });

    it('returns undefined and logs on error', async () => {
      channel.consume.mockRejectedValueOnce(new Error('broken'));

      const result = await instance.consume('marvel', jest.fn());

      expect(result).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/consume error:'), 'broken');
    });
  });

  describe('sendToQueue() / ack() / nack() / getMsgObj()', () => {
    let instance;

    beforeEach(async () => {
      instance = new RabbitMQ(CONFIG);
      await instance.init();
    });

    it('sendToQueue() JSON-encodes the message', async () => {
      const result = await instance.sendToQueue('marvel', { hello: 'world' }, { persistent: true });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'marvel',
        Buffer.from(JSON.stringify({ hello: 'world' })),
        { persistent: true },
      );
      expect(result).toBe(true);
    });

    it('sendToQueue() returns false and logs on error', async () => {
      channel.sendToQueue.mockImplementationOnce(() => { throw new Error('channel closed'); });

      const result = await instance.sendToQueue('marvel', { hello: 'world' });

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/sendToQueue error:'), 'channel closed');
    });

    it('ack() delegates to the channel', async () => {
      const msg = { fields: { deliveryTag: 1 } };
      await instance.ack(msg);

      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('nack() requeues by default', async () => {
      const msg = { fields: { deliveryTag: 1 } };
      await instance.nack(msg);

      expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    });

    it('nack() can be told not to requeue', async () => {
      const msg = { fields: { deliveryTag: 1 } };
      await instance.nack(msg, false);

      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });

    it('ack() logs and swallows channel errors', async () => {
      channel.ack.mockRejectedValueOnce(new Error('ack fail'));

      await expect(instance.ack({})).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/ack error:'), 'ack fail');
    });

    it('nack() logs and swallows channel errors', async () => {
      channel.nack.mockRejectedValueOnce(new Error('nack fail'));

      await expect(instance.nack({})).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/nack error:'), 'nack fail');
    });

    it('getMsgObj() parses the message content as JSON', () => {
      const msg = { content: Buffer.from(JSON.stringify({ a: 1 })) };

      expect(instance.getMsgObj(msg)).toEqual({ a: 1 });
    });

    it('getMsgObj() returns null and logs on invalid JSON', () => {
      const msg = { content: Buffer.from('not json') };

      expect(instance.getMsgObj(msg)).toBeNull();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/getMsgObj error:'), expect.any(String));
    });
  });

  describe('closeConnection()', () => {
    it('closes the channel and connection and clears them', async () => {
      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      await instance.closeConnection();

      expect(channel.close).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(instance.channel).toBeNull();
      expect(instance.connection).toBeNull();
    });

    it('is a no-op when nothing is connected', async () => {
      const instance = new RabbitMQ(CONFIG);

      await expect(instance.closeConnection()).resolves.toBeUndefined();
    });

    it('logs and does not throw when closing fails', async () => {
      const instance = new RabbitMQ(CONFIG);
      await instance.init();
      channel.close.mockRejectedValueOnce(new Error('close fail'));

      await expect(instance.closeConnection()).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/closeConnection error:'), 'close fail');
    });

    it('does not trigger a reconnect for the close events it causes itself', async () => {
      jest.useFakeTimers();
      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      await instance.closeConnection();
      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay * 2);

      expect(amqplib.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('automatic reconnect', () => {
    it('re-establishes the connection/channel and replays prior state after an unexpected channel close', async () => {
      jest.useFakeTimers();

      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      await instance.assertExchange({ name: 'films', type: 'topic' });
      await instance.assertQueue({ name: 'marvel', durable: true });
      await instance.bindQueue({ queue: 'marvel', source: 'films', pattern: 'marvel.a' });
      await instance.bindQueue({ queue: 'marvel', source: 'films', pattern: 'marvel.b' });
      await instance.unbindQueue({ queue: 'marvel', source: 'films', pattern: 'marvel.b' });

      const consumerCb = jest.fn();
      await instance.consume('marvel', consumerCb, { consumerTag: 'tag' });

      const reconnectListener = jest.fn();
      instance.on('reconnect', reconnectListener);

      const channel2 = createFakeChannel();
      const connection2 = createFakeConnection();
      connection2.createChannel.mockResolvedValue(channel2);
      amqplib.connect.mockResolvedValueOnce(connection2);

      channel.emit('close');

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);

      expect(instance.connection).toBe(connection2);
      expect(instance.channel).toBe(channel2);
      expect(reconnectListener).toHaveBeenCalledTimes(1);

      expect(channel2.assertExchange).toHaveBeenCalledWith('films', 'topic', undefined);
      expect(channel2.assertQueue).toHaveBeenCalledWith('marvel', { durable: true, arguments: undefined });
      expect(channel2.bindQueue).toHaveBeenCalledWith('marvel', 'films', 'marvel.a');
      expect(channel2.bindQueue).not.toHaveBeenCalledWith('marvel', 'films', 'marvel.b');
      expect(channel2.consume).toHaveBeenCalledWith('marvel', consumerCb, { consumerTag: 'tag' });
    });

    it('logs an additional error if cleaning up a failed reconnect attempt also fails', async () => {
      jest.useFakeTimers();

      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      const badConnection = createFakeConnection();
      badConnection.createChannel.mockRejectedValue(new Error('no channel'));
      badConnection.close.mockRejectedValueOnce(new Error('close failed'));
      amqplib.connect.mockResolvedValueOnce(badConnection).mockResolvedValueOnce(connection);

      channel.emit('close');
      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/reconnect error:'), 'no channel');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('/reconnect cleanup error:'),
        'close failed',
      );

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);
      expect(instance.channel).toBe(channel);
    });

    it('reschedules the reconnect attempt when it fails', async () => {
      jest.useFakeTimers();

      const instance = new RabbitMQ(CONFIG);
      await instance.init();

      amqplib.connect.mockRejectedValueOnce(new Error('still down')).mockResolvedValueOnce(connection);

      connection.emit('close');

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);
      expect(instance.channel).toBeNull();

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay);
      expect(instance.channel).toBe(channel);
      expect(amqplib.connect).toHaveBeenCalledTimes(3);
    });

    it('does not reconnect when disabled via the reconnect option', async () => {
      jest.useFakeTimers();

      const instance = new RabbitMQ({ ...CONFIG, reconnect: false });
      await instance.init();

      channel.emit('close');

      await jest.advanceTimersByTimeAsync(CONFIG.reconnectDelay * 2);

      expect(amqplib.connect).toHaveBeenCalledTimes(1);
      expect(instance.channel).toBe(channel);
    });
  });
});
