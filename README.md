# A wrapper for working with RabbitMQ using the amqplib npm package

>#### Content
>[Connection configs](#connection-configs)   
[Setup configs](#setup-configs)     
[Create connection](#create-connection)  
[Using (server)](#using-server)
<br>[Using (worker)](#using-worker)

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
