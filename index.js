const RabbitMQ = require('./src/RabbitMQ');
const RpcClient = require('./src/RpcClient');
const RpcServer = require('./src/RpcServer');
const Command = require('./src/Command');
const CommandResult = require('./src/CommandResult');

RabbitMQ.RpcClient = RpcClient;
RabbitMQ.RpcServer = RpcServer;
RabbitMQ.Command = Command;
RabbitMQ.CommandResult = CommandResult;

module.exports = RabbitMQ;
