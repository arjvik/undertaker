import * as ed from '@noble/ed25519'
import { createHash } from 'blake2'
import delay from 'delay'
import isValidDomain from 'is-valid-domain'
import { canonicalize } from 'json-canonicalize'
import level from 'level-ts'
import * as net from 'net'
import PromiseSocket from 'promise-socket'
import { ZodError } from 'zod'
import * as types from './types'
import 'promise-any-polyfill'

type Socket = PromiseSocket<net.Socket>

const MAX_MESSAGE_LENGTH = 102400
const PORT = 18018
const DESIRED_CONNECTIONS = 20
const HELLO_TIMEOUT = 30_000
const PARTIAL_MESSAGE_TIMEOUT = 10_000
const FIND_OBJECT_TIMEOUT = 30_000

const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
// const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<Socket> = new Set()
const db: level<types.Object> = new level('./database')

const handles: { [key: types.Hash]: {promise: Promise<boolean>, resolve: ((found: boolean | PromiseLike<boolean>) => void) | null} } = {}

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
    console.log(`Sending message ${json} to ${socket.stream.remoteAddress}:${socket.stream.remotePort}`)
    return socket.write(json + '\n').catch(() => console.log(`Unable to send message ${json} to ${socket.stream.remoteAddress}:${socket.stream.remotePort}`))
}

const disconnect = async (socket: Socket) => {
    console.log(`Destroying socket to ${socket.stream.remoteAddress}`)
    try {
        socket.destroy()
    } catch (err) {
        console.log(`Unable to destroy socket to ${socket.stream.remoteAddress}: ${err}`)
    }
    sockets.delete(socket)
}

const sendError = async (socket: Socket, name: types.ErrorCode, message: string) => {
    await sendMessage(socket, {
        type: 'error',
        name: name,
        message: message
    })
    if (name == 'INVALID_FORMAT' || name == 'INVALID_HANDSHAKE') {
        await disconnect(socket)
    }
}

const connectToPeer = async (peer: string) => {
    console.log(`Attemting to connect to ${peer}`)
    let socket: Socket = new PromiseSocket(new net.Socket())

    socket.stream.on('error', async (err) => {
        console.log(`Transmission error with ${peer}, disconnecting: ${err}`)
    })

    try {
        await socket.connect(getHostPort(peer))
    } catch (err) {
        console.log(`Failed to connect to ${peer}: ${err}`)
        return
    }
    handleConnection(socket)
        .then(() => { })
        .catch((err) => console.log(`Error handling connection to ${peer} from connectToPeer: ${err}`))
}

const addTimeout = (socket: Socket, timeout: number = PARTIAL_MESSAGE_TIMEOUT) => {
    return setTimeout(async () => {
        console.log(`Peer ${socket.stream.remoteAddress} timed out.`)
        await sendError(socket, 'INVALID_FORMAT', 'Peer timed out.')
    }, timeout)
}

const hashObject = (object: types.Object) =>
    createHash('blake2s', { digestLength: 32 })
        .update(Buffer.from(canonicalize(object), 'utf8'))
        .digest('hex')

const validateStringSignature = async (signature: string, message: string, publicKey: string) => {
    const signatureBytes = Uint8Array.from(Buffer.from(signature, 'hex'))
    const messageBytes = Uint8Array.from(Buffer.from(message, 'utf8'))
    const publicKeyBytes = Uint8Array.from(Buffer.from(publicKey, 'hex'))
    return ed.verify(signatureBytes, messageBytes, publicKeyBytes)
}

const createUTXOSet = async (block: types.BlockObject): Promise<Map<string, types.UTXO>> => {
    let utxoSet = new Map();
    for (let tx of block.txids) {
        const transaction = await db.get(tx);
        if (transaction.type == 'transaction') {
            for (let i = 0; i < transaction.outputs.length; i++) {
                addToUTXOSet(utxoSet, tx, i, transaction.outputs[i].value);
            }
        }
    }
    return utxoSet;
}

function addToUTXOSet(utxoSet: Map<string, types.UTXO>, txid: string, outputIndex: number, value: number) {
    const key = `${txid}:${outputIndex}`;
    const utxo: types.UTXO = {value, txid, index: outputIndex};
    utxoSet.set(key, utxo);
  }
  
  function removeFromUTXOSet(utxoSet: Map<string, types.UTXO>, txid: string, outputIndex: number) {
    const key = `${txid}:${outputIndex}`;
    utxoSet.delete(key);
  }

