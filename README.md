# A wrapper for working with RabbitMQ using the amqplib npm package

>#### Content
>[Connection configs](#connection-configs)   
[Setup configs](#setup-configs)     
[Create connection](#create-connection)  
[Using (server)](#using-server)
<br>[Using (worker)](#using-worker)
<br>[Automatic reconnect](#automatic-reconnect)
<br>[Graceful shutdown](#graceful-shutdown)
<br>[RPC (request/response over a queue)](#rpc)
<br>[Tests](#tests)

<a name="connection-configs"><h2>Connection configs</h2></a>
```js
// config/default.js

const pkg = require('../package.json');

module.exports = {
    rabbitmq: {
        protocol: 'amqp:',
        hostname: '127.0.0.1',
        port: 5672,
        user: 'guest',
        password: 'guest',
        connectionName: `${pkg.name}-${pkg.version}`,
        vhost: '',
        // optional, both default to the values shown below:
        reconnect: true,
        reconnectDelay: 5000, // ms between reconnect attempts
    }
};
```

<a name="setup-configs"><h2>Setup configs</h2></a>
```js
// constants/rabbitmq.js

const EXCHANGE_NAME = 'films';
const QUEUE_NAME = 'marvel';

module.exports = {
    exchanges: {
        films: {
            name: EXCHANGE_NAME,
            type: 'topic',
            options: {
                durable: true,
            },
        },
    },
    queues: {
        marvel: {
            name: QUEUE_NAME,
            durable: true,
            arguments: {
                'x-dead-letter-exchange': EXCHANGE_NAME,
                'x-dead-letter-routing-key': `${QUEUE_NAME}.dlx`,
                'x-queue-type': 'quorum',
                'x-delivery-limit': 2,
            },
        },
        marvelDlx: {
            name: `${QUEUE_NAME}.dlx`,
            durable: true,
            arguments: {
                'x-dead-letter-exchange': EXCHANGE_NAME,
                'x-dead-letter-routing-key': QUEUE_NAME,
                'x-message-ttl': 5000,
            },
        },
    },
    bindings: {
        marvel: {
            queue: QUEUE_NAME,
            source: EXCHANGE_NAME,
            pattern: QUEUE_NAME,
        },
        smarvelDlx: {
            queue: `${QUEUE_NAME}.dlx`,
            source: EXCHANGE_NAME,
            pattern: `${QUEUE_NAME}.dlx`,
        },
    },
};

```

<a name="create-connection"><h2>Create connection</h2></a>
```js
// helpers/rabbitmq,js

const RabbitMQ = require('amqplib-envelop');
const config = require('config');

module.exports = async () => RabbitMQ.initAndGetInstance(config.rabbitmq);

```

<a name="using-server"><h2>Using (server)</h2></a>
```js
// server/index.js

const rabbitMqInstance = require('./helpers/rabbitmq');

const { exchanges, queues, bindings } = require('./constants/rabbitmq');

// chain of promises
async function sendToMarvelQueue(msg) {
    const rabbitmq = await rabbitMqInstance();
    return rabbitmq.assertExchange(exchanges.films)
        .then(() => rabbitmq.assertQueue(queues.marvel))
        .then(() => rabbitmq.bindQueue(bindings.marvel))
        .then(() => rabbitmq.sendToQueue(queues.marvel.name, msg, { persistent: true }))
        .catch((err) => {
            console.error('sendToMarvelQueue error: ', err);
            throw new Exception(500, err?.message);
        });
}

// async/await
async function sendToMarvelQueue(msg) {
    try {
        const rabbitmq = await rabbitMqInstance();
        await rabbitmq.assertExchange(exchanges.films);
        await rabbitmq.assertQueue(queues.marvel);
        await rabbitmq.bindQueue(bindings.marvel);
        await rabbitmq.sendToQueue(queues.marvel.name, msg, { persistent: true });
    } catch (err) {
        console.error('sendToMarvelQueue error: ', err);
        throw new Exception(500, err?.message);
    }
}

```

<a name="using-worker"><h2>Using (worker)</h2></a>
```js
// worker/index.js

const RabbitMQ = require('amqplib-envelop');
const rabbitmq = require('./helpers/rabbitmq');

const marvelWorker = require('./marvelWorker');

module.exports = {
    start: async () => {
        const rabbitInstance = await rabbitmq();

        await marvelWorker(rabbitInstance);
    },
    stop: async () => {
        const rabbitInstance = await RabbitMQ.getActiveInstance();
        await rabbitInstance.closeConnection();
        process.exit(0);
    },
};

// worker/marvelWorker.js

const { exchanges, queues, bindings } = require('./constants/rabbitmq');

const consumer = (rabbitmq) => async (msg) => {
    const msgObj = rabbitmq.getMsgObj(msg);
    
    // some logic with message
    console.log('message from queue: ', msgObj);
    // some logic for nack
    rabbitmq.nack(msg);
    // some logic for ack
    rabbitmq.ack(msg);
};

module.exports = async (rabbitmq) => {
    await rabbitmq.assertExchange(exchanges.films);

    await Promise.all([
        rabbitmq.assertQueue(queues.marvel),
        rabbitmq.assertQueue(queues.marvelDlx),
    ]);

    await Promise.all([
        rabbitmq.bindQueue(bindings.marvel),
        rabbitmq.bindQueue(bindings.marvelDlx),
    ]);

    await rabbitmq.consume(queues.marvel, consumer(rabbitmq), {
        consumerTag: 'marvelApp:1.1.2'
    });
};
```

<a name="automatic-reconnect"><h2>Automatic reconnect</h2></a>
```js
// worker/marvelWorker.js

const { exchanges, queues, bindings } = require('./constants/rabbitmq');

const consumer = (rabbitmq) => async (msg) => {
    const msgObj = rabbitmq.getMsgObj(msg);

    console.log('message from queue: ', msgObj);
    rabbitmq.ack(msg);
};

module.exports = async (rabbitmq) => {
    // fired once the connection/channel are re-established after an unexpected drop,
    // and all exchanges/queues/bindings/consumers below have been re-applied
    rabbitmq.on('reconnect', () => console.log('RabbitMQ reconnected'));

    await rabbitmq.assertExchange(exchanges.films);

    await Promise.all([
        rabbitmq.assertQueue(queues.marvel),
        rabbitmq.assertQueue(queues.marvelDlx),
    ]);

    await rabbitmq.bindQueue(bindings.marvel);

    // undo a binding made earlier, so it isn't re-applied on the next reconnect either
    await rabbitmq.unbindQueue(bindings.marvelDlx);

    await rabbitmq.consume(queues.marvel, consumer(rabbitmq));
};
```
```js
// config/default.js

module.exports = {
    rabbitmq: {
        // ...
        reconnect: false, // set to disable auto-reconnect, default is true
        reconnectDelay: 10000, // ms between reconnect attempts, default is 5000
    }
};
```

<a name="graceful-shutdown"><h2>Graceful shutdown</h2></a>
```js
// worker/index.js

const RabbitMQ = require('amqplib-envelop');
const rabbitmq = require('./helpers/rabbitmq');

const marvelWorker = require('./marvelWorker');

// closes the active connection on SIGINT/SIGTERM and exits, replaces a manual stop()
RabbitMQ.registerGracefulShutdown();

module.exports = {
    start: async () => {
        const rabbitInstance = await rabbitmq();

        await marvelWorker(rabbitInstance);
    },
};
```

<a name="rpc"><h2>RPC (request/response over a queue)</h2></a>
```js
// rpc/marvelRpcServer.js

const RabbitMQ = require('amqplib-envelop');
const rabbitmq = require('../helpers/rabbitmq');

module.exports = async () => {
    const rabbitInstance = await rabbitmq();

    const rpcServer = new RabbitMQ.RpcServer(rabbitInstance, 'marvel.rpc');

    rpcServer.addCommand('getMovie', async (title) => ({ title, year: 2019 }));

    await rpcServer.start();

    return rpcServer;
};
```
```js
// rpc/marvelRpcClient.js

const RabbitMQ = require('amqplib-envelop');
const rabbitmq = require('../helpers/rabbitmq');

async function getMovie(title) {
    const rabbitInstance = await rabbitmq();

    const rpcClient = new RabbitMQ.RpcClient(rabbitInstance, 'marvel.rpc', 5000 /* timeout, ms */);
    await rpcClient.init();

    // rejects if the server responds with an error, or nothing replies within the timeout
    return rpcClient.sendCommand('getMovie', [title]);
}

module.exports = { getMovie };
```
```js
// worker/index.js

const rabbitmq = require('./helpers/rabbitmq');
const marvelRpcServer = require('./rpc/marvelRpcServer');

module.exports = {
    start: async () => {
        await rabbitmq();
        await marvelRpcServer();
    },
};

// server/movieController.js

const { getMovie } = require('./rpc/marvelRpcClient');

async function getMovieHandler(req, res) {
    const movie = await getMovie(req.params.title);
    res.json(movie);
}

// every RpcServer also registers a default 'ping' command out of the box:
// await rpcClient.sendCommand('ping'); // -> 'pong'
```

<a name="tests"><h2>Tests</h2></a>
```bash
npm test              # run the unit test suite (jest)
npm run test:coverage # same, with a coverage report
```
`amqplib` itself is mocked in the tests (`test/helpers/amqpMocks.js`), so no running RabbitMQ
server is required.

