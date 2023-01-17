import * as net from 'net'
import { canonicalize } from 'json-canonicalize'
import * as types from './types'
import { ZodError } from 'zod'
import 'is-valid-domain'
import isValidDomain from 'is-valid-domain'

const MAX_MESSAGE_LENGTH = 102400
const PORT = 18018
const DESIRED_CONNECTIONS = 5

// const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<net.Socket> = new Set()

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

const sendMessage = async (socket: net.Socket, message: types.Message) => {
    let json: string = canonicalize(message)
    console.log(`Sending message ${json} to ${socket.remoteAddress}`)
    socket.write(json + '\n')
}

const disconnect = async (socket: net.Socket) => {
    console.log(`Destroying socket to ${socket.remoteAddress}`)
    socket.destroy()
    sockets.delete(socket)
}

const sendError = async (socket: net.Socket, name: types.ErrorCode, message: string) => {
    sendMessage(socket, {
        type: 'error',
        name: name,
        message: message
    })
    disconnect(socket)
}

const connectToPeer = async (peer: string) => {
    console.log(`Attemting to connect to ${peer}`)
    let socket: net.Socket = new net.Socket()
    socket.on('error', (err) => {
        console.log(`Transmission error with ${peer}: ${err}`)
    })
    socket.connect(getHostPort(peer), () => handleConnection(socket))
}

const handleConnection = async (socket: net.Socket) => {
    console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`)

    sockets.add(socket)

    let saidHello: boolean = false

    sendMessage(socket, {
        type: 'hello',
        version: '0.9.0',
        agent: 'Undertaker v0.0.1-alpha (https://github.com/arjvik/undertaker)'
    })
    sendMessage(socket, {
        type: 'getpeers'
    })

    let buffer: string = ''

    socket.on('data', async (chunk) => {
        console.log(`Received data ${chunk} from ${socket.remoteAddress}`)
        try {
            buffer += chunk.toString(undefined, 0, MAX_MESSAGE_LENGTH)
            buffer = buffer.substring(0, MAX_MESSAGE_LENGTH)
            let eom = buffer.indexOf('\n')
            while (eom != -1) {
                const message: types.Message = types.Message.parse(JSON.parse(buffer.substring(0, eom)))
                if (!saidHello && message.type != 'hello') {
                    sendError(socket, 'INVALID_HANDSHAKE', 'The peer sent other validly formatted messages before sending a valid hello message.')
                }
                switch (message.type) {
                    case 'hello':
                        console.log(`Hello from ${message.agent} running protocol v${message.version}`)
                        if (!/^0.9.[0-9]+$/.test(message.version)) {
                            sendError(socket, 'INVALID_HANDSHAKE', 'Peer protocol version ${message.version} unrecognized')
                        }
                        saidHello = true
                        break
                    case 'peers':
                        for (const peer of message.peers) {
                            const host = getHostPort(peer).host
                            if (net.isIP(host) || isValidDomain(host)) {
                                peers.add(peer)
                                if (sockets.size < DESIRED_CONNECTIONS) {
                                    connectToPeer(peer)
                                }
                            }
                        }
                        break
                    case 'getpeers':
                        sendMessage(socket, {
                            type: 'peers',
                            peers: Array.from(peers)
                        })
                        break
                }

                buffer = buffer.substring(eom + 1)
                eom = buffer.indexOf('\n')
            }
        } catch (err: any) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
                sendError(socket, 'INVALID_FORMAT', 'The format of the received message is invalid.')
            }
            sendError(socket, 'INTERNAL_ERROR', `Something unexpected happened: ${'name' in err ? err.name : 'error'}`)
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