const { EventEmitter } = require('events');

function createFakeChannel() {
  const channel = new EventEmitter();
  channel.assertExchange = jest.fn().mockResolvedValue(undefined);
  channel.assertQueue = jest.fn().mockResolvedValue(undefined);
  channel.bindQueue = jest.fn().mockResolvedValue(undefined);
  channel.unbindQueue = jest.fn().mockResolvedValue(undefined);
  channel.consume = jest.fn().mockResolvedValue({ consumerTag: 'consumer-tag' });
  channel.prefetch = jest.fn();
  channel.sendToQueue = jest.fn().mockReturnValue(true);
  channel.ack = jest.fn().mockResolvedValue(undefined);
  channel.nack = jest.fn().mockResolvedValue(undefined);
  channel.deleteQueue = jest.fn().mockResolvedValue(undefined);
  channel.cancel = jest.fn().mockResolvedValue(undefined);
  channel.close = jest.fn().mockResolvedValue(undefined);
  return channel;
}

function createFakeConnection() {
  const connection = new EventEmitter();
  connection.createChannel = jest.fn();
  connection.close = jest.fn().mockResolvedValue(undefined);
  return connection;
}

module.exports = { createFakeChannel, createFakeConnection };
