"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Block = exports.blockManager = exports.BlockManager = void 0;
const message_1 = require("./message");
const hash_1 = require("./crypto/hash");
const json_canonicalize_1 = require("json-canonicalize");
const object_1 = require("./object");
const util_1 = __importDefault(require("util"));
const utxo_1 = require("./utxo");
const logger_1 = require("./logger");
const transaction_1 = require("./transaction");
const chain_1 = require("./chain");
const promise_1 = require("./promise");
const TARGET = '00000000abc00000000000000000000000000000000000000000000000000000';
const GENESIS = {
    T: TARGET,
    created: 1671062400,
    miner: 'Marabu',
    nonce: '000000000000000000000000000000000000000000000000000000021bea03ed',
    note: 'The New York Times 2022-12-13: Scientists Achieve Nuclear Fusion Breakthrough With Blast of 192 Lasers',
    previd: null,
    txids: [],
    type: 'block'
};
const BU = 10 ** 12;
const BLOCK_REWARD = 50 * BU;
class BlockManager {
    constructor() {
        this.deferredValidations = {};
    }
}
exports.BlockManager = BlockManager;
exports.blockManager = new BlockManager();
class Block {
    static makeGenesis() {
        return __awaiter(this, void 0, void 0, function* () {
            const genesis = yield Block.fromNetworkObject(GENESIS);
            genesis.valid = true;
            genesis.stateAfter = new utxo_1.UTXOSet(new Set());
            genesis.height = 0;
            yield genesis.save();
            if (!(yield object_1.objectManager.exists(genesis.blockid))) {
                yield object_1.objectManager.put(genesis.toNetworkObject());
            }
            return genesis;
        });
    }
    static fromNetworkObject(object) {
        return __awaiter(this, void 0, void 0, function* () {
            const b = new Block(object.previd, object.txids, object.nonce, object.T, object.created, object.miner, object.note, object.studentids);
            // see if we can load block metadata from cache
            try {
                yield b.load();
            }
            catch (_a) { } // block metadata not cached
            return b;
        });
    }
    constructor(previd, txids, nonce, T, created, miner, note, studentids) {
        this.valid = false;
        this.previd = previd;
        this.txids = txids;
        this.nonce = nonce;
        this.T = T;
        this.created = created;
        this.miner = miner;
        this.note = note;
        this.studentids = studentids;
        this.blockid = (0, hash_1.hash)((0, json_canonicalize_1.canonicalize)(this.toNetworkObject()));
    }
    getCoinbase() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.txids.length === 0) {
                throw new Error('The block has no coinbase transaction');
            }
            const txid = this.txids[0];
            logger_1.logger.debug(`Checking whether ${txid} is the coinbase`);
            const obj = yield object_1.objectManager.get(txid);
            if (!message_1.TransactionObject.guard(obj)) {
                throw new Error('The block contains non-transaction txids');
            }
            const tx = transaction_1.Transaction.fromNetworkObject(obj);
            if (tx.isCoinbase()) {
                return tx;
            }
            throw new Error('The block has no coinbase transaction');
        });
    }
    toNetworkObject() {
        const netObj = {
            type: 'block',
            previd: this.previd,
            txids: this.txids,
            nonce: this.nonce,
            T: this.T,
            created: this.created,
            miner: this.miner,
        };
        if (this.note !== undefined) {
            netObj.note = this.note;
        }
        if (this.studentids !== undefined) {
            netObj.studentids = this.studentids;
        }
        return netObj;
    }
    hasPoW() {
        return BigInt(`0x${this.blockid}`) <= BigInt(`0x${TARGET}`);
    }
    isGenesis() {
        return this.previd === null;
    }
    getTxs(peer) {
        return __awaiter(this, void 0, void 0, function* () {
            const txPromises = [];
            let maybeTransactions = [];
            const txs = [];
            for (const txid of this.txids) {
                if (peer === undefined) {
                    txPromises.push(object_1.objectManager.get(txid));
                }
                else {
                    txPromises.push(object_1.objectManager.retrieve(txid, peer));
                }
            }
            try {
                maybeTransactions = yield Promise.all(txPromises);
            }
            catch (e) {
                throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Retrieval of transactions of block ${this.blockid} failed; rejecting block`);
            }
            logger_1.logger.debug(`We have all ${this.txids.length} transactions of block ${this.blockid}`);
            for (const maybeTx of maybeTransactions) {
                if (!message_1.TransactionObject.guard(maybeTx)) {
                    throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Block reports a transaction with id ${object_1.objectManager.id(maybeTx)}, but this is not a transaction.`);
                }
                const tx = transaction_1.Transaction.fromNetworkObject(maybeTx);
                txs.push(tx);
            }
            return txs;
        });
    }
    validateTx(peer, stateBefore, height) {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.debug(`Validating ${this.txids.length} transactions of block ${this.blockid}`);
            const stateAfter = stateBefore.copy();
            const txs = yield this.getTxs(peer);
            for (let idx = 0; idx < txs.length; idx++) {
                yield txs[idx].validate(idx, this);
            }
            yield stateAfter.applyMultiple(txs, this);
            logger_1.logger.debug(`UTXO state of block ${this.blockid} calculated`);
            let fees = 0;
            for (const tx of txs) {
                if (tx.fees === undefined) {
                    throw new message_1.AnnotatedError('INTERNAL_ERROR', `Transaction fees not calculated`);
                }
                fees += tx.fees;
            }
            this.fees = fees;
            let coinbase;
            try {
                coinbase = yield this.getCoinbase();
            }
            catch (e) { }
            if (coinbase !== undefined) {
                if (coinbase.outputs[0].value > BLOCK_REWARD + fees) {
                    throw new message_1.AnnotatedError('INVALID_BLOCK_COINBASE', `Coinbase transaction does not respect macroeconomic policy. `
                        + `Coinbase output was ${coinbase.outputs[0].value}, while reward is ${BLOCK_REWARD} and fees were ${fees}.`);
                }
                if (coinbase.height !== height) {
                    throw new message_1.AnnotatedError('INVALID_BLOCK_COINBASE', `Coinbase transaction ${coinbase.txid} of block ${this.blockid} indicates height ${coinbase.height}, `
                        + `while the block has height ${height}.`);
                }
            }
            this.stateAfter = stateAfter;
            logger_1.logger.debug(`UTXO state of block ${this.blockid} cached: ${JSON.stringify(Array.from(stateAfter.outpoints))}`);
        });
    }
    loadParent() {
        return __awaiter(this, void 0, void 0, function* () {
            let parentBlock;
            if (this.previd === null) {
                return null;
            }
            try {
                const parentObject = yield object_1.objectManager.get(this.previd);
                if (!message_1.BlockObject.guard(parentObject)) {
                    return null;
                }
                parentBlock = yield Block.fromNetworkObject(parentObject);
            }
            catch (e) {
                return null;
            }
            return parentBlock;
        });
    }
    validateAncestry(peer) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.previd === null) {
                // genesis
                return null;
            }
            let parentBlock;
            try {
                logger_1.logger.debug(`Retrieving parent block of ${this.blockid} (${this.previd})`);
                const parentObject = yield object_1.objectManager.retrieve(this.previd, peer);
                if (!message_1.BlockObject.guard(parentObject)) {
                    throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Got parent of block ${this.blockid}, but it was not of BlockObject type; rejecting block.`);
                }
                parentBlock = yield Block.fromNetworkObject(parentObject);
                try {
                    // try to load cached block information; this should have been cached
                    // as soon as the block was retrieved from the network and validated
                    yield parentBlock.load();
                    logger_1.logger.debug(`Parent block ${this.previd} of the block ${this.blockid} is already cached.`);
                }
                catch (_a) {
                    logger_1.logger.debug(`Awaiting validation of the parent block ${this.previd} of the block ${this.blockid}.`);
                    yield parentBlock.validate(peer);
                }
            }
            catch (e) {
                throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Retrieval of block parent for block ${this.blockid} failed; rejecting block: ${e.message}`);
            }
            return parentBlock;
        });
    }
    validate(peer) {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.debug(`Validating block ${this.blockid}`);
            if (exports.blockManager.deferredValidations[this.blockid] !== undefined) {
                logger_1.logger.debug(`Block ${this.blockid} is already pending validation. Waiting.`);
                const result = yield exports.blockManager.deferredValidations[this.blockid].promise;
                if (!result[0]) {
                    throw new message_1.AnnotatedError(result[1], `Block validation failure received through propagation.`);
                }
                yield this.load();
                return;
            }
            const deferred = exports.blockManager.deferredValidations[this.blockid] = new promise_1.Deferred();
            try {
                if (this.T !== TARGET) {
                    throw new message_1.AnnotatedError('INVALID_FORMAT', `Block ${this.blockid} does not specify the fixed target ${TARGET}, but uses target ${this.T} instead.`);
                }
                logger_1.logger.debug(`Block target for ${this.blockid} is valid`);
                if (!this.hasPoW()) {
                    throw new message_1.AnnotatedError('INVALID_BLOCK_POW', `Block ${this.blockid} does not satisfy the proof-of-work equation; rejecting block.`);
                }
                logger_1.logger.debug(`Block proof-of-work for ${this.blockid} is valid`);
                let parentBlock = null;
                let stateBefore;
                if (this.isGenesis()) {
                    this.height = 0;
                    if (!util_1.default.isDeepStrictEqual(this.toNetworkObject(), GENESIS)) {
                        throw new message_1.AnnotatedError('INVALID_GENESIS', `Invalid genesis block ${this.blockid}: ${JSON.stringify(this.toNetworkObject())}`);
                    }
                    logger_1.logger.debug(`Block ${this.blockid} is genesis block`);
                    // genesis state
                    stateBefore = new utxo_1.UTXOSet(new Set());
                    logger_1.logger.debug(`State before block ${this.blockid} is the genesis state`);
                }
                else {
                    parentBlock = yield this.validateAncestry(peer);
                    if (parentBlock === null) {
                        throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Parent block of block ${this.blockid} was null`);
                    }
                    logger_1.logger.debug(`Ancestry validation of ${this.blockid} successful.`);
                    const parentHeight = parentBlock.height;
                    if (parentHeight === undefined) {
                        throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `Parent block ${parentBlock.blockid} of block ${this.blockid} has no known height`);
                    }
                    if (parentBlock.created >= this.created) {
                        throw new message_1.AnnotatedError('INVALID_BLOCK_TIMESTAMP', `Parent block ${parentBlock.blockid} created at ${parentBlock.created} has future timestamp of `
                            + `block ${this.blockid} created at ${this.created}.`);
                    }
                    const currentUNIXtimestamp = Math.floor(new Date().getTime() / 1000);
                    if (this.created > currentUNIXtimestamp) {
                        throw new message_1.AnnotatedError('INVALID_BLOCK_TIMESTAMP', `Block ${this.blockid} has a timestamp ${this.created} in the future. `
                            + `Current time is ${currentUNIXtimestamp}.`);
                    }
                    this.height = parentHeight + 1;
                    logger_1.logger.debug(`Block ${this.blockid} has height ${this.height}.`);
                    // this block's starting state is the previous block's ending state
                    stateBefore = parentBlock.stateAfter;
                    logger_1.logger.debug(`Loaded state before block ${this.blockid}`);
                }
                logger_1.logger.debug(`Block ${this.blockid} has valid ancestry`);
                if (stateBefore === undefined) {
                    throw new message_1.AnnotatedError('UNFINDABLE_OBJECT', `We have not calculated the state of the parent block,`
                        + `so we cannot calculate the state of the current block with blockid = ${this.blockid}`);
                }
                logger_1.logger.debug(`State before block ${this.blockid} is ${stateBefore}`);
                yield this.validateTx(peer, stateBefore, this.height);
                logger_1.logger.debug(`Block ${this.blockid} has valid transactions`);
                this.valid = true;
                try {
                    yield this.save();
                    yield chain_1.chainManager.onValidBlockArrival(this);
                }
                catch (e) {
                    throw new message_1.AnnotatedError('INTERNAL_ERROR', 'Something went wrong is block saving or state calculations.');
                }
            }
            catch (e) {
                deferred.resolve([false, e.name]);
                delete exports.blockManager.deferredValidations[this.blockid];
                throw e;
            }
            deferred.resolve([true, '']);
            delete exports.blockManager.deferredValidations[this.blockid];
        });
    }
    save() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.stateAfter === undefined) {
                throw new Error(`Cannot save block ${this.blockid} with uncalculate state`);
            }
            yield object_1.db.put(`blockinfo:${this.blockid}`, {
                height: this.height,
                stateAfterOutpoints: Array.from(this.stateAfter.outpoints)
            });
            logger_1.logger.debug(`Stored valid block ${this.blockid} metadata.`);
        });
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.debug(`Loading block ${this.blockid} metadata.`);
            const { height, stateAfterOutpoints } = yield object_1.db.get(`blockinfo:${this.blockid}`);
            logger_1.logger.debug(`Block ${this.blockid} metadata loaded from database.`);
            this.height = height;
            this.stateAfter = new utxo_1.UTXOSet(new Set(stateAfterOutpoints));
            this.valid = true;
        });
    }
}
exports.Block = Block;
