import * as ed from '@noble/ed25519'
import { createHash } from 'blake2'
import delay from 'delay'
import { EventEmitter } from 'events'
import isValidDomain from 'is-valid-domain'
import { canonicalize } from 'json-canonicalize'
import level from 'level-ts'
import * as net from 'net'
import 'promise-any-polyfill'
import PromiseSocket from 'promise-socket'
import { ZodError } from 'zod'
import * as types from './types'

interface Emitter<T> {
    on(event: string, listener: (arg: T) => void): this
    once(event: string, listener: (arg: T) => void): this
    emit(event: string, arg: T): boolean
}
function createEmitter<T>(): Emitter<T> {
    return new EventEmitter()
}

class ProtocolError extends Error {
    errName: types.ErrorCode
    errDescription: string
    constructor(errName: types.ErrorCode, errDescription: string) {
        super()
        this.errName = errName
        this.errDescription = errDescription
    }
}

type Socket = PromiseSocket<net.Socket>

const MAX_MESSAGE_LENGTH = 1024_000_000
const PORT = 18018
const DESIRED_CONNECTIONS = 0
const HELLO_TIMEOUT = 30_000
const PARTIAL_MESSAGE_TIMEOUT = 10_000
const FIND_OBJECT_TIMEOUT = 4_000

const BLOCK_REWARD = 50_000000000000n

const GENESIS_BLOCK = "0000000052a0e645eca917ae1c196e0d0a4fb756747f29ef52594d68484bb5e2"

const CHAINTIP = '<<CHAINTIP>>'

const peers: Set<string> = new Set(['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'])
// const peers: Set<string> = new Set(['127.0.0.1:19019', '127.0.0.1:20020'])
const sockets: Set<Socket> = new Set()
const db: level<types.Object> = new level('./database')
const utxos: level<types.UTXO[]> = new level('./utxos')
const chaintip: level<types.Chaintip> = new level('./chaintip')

let mempoolUTXOs: types.UTXO[] = []
let mempoolTXs: types.Hash[] = []

;
(async () => {
    // Initialize mempool UTXO set to UTXOset of current chaintip
    // Hack: because we lack top-level-await, we just pray it finishes fast enough
    if (await chaintip.exists(CHAINTIP)) {
        mempoolUTXOs = [...await utxos.get((await chaintip.get(CHAINTIP)).hash)]
    }
    console.log(`Initialized very first mempool UTXO set to ${JSON.stringify(mempoolUTXOs)}`)
})().then(() => { })

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
    return socket.write(json + '\n')
                 .catch(() => console.log(`Unable to send message ${json} to ${socket.stream.remoteAddress}:${socket.stream.remotePort}`))
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

const requestObject = async (objectid: string) => 
    Promise.all(
        [...sockets].map(async (receiverSocket) => {
            console.log(`Sending getobject ${objectid} to ${receiverSocket.stream.remoteAddress}`)
            return sendMessage(receiverSocket, {
                type: 'getobject',
                objectid: objectid
            })
        })
    )

const ensureObject = async (objectid: string) => {
    console.log(`Ensuring that object ${objectid} exists`)
    if (!await db.exists(objectid)) {
        console.log(`Fetching object ${objectid} from peers`)
        requestObject(objectid).then(() => { })
        const promise: Promise<types.Object | null> = Promise.any([
            delay(FIND_OBJECT_TIMEOUT).then(() => null),
            new Promise((resolve) => objectReceivedEmitter.once(objectid, resolve))
        ])
        const result: types.Object | null = await promise
        if (result == null) {
            console.log(`Could not find ${objectid} from peers`)
            throw new ProtocolError('UNFINDABLE_OBJECT', `Unable find ${objectid} externally`)
        } else {
            console.log(`Found object ${objectid} from peers`)
            return result
        }
    } else {
        console.log(`Already have object ${objectid}`)
    }
    return db.get(objectid)
}

