import isValidDomain from 'is-valid-domain'
import { canonicalize } from 'json-canonicalize'
import level from 'level-ts'
import * as net from 'net'
import { ZodError } from 'zod'
import * as types from './types'
import PromiseSocket from 'promise-socket'
import { createHash } from 'blake2'
import * as ed from '@noble/ed25519';


type Socket = PromiseSocket<net.Socket>

const MAX_MESSAGE_LENGTH = 102400
const PORT = 18018
const DESIRED_CONNECTIONS = 5
const HELLO_TIMEOUT = 30_000
const PARTIAL_MESSAGE_TIMEOUT = 10_000

const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
// const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<Socket> = new Set()
const db: level<types.Object> = new level('./database');

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

const sendMessage = async (socket: Socket, message: types.Message) => {
    let json: string = canonicalize(message)
    console.log(`Sending message ${json} to ${socket.stream.remoteAddress}`)
    return socket.write(json + '\n')
}

const disconnect = async (socket: Socket) => {
    console.log(`Destroying socket to ${socket.stream.remoteAddress}`)
    try {
        socket.destroy()
    } catch { }
    sockets.delete(socket)
}

const sendError = async (socket: Socket, name: types.ErrorCode, message: string) =>
    sendMessage(socket, {
        type: 'error',
        name: name,
        message: message
    })
        .then(() => disconnect(socket))

const connectToPeer = async (peer: string) => {
    console.log(`Attemting to connect to ${peer}`)
    let socket: Socket = new PromiseSocket(new net.Socket())

    socket.once('error').catch(async (err) => {
        console.log(`Transmission error with ${peer}, disconnecting: ${err}`)
    })

    socket.connect(getHostPort(peer))
        .then(async () => handleConnection(socket))
        .catch(() => console.log(`Failed to connect to ${peer}`));
}

const addTimeout = (socket: Socket, timeout: number = PARTIAL_MESSAGE_TIMEOUT) => {
    return setTimeout(async () => {
        console.log(`Peer ${socket.stream.remoteAddress} timed out.`)
        await sendError(socket, 'INVALID_FORMAT', 'Peer timed out.')
    }, timeout)
}

const hashObject = (object: types.Object) =>
    createHash('blake2s', { digestLength: 32 })
        .update(Buffer.from(canonicalize(object), 'ascii'))
        .digest('hex')

const validateStringSignature = async (signature: string, message: string, publicKey: string) => {
    const signatureBytes = Uint8Array.from(Buffer.from(signature, 'hex'))
    const messageBytes = Uint8Array.from(Buffer.from(message, 'utf8'))
    const publicKeyBytes = Uint8Array.from(Buffer.from(publicKey, 'hex'))
    return ed.verify(signatureBytes, messageBytes, publicKeyBytes)
}

