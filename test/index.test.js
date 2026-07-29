const RabbitMQ = require('../index');
const RabbitMQClass = require('../src/RabbitMQ');
const RpcClient = require('../src/RpcClient');
const RpcServer = require('../src/RpcServer');
const Command = require('../src/Command');
const CommandResult = require('../src/CommandResult');

describe('index.js', () => {
  it('exports the RabbitMQ class as the default export', () => {
    expect(RabbitMQ).toBe(RabbitMQClass);
  });

  it('attaches RpcClient, RpcServer, Command and CommandResult as static properties', () => {
    expect(RabbitMQ.RpcClient).toBe(RpcClient);
    expect(RabbitMQ.RpcServer).toBe(RpcServer);
    expect(RabbitMQ.Command).toBe(Command);
    expect(RabbitMQ.CommandResult).toBe(CommandResult);
  });
});
