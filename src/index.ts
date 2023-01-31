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
import { EventEmitter } from 'events'

interface Emitter<T> {
    on(event: string, listener: (arg: T) => void): this
    once(event: string, listener: (arg: T) => void): this
    emit(event: string, arg: T): boolean
}
function createEmitter<T>(): Emitter<T> {
    return new EventEmitter()
}

type Socket = PromiseSocket<net.Socket>

const MAX_MESSAGE_LENGTH = 102400
const PORT = 18018
const DESIRED_CONNECTIONS = 20
const HELLO_TIMEOUT = 30_000
const PARTIAL_MESSAGE_TIMEOUT = 10_000
const FIND_OBJECT_TIMEOUT = 10_000

const BLOCK_REWARD = 50_000000000000n

const GENESIS_BLOCK = "0000000052a0e645eca917ae1c196e0d0a4fb756747f29ef52594d68484bb5e2"

const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
// const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<Socket> = new Set()
const db: level<types.Object> = new level('./database')
const utxos: level<types.UTXO[]> = new level('./utxos')

const objectReceivedEmitter = createEmitter<types.Object>()

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

const sendError = async (socket: Socket, name: types.ErrorCode, description: string) => {
    await sendMessage(socket, {
        type: 'error',
        name: name,
        description: description
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

const ensureObject = async (socket: Socket, objectid: string) => {
    if (!await db.exists(objectid)) {
        Promise.all(
            [...sockets].map(async (receiverSocket) => {
                console.log(`Sending getobject ${objectid} to ${receiverSocket.stream.remoteAddress}`)
                return sendMessage(receiverSocket, {
                    type: 'getobject',
                    objectid: objectid
                })
            })
        ).then(() => { })
        const promise: Promise<types.Object | null> = Promise.any([
            delay(FIND_OBJECT_TIMEOUT).then(() => null),
            new Promise(resolve => objectReceivedEmitter.once(objectid, resolve))
        ])
        const result: types.Object | null = await promise
        if (result == null) {
            await sendError(socket, 'UNFINDABLE_OBJECT', `Unable find ${objectid} externally`)
            return null
        } else {
            return result
        }
    }
    return db.get(objectid)
}

const noNullElements = <T> (elems: (T | null)[]): elems is T[] => !elems.includes(null)
const allTrue = (elems: boolean[]): boolean => !elems.includes(false)

const hasUTXO = (utxoSet: types.UTXO[], txid: string, index: number): boolean => !utxoSet.every((utxo: types.UTXO) => utxo.txid != txid || utxo.index != index)
const getUTXO = (utxoSet: types.UTXO[], txid: string, index: number): types.UTXO => utxoSet.find((utxo: types.UTXO) => utxo.txid == txid && utxo.index == index) as types.UTXO
const withoutUTXO = (utxoSet: types.UTXO[], txid: string, index: number): types.UTXO[] => utxoSet.filter((utxo: types.UTXO) => utxo.txid != txid || utxo.index != index)

const validateObject = async (socket: Socket, object: types.Object) => {
    const hash = hashObject(object)
    console.log(`Validating object ${hash}`)
    switch (object.type) {
        case 'block':
            console.log(`Attempting to verify block ${hash}: ${canonicalize(object)}`)
            if (hash >= object.T) {
                console.log(`Block hash ${hash} >= T ${object.T}`)
                await sendError(socket, 'INVALID_BLOCK_POW', `Block ${hash} does not meet proof of work requirement.`)
                return false
            }
            const transactions = (await Promise.all(object.txids.map(async (txid) => ensureObject(socket, txid)))) as (types.TransactionObject | null)[]
            if (noNullElements(transactions)) {
                console.log(`All txids found in block ${hash}`)
            } else {
                console.log(`Not all txids found in block ${hash}`)
                return false
            }
            if (!allTrue(transactions.slice(1).map(tx => 'inputs' in tx))) {
                console.log(`At least one transaction after the first in ${hash} is a coinbase transaction`)
                sendError(socket, 'INVALID_BLOCK_COINBASE', 'Only the first transaction can be a coinbase transaction')
                return false
            }
            const coinbase = transactions.length > 0 && 'height' in transactions[0] ? transactions[0] : null
            console.log(`Block ${hash} has coinbase ${coinbase}`)
            if (object.previd === null) {
                if (hash !== GENESIS_BLOCK) {
                    console.log(`Block ${hash} does not have a previd but is not the genesis block`)
                    await sendError(socket, 'INVALID_GENESIS', `Block ${hash} does not have a previd but is not the genesis block`)
                    return false
                } else {
                    console.log(`Block really is the genesis block`)
                }
            } else {
                if (await ensureObject(socket, object.previd) == null) {
                    console.log(`Unable to find previd ${object.previd} for block ${hash}`)
                    return false
                } else {
                    console.log(`Successfully ensured knowledge of prev block ${object.previd} for block ${hash}`)
                }
            }
            let utxoSet = object.previd != null ? await utxos.get(object.previd) : []
            let transactionFees = 0n
            console.log(`Building UTXO set for block ${hash}`)
            for (const [tx, txid, i] of transactions.map((e, i): [types.TransactionObject, string, number] => [e as types.TransactionObject, object.txids[i], i])) {
                console.log(`Current UTXO set: ${utxoSet}, current transaction fees ${transactionFees}`)
                console.log(`Handling transaction #${i+1}: ${txid}`)
                if ('inputs' in tx) {
                    console.log(`Transaction ${txid} is a normal transaction`)
                    for (const input of tx.inputs) {
                        if (!hasUTXO(utxoSet, input.outpoint.txid, input.outpoint.index)) {
                            console.log(`UTXO ${input.outpoint.txid}:${input.outpoint.index} not found in UTXO set`)
                            await sendError(socket, 'INVALID_TX_OUTPOINT', `UTXO ${input.outpoint.txid}:${input.outpoint.index} not found in UTXO set`)
                            return false
                        }
                        transactionFees += BigInt(getUTXO(utxoSet, input.outpoint.txid, input.outpoint.index).value)
                        utxoSet = withoutUTXO(utxoSet, input.outpoint.txid, input.outpoint.index)
                        console.log(`UTXO ${input.outpoint.txid}:${input.outpoint.index} found and removed from UTXO set`)
                    }
                    tx.outputs.forEach((output, index) => {
                        transactionFees -= BigInt(output.value)
                        utxoSet.push({txid: txid, index: index, value: output.value})
                        console.log(`Created UTXO ${txid}:${index}`)
                    })
                } else {
                    console.log(`Transaction ${txid} is a coinbase transaction`)
                    tx.outputs.forEach((output, index) => {
                        console.log(`Created UTXO ${txid}:${index} - this should only be printed once per block`)
                        utxoSet.push({txid: txid, index: index, value: output.value})
                    })
                }
            }
            console.log(`Final UTXO set for block ${hash}: ${utxoSet}, transaction fees ${transactionFees}`)
            utxos.put(hash, utxoSet)
            if (coinbase != null) {
                console.log(`Beginning coinbase verification for block ${hash}`)
                if (!hasUTXO(utxoSet, object.txids[0], 0)) {
                    console.log(`Coinbase transaction spent output within block ${hash}`)
                    await sendError(socket, 'INVALID_TX_OUTPOINT', 'Cannot spend output of coinbase transaction within block')
                    return false
                } else {
                    console.log(`Coinbase transaction does not spend output within block ${hash}`)
                }
                if (coinbase.outputs[0].value > transactionFees + BLOCK_REWARD) {
                    console.log(`Coinbase transaction steals too much in fees in block ${hash}`)
                    await sendError(socket, 'INVALID_BLOCK_COINBASE', `BlockhashObject(object) ${hash} reward of ${BigInt(coinbase.outputs[0].value) - transactionFees} (excluding transaction fees of ${transactionFees}) exceeds max reward of ${BLOCK_REWARD}`)
                    return false
                } else {
                    console.log(`Coinbase transaction takes fair fees in block ${hash}`)
                }
            } else {
                console.log(`No coinbase transaction to verify in block ${hash}`)
            }
            return true
        case 'transaction':
            console.log(`Attempting to verify transaction ${hash}: ${canonicalize(object)}`)
            if ('inputs' in object && object.inputs != undefined && 'height' in object && object.height != undefined) {
                await sendError(socket, 'INVALID_FORMAT', `Transaction ${hash} is coinbase but has height`)
                return false
            } else if ('inputs' in object && object.inputs != undefined) {
                console.log(`Transaction ${hash} is not a coinbase`)
                let signableObject: { type: "transaction", outputs: { value: number, pubkey: string, }[], inputs: { outpoint: { txid: string, index: number, }, sig: string | null, }[] }
                    = JSON.parse(JSON.stringify(object)) // deep copy hack
                for (const input of signableObject.inputs) {
                    input.sig = null
                }
                let signableText: string = canonicalize(signableObject)
                let totalInputValue: bigint = 0n
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
                    totalInputValue += BigInt(outpoint.value)
                    console.log(`Validated input ${object.inputs.indexOf(input)} of transaction ${hash}`)
                }

                if (new Set(object.inputs.map(i => JSON.stringify(i.outpoint))).size < object.inputs.length) {
                    await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction has duplicate outpoints.`)
                    return false
                }

                let totalOutputValue: bigint = 0n
                for (const output of object.outputs) {
                    totalOutputValue += BigInt(output.value)
                }
                if (totalInputValue < totalOutputValue) {
                    await sendError(socket, 'INVALID_TX_CONSERVATION', `Transaction has more outputs than inputs`)
                    return false
                }
                return true
            } else if ('height' in object && object.height != undefined) {
                console.log(`Transaction ${hash} is coinbase and therefore valid`)
                return true
            } else {
                await sendError(socket, 'INVALID_FORMAT', `Transaction ${hash} is neither coinbase nor regular transaction`)
                return false
            }
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
                buffer = buffer.substring(eom + 1)
                eom = buffer.indexOf('\n')

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
                        const objectid: string = hashObject(message.object)
                        console.log(`Received object ${objectid} from ${remoteAddress}`)
                        if (await validateObject(socket, message.object)) {
                            console.log(`Validated object ${objectid} from ${remoteAddress}`)
                            if (!await db.exists(objectid)) {
                                await db.put(objectid, message.object)
                            }
                            objectReceivedEmitter.emit(objectid, message.object)
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
                            console.log(`Failed to validate object ${objectid} from ${remoteAddress}`)
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

process.on('SIGINT', () => process.exit(0));