const validateObject = async (socket: Socket, object: types.Object) => {
    switch (object.type) {
        case 'block':
            return true
        case 'transaction':
            if ('inputs' in object) {
                let signableObject: { type: "transaction", outputs: { value: number, pubkey: string, }[], inputs: { outpoint: { txid: string, index: number, }, sig: string | null, }[] }
                    = JSON.parse(JSON.stringify(object)) // deep copy hack
                for (const input of signableObject.inputs) {
                    input.sig = null
                }
                let signableText: string = canonicalize(signableObject)
                let totalInputValue: number = 0
                for (const input of object.inputs) {
                    if (!await db.exists(input.outpoint.txid)) {
                        await sendError(socket, 'UNKNOWN_OBJECT', `Transaction ${input.outpoint.txid} not found.`)
                        return false
                    }
                    const outpointOutput = await db.get(input.outpoint.txid)
                    if (outpointOutput.type != 'transaction') {
                        await sendError(socket, 'INVALID_TX_OUTPOINT', `Object ${input.outpoint.txid} is not a transaction.`)
                        return false
                    }
                    if (input.outpoint.index >= outpointOutput.outputs.length) {
                        await sendError(socket, 'INVALID_TX_OUTPOINT', `Transaction ${input.outpoint.txid} has no output #${input.outpoint.index}.`)
                        return false
                    }
                    const outpoint = outpointOutput.outputs[input.outpoint.index]
                    if (!await validateStringSignature(input.sig, signableText, outpoint.pubkey)) {
                        await sendError(socket, 'INVALID_TX_SIGNATURE', `Signature ${input.sig} is invalid.`)
                        return false
                    }
                    totalInputValue += outpoint.value
                }
                let totalOutputValue: number = 0
                for (const output of object.outputs) {
                    totalOutputValue += output.value
                }
                if (totalInputValue < totalOutputValue) {
                    await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction has more outputs than inputs`)
                    return false
                }
            }
            return true
    }
}

const handleConnection = async (socket: Socket) => {
    const remoteAddress = socket.stream.remoteAddress

    console.log(`Client #${sockets.size + 1} connected from ${remoteAddress}:${socket.stream.remotePort}`)

    sockets.add(socket)

    let saidHello: boolean = false
    let timeoutID: NodeJS.Timeout | undefined = addTimeout(socket, HELLO_TIMEOUT)

    await sendMessage(socket, {
        type: 'hello',
        version: '0.9.0',
        agent: 'Undertaker (GitHub: arjvik/undertaker, commit {{GIT-HASH}})'
    })
    await sendMessage(socket, {
        type: 'getpeers'
    })

    let buffer: string = ''

    socket.stream.on('data', async (chunk) => {
        // console.log(`Received data ${chunk} from ${remoteAddress}`)
        try {
            buffer += chunk.toString(undefined, 0, MAX_MESSAGE_LENGTH)
            buffer = buffer.substring(0, MAX_MESSAGE_LENGTH)
            let eom = buffer.indexOf('\n')
            if (eom != -1) {
                clearTimeout(timeoutID)
            }
            while (eom != -1) {
                const json = buffer.substring(0, eom)
                console.log(`Received message ${json} from ${remoteAddress}`)
                const message: types.Message = types.Message.parse(JSON.parse(json))
                if (!saidHello && message.type != 'hello') {
                    await sendError(socket, 'INVALID_HANDSHAKE', 'The peer sent other validly formatted messages before sending a valid hello message.')
                }
                switch (message.type) {
                    case 'hello':
                        console.log(`Hello from ${message.agent} running protocol v${message.version}`)
                        saidHello = true
                        break
                    case 'peers':
                        console.log(`Received peers ${message.peers} from ${remoteAddress}`)
                        for (const peer of message.peers) {
                            const host = getHostPort(peer).host
                            if (net.isIP(host) || isValidDomain(host)) {
                                if (!peers.has(peer)) {
                                    console.log(`Valid peer ${peer} from ${remoteAddress}`)
                                    peers.add(peer)
                                    if (sockets.size < DESIRED_CONNECTIONS) {
                                        console.log(`Attempting to connect to peer #${sockets.size + 1} ${peer} advertised by ${remoteAddress}`)
                                        await connectToPeer(peer)
                                        // Synchronously connect to peers to avoid all suddenly accepting
                                    }
                                }
                            } else {
                                console.log(`Invalid peer ${peer} from ${remoteAddress}`)
                            }
                        }
                        break
                    case 'getpeers':
                        console.log(`Received getpeers message from ${remoteAddress}`)
                        await sendMessage(socket, {
                            type: 'peers',
                            peers: Array.from(peers)
                        })
                        break
                    case 'getobject':
                        console.log(`Received getobject for ${message.objectid} from ${remoteAddress}`)
                        try {
                            const object = await db.get(message.objectid)
                            await sendMessage(socket, {
                                type: 'object',
                                object: object
                            })
                        } catch (err: any) {
                            if ('code' in err && err.code == 'LEVEL_NOT_FOUND') {
                                await sendError(socket, 'UNKNOWN_OBJECT', `Object ${message.objectid} not found: ${err.code} - ${'cause' in err ? err.cause : 'cause'}`)
                            } else {
                                await sendError(socket, 'INTERNAL_ERROR', `Failed to retrieve object from database: ${err}`)
                            }
                        }
                        break
                    case 'object':
                        console.log(`Received object ${message.object} from ${remoteAddress}`)
                        if (await validateObject(socket, message.object)) {
                            const objectid: string = hashObject(message.object)
                            if (!await db.exists(objectid)) {
                                await db.put(objectid, message.object)
                            }

                            await Promise.all([...sockets]
                                .map((receiverSocket) =>
                                    async () => sendMessage(receiverSocket, {
                                        type: 'ihaveobject',
                                        objectid: objectid
                                    })))
                        }
                        break
                    case 'ihaveobject':
                        console.log(`Received ihaveobject ${message.objectid} from ${remoteAddress}`);
                        if (!await db.exists(message.objectid)) {
                            await sendMessage(socket, {
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
                console.log(`Storing partial message '${buffer}' from ${remoteAddress}`)
            }
        } catch (err: any) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
                await sendError(socket, 'INVALID_FORMAT', 'The format of the received message is invalid.')
            } else {
                console.log(`!!INTERNAL_ERROR!! ${err} --- ${err.stack}`)
                await sendError(socket, 'INTERNAL_ERROR', `Something unexpected happened: ${'name' in err ? err.name : 'error'}`)
            }
        }
    })

    socket.once('end').then(async () => {
        console.log(`Connection close from ${socket.stream.remoteAddress}`)
        await disconnect(socket)
    })

    socket.once('error').catch(async (err) => {
        console.log(`Transmission error from ${socket.stream.remoteAddress}: ${err}`)
        await disconnect(socket)
    })
}

const server = net.createServer(async (socket: net.Socket) => await handleConnection(new PromiseSocket(socket)))
server.on('error', (err) => {
    console.log(`!!SERVER ERROR!! ${err}`)
})

server.listen({ host: '0.0.0.0', port: PORT }, () => {
    console.log(`Serving on ${PORT}`)
})

for (const peer of peers) {
    connectToPeer(peer).then(() => { })
}