// Assumption: This function is only called after we validate the block
const updateUTXOSet = async (socket: Socket, block: types.BlockObject): Promise<Map<string, types.UTXO>> => {
    if (!await db.exists(block.previd)) {
        await sendError(socket, 'INVALID_BLOCK_POW', `previd ${block.previd} does not exist`)
        return new Map();
    }
    let prevBlock = await db.get(block.previd)
    let prevUTXOSet = new Map();
    if (prevBlock.type === 'block') {
        createUTXOSet(prevBlock).then((result) => {prevUTXOSet = result})
        let unspentFees = 0
        for (const txid of block.txids) {
            // Handle non-coinbase txns and check that each input corresponds to an output that exists in utxo set
            const tx = await db.get(txid)
            
            if (tx.type === 'transaction') {
                if ("inputs" in tx) {
                    for (const input of tx.inputs) {       
                        if (!prevUTXOSet.has(input.outpoint.txid+ ":" + input.outpoint.index)) {
                            await sendError(socket, 'INVALID_TX_OUTPOINT', `Output not found in UTXO set: ${input.outpoint.txid}:${input.outpoint.index}`)
                            return prevUTXOSet;
                        }
                    }
                    let inputSum = 0;
                    let outputSum = 0;
                    let newUTXOSet = new Map(prevUTXOSet);
                    for (const input of tx.inputs) {
                        inputSum += newUTXOSet.get(input.outpoint.txid + ":" + input.outpoint.index).value;
                        //Remove spent UTXOs
                        removeFromUTXOSet(newUTXOSet, input.outpoint.txid, input.outpoint.index);
                    }
                    for (let i = 0; i < tx.outputs.length; i++) {
                        outputSum += tx.outputs[i].value;
                        //Add created UTXOs
                        addToUTXOSet(newUTXOSet, txid, i, tx.outputs[i].value);
                    }
                    if (inputSum < outputSum) {
                        await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction does not satisfy weak law of conservation: ${inputSum} < ${outputSum}`)
                        return prevUTXOSet;
                    } else {
                        unspentFees += (outputSum - inputSum)
                    }
                    prevUTXOSet = newUTXOSet;
                } else if ("height" in tx) {
                    if (txid !== block.txids[0]) {
                        await sendError(socket, 'INVALID_BLOCK_COINBASE', `Coinbase transaction must be the first in the txids`)
                        return prevUTXOSet;
                    }
                }
            }

        }
        // Handle a Coinbase txn
        const txid = block.txids[0];
        const tx = await db.get(txid);
        if (tx.type === 'transaction' && "height" in tx) {
            //TODO
            // if (tx.height !== block.height) {
            //     await sendError(socket, 'INVALID_BLOCK_COINBASE', `Coinbase transaction height must match the height of the block the transaction is contained in`)
            //     return prevUTXOSet;
            // }
            if (tx.outputs.length !== 1) {
                await sendError(socket, 'INVALID_FORMAT', `Coinbase transaction must have exactly one output`)
                return prevUTXOSet;
            }
            if (tx.outputs[0].value > (50 * 10**12 + unspentFees)) {
                await sendError(socket, 'INVALID_BLOCK_COINBASE', `Coinbase transaction output value cannot exceed 50 * 10^12`)
                return prevUTXOSet;
            }
            // Add created UTXOs
            addToUTXOSet(prevUTXOSet, txid, 0, tx.outputs[0].value);
        }
    }
    
    return prevUTXOSet;
}

const validateObject = async (socket: Socket, object: types.Object) => {
    switch (object.type) {
        case 'block':
            console.log(`Attempting to verify block ${hashObject(object)}: ${canonicalize(object)}`)
            if (hashObject(object) >= object.T) {
                await sendError(socket, 'INVALID_BLOCK_POW', `Block ${hashObject(object)} does not meet proof of work requirement.`)
                return false
            }
            for (const txid of object.txids) {
                if (!await db.exists(txid)) {
                    Promise.all(
                        [...sockets].map(async (receiverSocket) => {
                            console.log(`Sending ihaveobject ${txid} to ${receiverSocket.stream.remoteAddress}`)
                            return sendMessage(receiverSocket, {
                                type: 'getobject',
                                objectid: txid
                            })
                        })
                    ).then(() => { })
                    if (!(txid in handles)) {
                        handles[txid] = {
                            promise: new Promise((resolve) => {
                                handles[txid].resolve = resolve
                            }),
                            resolve: null
                        }
                    }
                    let promise: Promise<boolean> = Promise.any([delay(FIND_OBJECT_TIMEOUT).then(() => true), handles[txid].promise])
                    if (await promise) {
                        if (!await db.exists(txid)) {
                            await sendError(socket, 'INTERNAL_ERROR', `Struggling to find ${txid} internally`)
                            console.log(`!!ERROR!! Struggling to find ${txid} internally!`)
                            return false
                        }
                    } else {
                        await sendError(socket, 'UNFINDABLE_OBJECT', `Unable find ${txid} externally`)
                    }
                }
            }
            // Maintain a UTXO set
            return true
        case 'transaction':
            console.log(`Attempting to verify transaction ${hashObject(object)}: ${canonicalize(object)}`)
            if ('inputs' in object) {
                console.log(`Transaction ${hashObject(object)} is not a coinbase`)
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
                    console.log(`Validated input ${object.inputs.indexOf(input)} of transaction ${hashObject(object)}`)
                }

                if (new Set(object.inputs.map(i => JSON.stringify(i.outpoint))).size < object.inputs.length) {
                    await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction has duplicate outpoints.`)
                    return false
                }

                let totalOutputValue: number = 0
                for (const output of object.outputs) {
                    totalOutputValue += output.value
                }
                if (totalInputValue < totalOutputValue) {
                    await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction has more outputs than inputs`)
                    return false
                }
            } else {
                console.log(`Transaction ${hashObject(object)} is coinbase and therefore valid`)
            }
            return true
    }
}

const handleConnection = async (socket: Socket) => {
    const remoteAddress = `${socket.stream.remoteAddress}:${socket.stream.remotePort}`

    console.log(`Client #${sockets.size + 1} connected from ${remoteAddress}`)

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
                            if (await db.exists(message.objectid)) {
                                const object = await db.get(message.objectid)
                                await sendMessage(socket, {
                                    type: 'object',
                                    object: object
                                })
                            } else {
                                await sendError(socket, 'UNKNOWN_OBJECT', `Object ${message.objectid} not found`)
                            }
                        } catch (err: any) {
                            await sendError(socket, 'INTERNAL_ERROR', `Failed to retrieve object from database: ${err}`)
                        }
                        break
                    case 'object':
                        console.log(`Received object ${message.object} from ${remoteAddress}`)
                        if (await validateObject(socket, message.object)) {
                            console.log(`Validated object ${message.object} from ${remoteAddress}`)
                            const objectid: string = hashObject(message.object)
                            if (!await db.exists(objectid)) {
                                await db.put(objectid, message.object)
                            }
                            if (objectid in handles) {
                                let object = handles[objectid]
                                if (object.resolve !== null) {
                                    object.resolve(true)
                                }
                            }
                            await Promise.all(
                                [...sockets].map(async (receiverSocket) => {
                                    console.log(`Sending ihaveobject ${objectid} to ${receiverSocket.stream.remoteAddress}`)
                                    return sendMessage(receiverSocket, {
                                        type: 'ihaveobject',
                                        objectid: objectid
                                    })
                                })
                            )
                        } else {
                            console.log(`Failed to validate object ${message.object} from ${remoteAddress}`)
                        }
                        break
                    case 'ihaveobject':
                        console.log(`Received ihaveobject ${message.objectid} from ${remoteAddress}`)
                        if (!await db.exists(message.objectid)) {
                            await sendMessage(socket, {
                                type: 'getobject',
                                objectid: message.objectid
                            })
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

    socket.stream.on('end', async () => {
        console.log(`Connection close from ${socket.stream.remoteAddress}`)
        await disconnect(socket)
    })

    socket.stream.on('error', async (err) => {
        console.log(`Transmission error from ${socket.stream.remoteAddress}: ${err}`)
        await disconnect(socket)
    })
}

const server = net.createServer(async (socket: net.Socket) => await handleConnection(new PromiseSocket(socket)))
server.on('error', (err) => {
    console.log(`!!SERVER ERROR!! ${err}`)
})

server.listen({ port: PORT }, () => {
    console.log(`Serving on ${PORT}`)
})

for (const peer of peers) {
    connectToPeer(peer).then(() => { })
}