const blockHeight = async (block: types.BlockObject, trustCoinbase: boolean = true): Promise<number> => {
    if (block.previd === null) {
        return 0
    }
    if (block.txids.length > 0 && trustCoinbase) {
        const transaction = await db.get(block.txids[0]) as types.TransactionObject
        if ('height' in transaction) {
            return transaction.height
        }
    }
    return (ensureObject(block.previd) as Promise<types.BlockObject>)
            .then(blockHeight)
            .then((height) => height + 1)
}

const allTrue = (elems: boolean[]): boolean => !elems.includes(false)

const hasUTXO = (utxoSet: types.UTXO[], txid: string, index: number): boolean => !utxoSet.every((utxo: types.UTXO) => utxo.txid != txid || utxo.index != index)
const getUTXO = (utxoSet: types.UTXO[], txid: string, index: number): types.UTXO => utxoSet.find((utxo: types.UTXO) => utxo.txid == txid && utxo.index == index) as types.UTXO
const withUTXO = (utxoSet: types.UTXO[], txid: string, index: number, value: number): types.UTXO[] => [...utxoSet, { txid: txid, index: index, value: value }]
const withoutUTXO = (utxoSet: types.UTXO[], txid: string, index: number): types.UTXO[] => utxoSet.filter((utxo: types.UTXO) => utxo.txid != txid || utxo.index != index)

const updateUTXO = (utxoSet: types.UTXO[], tx: types.TransactionObject, txFeeHandler: ((txfee: bigint) => void) | null = null): types.UTXO[] => {
    const txid = hashObject(tx)
    if ('inputs' in tx) {
        console.log(`Transaction ${txid} is a normal transaction`)
        for (const input of tx.inputs) {
            if (!hasUTXO(utxoSet, input.outpoint.txid, input.outpoint.index)) {
                console.log(`UTXO ${input.outpoint.txid}:${input.outpoint.index} not found in UTXO set`)
                throw new ProtocolError('INVALID_TX_OUTPOINT', `UTXO ${input.outpoint.txid}:${input.outpoint.index} not found in UTXO set`)
            }
            if (txFeeHandler != null) {
                txFeeHandler(BigInt(getUTXO(utxoSet, input.outpoint.txid, input.outpoint.index).value))
            }
            utxoSet = withoutUTXO(utxoSet, input.outpoint.txid, input.outpoint.index)
            console.log(`UTXO ${input.outpoint.txid}:${input.outpoint.index} found and removed from UTXO set`)
        }
        tx.outputs.forEach((output, index) => {
            if (txFeeHandler != null) {
                txFeeHandler(-BigInt(output.value))
            }
            utxoSet = withUTXO(utxoSet, txid, index, output.value)
            console.log(`Created UTXO ${txid}:${index}`)
        })
    } else {
        console.log(`Transaction ${txid} is a coinbase transaction`)
        tx.outputs.forEach((output, index) => {
            console.log(`Created UTXO ${txid}:${index} - this should only be printed once per block`)
            utxoSet = withUTXO(utxoSet, txid, index, output.value)
        })
    }
    return utxoSet
}

const forgottenTransactions = async (oldChaintip: types.Chaintip | null, newChaintip: types.Chaintip): Promise<types.Hash[]> => {
    console.log(`Finding forgotten transactions between ${oldChaintip?.hash} and ${newChaintip.hash} (height ${oldChaintip?.height} to ${newChaintip.height})`)
    let txids: types.Hash[] = []
    let oldAncestor: types.Hash | null = null
    if (oldChaintip == null) {
        // Forgotten all transactions in chain; there is no common ancestor
    } else {
        // Find common ancestor
        let newAncestor = newChaintip.hash;
        // Naive Lifting algorithm
        for (let i = 0; i < newChaintip.height - oldChaintip.height; i++) {
            newAncestor = (newAncestor == newChaintip.hash ? newChaintip.block : await db.get(newAncestor) as types.BlockObject).previd as string
        }
        oldAncestor = oldChaintip.hash;
        while (oldAncestor != newAncestor) {
            oldAncestor = (await db.get(oldAncestor) as types.BlockObject).previd as string
            newAncestor = (await db.get(newAncestor) as types.BlockObject).previd as string
        }
    }

    let currentBlockHash: types.Hash | null = newChaintip.hash
    while (currentBlockHash != oldAncestor) {
        const currentBlock: types.BlockObject = currentBlockHash == newChaintip.hash ? newChaintip.block : await db.get(currentBlockHash as string) as types.BlockObject
        txids = [...currentBlock.txids, ...txids]
        currentBlockHash = currentBlock.previd
    }
    return txids
}

