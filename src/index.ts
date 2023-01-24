import * as net from 'net'
import { canonicalize } from 'json-canonicalize'
import * as types from './types'
import { ZodError } from 'zod'
import 'is-valid-domain'
import isValidDomain from 'is-valid-domain'
import level from 'level-ts';

const MAX_MESSAGE_LENGTH = 102400
const PORT = 18018
const DESIRED_CONNECTIONS = 5
const SOCKET_TIMEOUT = 10_000

const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
// const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<net.Socket> = new Set()
const db = new level('./db');

const getHostPort = (str: string) => {
    let eoh = str.lastIndexOf(':')
    if (eoh < str.lastIndexOf(']')) {
        eoh = -1
    }
    return {
        host: eoh == -1 ? str : str.substring(0, eoh),
        port: eoh == -1 ? PORT : parseInt(str.substring(eoh + 1))
    }
}

const sendMessage = (socket: net.Socket, message: types.Message) => {
    let json: string = canonicalize(message)
    console.log(`Sending message ${json} to ${socket.remoteAddress}`)
    socket.write(json + '\n')
}

const disconnect = (socket: net.Socket) => {
    console.log(`Destroying socket to ${socket.remoteAddress}`)
    socket.destroy()
    sockets.delete(socket)
}

const sendError = (socket: net.Socket, name: types.ErrorCode, message: string) => {
    sendMessage(socket, {
        type: 'error',
        name: name,
        message: message
    })
    disconnect(socket)
}

const connectToPeer = (peer: string) => {
    console.log(`Attemting to connect to ${peer}`)
    let socket: net.Socket = new net.Socket()
    socket.on('error', (err) => {
        console.log(`Transmission error with ${peer}: ${err}`)
    })
    socket.connect(getHostPort(peer), () => handleConnection(socket))
}

const addTimeout = (socket: net.Socket) => {
    return setTimeout(async () => {
        console.log(`Peer ${socket.remoteAddress} timed out.`)
        sendError(socket, 'INVALID_FORMAT', 'Peer timed out.')
    }, SOCKET_TIMEOUT)
}

const generateObjectId = (object: types.Object) => {
    var blake2 = require('blake2');
    return blake2(32, null, null, canonicalize(object)).toString('hex');
}

const addObject = async (object: types.Object) => {
    const objectId = generateObjectId(object);
    const exists = await db.exists(objectId);
    if (!exists) {
        await db.put(objectId, object);
    }
}

const getObject = async (socket: net.Socket, objectId: string) => {
    const data = await db.get(objectId);
    sendMessage(socket, data);
}

const handleConnection = async (socket: net.Socket) => {
    console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`)

    sockets.add(socket)

    let saidHello: boolean = false
    let timeoutID: NodeJS.Timeout | undefined = undefined

    sendMessage(socket, {
        type: 'hello',
        version: '0.9.0',
        agent: 'Undertaker (GitHub: arjvik/undertaker, commit {{GIT-HASH}})'
    })
    sendMessage(socket, {
        type: 'getpeers'
    })

    let buffer: string = ''

    socket.on('data', async (chunk) => {
        // console.log(`Received data ${chunk} from ${socket.remoteAddress}`)
        try {
            buffer += chunk.toString(undefined, 0, MAX_MESSAGE_LENGTH)
            buffer = buffer.substring(0, MAX_MESSAGE_LENGTH)
            let eom = buffer.indexOf('\n')
            if (eom != -1) {
                clearTimeout(timeoutID)
            }
            while (eom != -1) {
                const json = buffer.substring(0, eom)
                console.log(`Received message ${json} from ${socket.remoteAddress}`)
                const message: types.Message = types.Message.parse(JSON.parse(json))
                if (!saidHello && message.type != 'hello') {
                    sendError(socket, 'INVALID_HANDSHAKE', 'The peer sent other validly formatted messages before sending a valid hello message.')
                }
                switch (message.type) {
                    case 'hello':
                        console.log(`Hello from ${message.agent} running protocol v${message.version}`)
                        saidHello = true
                        break
                    case 'peers':
                        console.log(`Received peers ${message.peers} from ${socket.remoteAddress}`)
                        for (const peer of message.peers) {
                            const host = getHostPort(peer).host
                            if (net.isIP(host) || isValidDomain(host)) {
                                if (!peers.has(peer)) {
                                    console.log(`Valid peer ${peer} from ${socket.remoteAddress}`)
                                    peers.add(peer)
                                    if (sockets.size < DESIRED_CONNECTIONS) {
                                        console.log(`Attempting to connect to peer #${sockets.size + 1} ${peer} advertised by ${socket.remoteAddress}`)
                                        connectToPeer(peer)
                                    }
                                }
                            } else {
                                console.log(`Invalid peer ${peer} from ${socket.remoteAddress}`)
                            }
                        }
                        break
                    case 'getpeers':
                        sendMessage(socket, {
                            type: 'peers',
                            peers: Array.from(peers)
                        })
                        break
                    case 'getobject':
                        console.log(`Received getobject ${message.objectid} from ${socket.remoteAddress}`);
                        await getObject(socket, message.objectid);
                        break
                    case 'object':
                        console.log(`Received object ${message.object} from ${socket.remoteAddress}`);
                        //TODO: Before calling this, we should validate message.object; idk if this is already handled though
                        await addObject(message.object);
                        //Implement gossipping protocol and broadcast this message to peers
                        for (const peer of peers) {
                            let peerSocket = new net.Socket();
                            peerSocket.connect(getHostPort(peer), () => {
                                sendMessage(peerSocket, message);
                            });
                        }
                        break;
                    case 'ihaveobject':
                        console.log(`Received ihaveobject ${message.objectid} from ${socket.remoteAddress}`);
                        const exists = await db.exists(message.objectid);
                        if (!exists) {
                            sendMessage(socket, {
                                type: 'getobject',
                                objectid: message.objectid
                            });
                        }
                }

                buffer = buffer.substring(eom + 1)
                eom = buffer.indexOf('\n')
            }
            if (buffer.length > 0) {
                timeoutID = addTimeout(socket)
            }
        } catch (err: any) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
                sendError(socket, 'INVALID_FORMAT', 'The format of the received message is invalid.')
            } else {
                console.log(`!!INTERNAL_ERROR!! ${err} --- ${err.stack}`)
                sendError(socket, 'INTERNAL_ERROR', `Something unexpected happened: ${'name' in err ? err.name : 'error'}`)
            }
        }
    })

    socket.on('end', () => {
        console.log(`Connection close from ${socket.remoteAddress}`)
        disconnect(socket)
    })

    socket.on('error', (err) => {
        console.log(`Transmission error from ${socket.remoteAddress}: ${err}`)
        disconnect(socket)
    })
}

const server = net.createServer(handleConnection)
server.on('error', (err) => {
    console.log(`!!SERVER ERROR!! ${err}`)
    // throw err
})

server.listen({ host: '0.0.0.0', port: PORT }, () => {
    console.log(`Serving on ${PORT}`)
})

for (const peer of peers) {
    connectToPeer(peer)
}