const applyTransaction = (tx: types.TransactionObject, currentUTXOs: types.UTXO[], currentTXs: types.Hash[]) => {
    console.log(`Attempting to apply transaction ${JSON.stringify(tx)} to mempool, but will throw errors here (to possibly be caught by above)`)
    currentUTXOs = updateUTXO(currentUTXOs, tx)
    currentTXs = [...currentTXs, hashObject(tx)]
    console.log(`Successfully applied transaction ${JSON.stringify(tx)} to mempool without throwing errors`)
    return [currentUTXOs, currentTXs] as const
}

const attemptApplyTransaction = (tx: types.TransactionObject, currentUTXOs: types.UTXO[], currentTXs: types.Hash[], blockHashForLogging: string) => {
    console.log(`Attempting to apply transaction ${JSON.stringify(tx)} to mempool for reorg to block ${blockHashForLogging} (but will catch errors)`)
    try {
        [currentUTXOs, currentTXs] = applyTransaction(tx, currentUTXOs, currentTXs)
        console.log(`Successfully applied transaction ${JSON.stringify(tx)} to mempool for reorg to block ${blockHashForLogging}`)
        return [currentUTXOs, currentTXs] as const
    } catch (e) {
        if (e instanceof ProtocolError && e.errName == 'INVALID_TX_OUTPOINT') {
            console.log(`Failed to apply transaction ${JSON.stringify(tx)} to mempool for reorg to block ${blockHashForLogging}: ${e}`)
            return [currentUTXOs, currentTXs] as const
        } else {
            console.log(`Caught unrelated error ${e} while applying transaction ${JSON.stringify(tx)} to mempool for reorg to block ${blockHashForLogging}, aborting`)
            throw e
        }
    }
}

const validateObject = async (object: types.Object) => {
    const hash = hashObject(object)
    console.log(`Validating object ${hash}`)
    switch (object.type) {
        case 'block':
            console.log(`Attempting to verify block ${hash}: ${canonicalize(object)}`)
            if (hash >= object.T) {
                console.log(`Block hash ${hash} >= T ${object.T}`)
                throw new ProtocolError('INVALID_BLOCK_POW', `Block ${hash} does not meet proof of work requirement.`)
            }
            if (object.created > Math.floor(Date.now() / 1000)) {
                console.log(`Block ${hash} has timestamp ${object.created} that's in the future`)
                throw new ProtocolError('INVALID_BLOCK_TIMESTAMP', `Block ${hash} has timestamp ${object.created} that's in the future (seen at ${Math.floor(Date.now() / 1000)})`)
            }

            if (object.previd === null) {
                if (hash !== GENESIS_BLOCK) {
                    console.log(`Block ${hash} does not have a previd but is not the genesis block`)
                    throw new ProtocolError('INVALID_GENESIS', `Block ${hash} does not have a previd but is not the genesis block`)
                } else {
                    console.log(`Block really is the genesis block`)
                }
            } else {
                const prev = await ensureObject(object.previd)
                if (prev.type != 'block') {
                    console.log(`Block ${hash} has previd ${object.previd} but that is not a block`)
                    throw new ProtocolError('INVALID_FORMAT', `Block ${hash} has previd ${object.previd} that is not a block`)
                }
                if (prev.created >= object.created) {
                    console.log(`Block ${hash} has previd ${object.previd} but that has a greater or equal timestamp`)
                    throw new ProtocolError('INVALID_BLOCK_TIMESTAMP', `Block ${hash} has previd ${object.previd} with a greater or equal timestamp`)
                }
                console.log(`Successfully ensured knowledge of prev block ${object.previd} for block ${hash}`)
            }

            const transactions = await Promise.all(object.txids.map(ensureObject))
            if (!allTrue(transactions.map((tx) => tx.type == 'transaction'))) {
                throw new ProtocolError('INVALID_FORMAT', `Block ${hash} contains a non-transaction.`)
            }
            if (!allTrue(transactions.slice(1).map((tx) => 'inputs' in tx))) {
                console.log(`At least one transaction after the first in ${hash} is a coinbase transaction`)
                throw new ProtocolError('INVALID_BLOCK_COINBASE', `Only the first transaction can be a coinbase transaction`)
            }
            const coinbase = transactions.length > 0 && 'height' in transactions[0] ? transactions[0] : null
            console.log(`Block ${hash} has coinbase ${coinbase}`)

            let utxoSet = object.previd != null ? await utxos.get(object.previd) : []
            let transactionFees = 0n
            console.log(`Building UTXO set for block ${hash}`)
            for (const [tx, txid, i] of transactions.map((e, i): [types.TransactionObject, string, number] => [e as types.TransactionObject, object.txids[i], i])) {
                console.log(`Current UTXO set: ${JSON.stringify(utxoSet)}, current transaction fees ${transactionFees}`)
                console.log(`Handling transaction #${i+1}: ${txid}`)
                utxoSet = updateUTXO(utxoSet, tx, (fee) => transactionFees += fee)
            }
            console.log(`Final UTXO set for block ${hash}: ${JSON.stringify(utxoSet)}, transaction fees ${transactionFees}`)
            utxos.put(hash, utxoSet)
            const height = await blockHeight(object, false)
            if (coinbase != null) {
                console.log(`Beginning coinbase verification for block ${hash}`)
                if (!hasUTXO(utxoSet, object.txids[0], 0)) {
                    console.log(`Coinbase transaction spent output within block ${hash}`)
                    throw new ProtocolError('INVALID_TX_OUTPOINT', `Cannot spend output of coinbase transaction within block`)
                } else {
                    console.log(`Coinbase transaction output not spent within block ${hash}`)
                }
                if (coinbase.outputs[0].value > transactionFees + BLOCK_REWARD) {
                    console.log(`Coinbase transaction steals too much in fees in block ${hash}`)
                    throw new ProtocolError('INVALID_BLOCK_COINBASE', `BlockhashObject(object) ${hash} reward of ${BigInt(coinbase.outputs[0].value) - transactionFees} (excluding transaction fees of ${transactionFees}) exceeds max reward of ${BLOCK_REWARD}`)
                } else {
                    console.log(`Coinbase transaction takes fair fees in block ${hash}`)
                }
                if (height != coinbase.height) {
                    console.log(`Coinbase transaction has incorrect height in block ${hash}`)
                    throw new ProtocolError('INVALID_BLOCK_COINBASE', `Block ${hash} has coinbase transaction with incorrect height`)
                } else {
                    console.log(`Coinbase transaction has correct height ${coinbase.height} in block ${hash}`)
                }
            } else {
                console.log(`No coinbase transaction to verify in block ${hash}`)
            }
            if (!await chaintip.exists(CHAINTIP) || height > (await chaintip.get(CHAINTIP)).height) {
                console.log(`CHAIN REORG! Block ${hash} is a new chaintip of height ${height}, beating out old chaintip ${await chaintip.exists(CHAINTIP) ? (await chaintip.get(CHAINTIP)).hash : null}`)
                const old_chaintip = await chaintip.exists(CHAINTIP) ? await chaintip.get(CHAINTIP) : null
                const new_chaintip = {hash: hash, block: object, height: height}
                console.log(`Computing new mempool after chain reorg to block ${hash}`)
                let newMempoolUTXOs = [...utxoSet]
                const transactionsToApply = [...await forgottenTransactions(old_chaintip, new_chaintip), ...mempoolTXs]
                console.log(`Transactions to apply in order on top of block ${hash} mempool: ${transactionsToApply}`)
                let newMempoolTXs: types.Hash[] = []
                console.log(`Cleared mempool for ${hash}`)
                for (const txid of transactionsToApply) {
                    [newMempoolUTXOs, newMempoolTXs] = attemptApplyTransaction(await db.get(txid) as types.TransactionObject, newMempoolUTXOs, newMempoolTXs, hash);
                }
                console.log(`New mempool for ${hash}: ${mempoolTXs}, UTXOs: ${JSON.stringify(mempoolUTXOs)}`)

                await chaintip.put(CHAINTIP, new_chaintip).then(() => {
                    mempoolUTXOs = newMempoolUTXOs
                    mempoolTXs = newMempoolTXs
                })
            }
            break
        case 'transaction':
            console.log(`Attempting to verify transaction ${hash}: ${canonicalize(object)}`)
            if ('inputs' in object && object.inputs != undefined && 'height' in object && object.height != undefined) {
                throw new ProtocolError('INVALID_FORMAT', `Transaction ${hash} is coinbase but has height`)
            } else if ('inputs' in object && object.inputs != undefined) {
                console.log(`Transaction ${hash} is not a coinbase`)
                let signableObject: { type: 'transaction', outputs: { value: number, pubkey: string, }[], inputs: { outpoint: { txid: string, index: number, }, sig: string | null, }[] }
                    = JSON.parse(JSON.stringify(object)) // deep copy hack
                for (const input of signableObject.inputs) {
                    input.sig = null
                }
                let signableText: string = canonicalize(signableObject)
                let totalInputValue: bigint = 0n
                for (const input of object.inputs) {
                    if (!await db.exists(input.outpoint.txid)) {
                        throw new ProtocolError('UNKNOWN_OBJECT', `Transaction ${input.outpoint.txid} not found.`)
                    }
                    const outpointOutput = await db.get(input.outpoint.txid)
                    if (outpointOutput.type != 'transaction') {
                        throw new ProtocolError('INVALID_TX_OUTPOINT', `Object ${input.outpoint.txid} is not a transaction.`)
                    }
                    if (input.outpoint.index >= outpointOutput.outputs.length) {
                        throw new ProtocolError('INVALID_TX_OUTPOINT', `Transaction ${input.outpoint.txid} has no output #${input.outpoint.index}.`)
                    }
                    const outpoint = outpointOutput.outputs[input.outpoint.index]
                    if (!await validateStringSignature(input.sig, signableText, outpoint.pubkey)) {
                        throw new ProtocolError('INVALID_TX_SIGNATURE', `Signature ${input.sig} is invalid.`)
                    }
                    totalInputValue += BigInt(outpoint.value)
                    console.log(`Validated input ${object.inputs.indexOf(input)} of transaction ${hash}`)
                }

                if (new Set(object.inputs.map((i) => JSON.stringify(i.outpoint))).size < object.inputs.length) {
                    throw new ProtocolError('INVALID_TX_CONSERVATION', `Transaction ${hash} has duplicate outpoints.`)
                }

                let totalOutputValue: bigint = 0n
                for (const output of object.outputs) {
                    totalOutputValue += BigInt(output.value)
                }
                if (totalInputValue < totalOutputValue) {
                    throw new ProtocolError('INVALID_TX_CONSERVATION', `Transaction ${hash} has more outputs than inputs`)
                }
            } else if ('height' in object && object.height != undefined) {
                console.log(`Transaction ${hash} is coinbase and therefore valid, however we won't attempt to add to mempool`)
            } else {
                throw new ProtocolError('INVALID_FORMAT', `Transaction ${hash} is neither coinbase nor regular transaction`)
            }
            break
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
    await Promise.all((['getpeers', 'getchaintip', 'getmempool'] as const)
                 .map((type) => sendMessage(socket, {type: type})))

    let buffer: string = ''
    let json: string = ''

    socket.stream.on('data', async (chunk) => {
        // console.log(`Received data ${chunk} from ${remoteAddress}`)
        try {
            buffer += chunk.toString(undefined, 0, MAX_MESSAGE_LENGTH)
            buffer = buffer.substring(0, MAX_MESSAGE_LENGTH)
            if (buffer.indexOf('\n') != -1) {
                clearTimeout(timeoutID)
            }
            while (buffer.indexOf('\n') != -1) {
                json = buffer.substring(0, buffer.indexOf('\n'))
                buffer = buffer.substring(buffer.indexOf('\n') + 1)

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
                        await validateObject(message.object)
                        console.log(`Validated object ${objectid} from ${remoteAddress}`)
                        if (!await db.exists(objectid)) {
                            await db.put(objectid, message.object)
                        }
                        objectReceivedEmitter.emit(objectid, message.object)
                        Promise.all(
                            [...sockets].map(async (receiverSocket) => {
                                console.log(`Sending ihaveobject ${objectid} to ${receiverSocket.stream.remoteAddress}`)
                                return sendMessage(receiverSocket, {
                                    type: 'ihaveobject',
                                    objectid: objectid
                                })
                            })
                        ).then(() => {})

                        if (message.object.type == 'transaction' && 'inputs' in message.object && message.object.inputs != undefined) {
                            const hash = hashObject(message.object)
                            console.log(`Attempting to add just-validated transaction ${hash} to mempool (because non-coinbase)`)
                            const [newMempoolUTXOs, newMempoolTXs] = applyTransaction(message.object, mempoolUTXOs, mempoolTXs)
                            mempoolUTXOs = newMempoolUTXOs
                            mempoolTXs = newMempoolTXs
                            console.log(`Succeeded to add just-validated transaction ${hash} to mempool, new mempool: ${mempoolTXs} and UTXOs: ${JSON.stringify(mempoolUTXOs)}`)
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
                        break
                    case 'chaintip':
                        console.log(`Recieved chaintip ${message.blockid} from ${remoteAddress}`)
                        await ensureObject(message.blockid)
                        break
                    case 'getchaintip':
                        console.log(`Received chaintip request from ${remoteAddress}`)
                        if (await chaintip.exists(CHAINTIP)) {
                            let tip = await chaintip.get(CHAINTIP)
                            console.log(`Sending chaintip ${JSON.stringify(tip)} to ${remoteAddress}`)
                            await sendMessage(socket, {type: 'chaintip', blockid: tip.hash})
                        } else {
                            console.log(`No chaintip found!`)
                        }
                        break
                    case 'mempool':
                        console.log(`Recieved mempool ${message.txids} from ${remoteAddress}`)
                        await Promise.all(message.txids.map(requestObject))
                        break
                    case 'getmempool':
                        console.log(`Sending mempool to ${remoteAddress}`)
                        await sendMessage(socket, {type: 'mempool', txids: mempoolTXs})
                        break
                }
            }
            if (buffer.length > 0) {
                timeoutID = addTimeout(socket)
                console.log(`Storing partial message '${buffer}' from ${remoteAddress}`)
            }
        } catch (err: any) {
            if (err instanceof ProtocolError) {
                await sendError(socket, err.errName, err.errDescription)
            } else if (err instanceof SyntaxError || err instanceof ZodError) {
                await sendError(socket, 'INVALID_FORMAT', `message:${json}, error:${'stack' in err ? err.stack : `${err.name}: ${err.message}`}`)
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

process.on('SIGINT', () => process.exit(0))