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
exports.objectManager = exports.db = void 0;
const level_ts_1 = __importDefault(require("level-ts"));
const json_canonicalize_1 = require("json-canonicalize");
const message_1 = require("./message");
const transaction_1 = require("./transaction");
const block_1 = require("./block");
const logger_1 = require("./logger");
const hash_1 = require("./crypto/hash");
const promise_1 = require("./promise");
const mempool_1 = require("./mempool");
exports.db = new level_ts_1.default('./db');
const OBJECT_AVAILABILITY_TIMEOUT = 5000; // ms
class ObjectManager {
    constructor() {
        this.deferredObjects = {};
    }
    id(obj) {
        return (0, hash_1.hash)((0, json_canonicalize_1.canonicalize)(obj));
    }
    exists(objectid) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield exports.db.exists(`object:${objectid}`);
        });
    }
    get(objectid) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield exports.db.get(`object:${objectid}`);
            }
            catch (_a) {
                throw new message_1.AnnotatedError('UNKNOWN_OBJECT', `Object ${objectid} not known locally`);
            }
        });
    }
    del(objectid) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield exports.db.del(`object:${objectid}`);
            }
            catch (_a) {
                throw new message_1.AnnotatedError('UNKNOWN_OBJECT', `Object ${objectid} not known locally`);
            }
        });
    }
    put(object) {
        return __awaiter(this, void 0, void 0, function* () {
            const objectid = this.id(object);
            logger_1.logger.debug(`Storing object with id ${objectid}: %o`, object);
            if (objectid in this.deferredObjects) {
                for (const deferred of this.deferredObjects[objectid]) {
                    deferred.resolve(object);
                }
                delete this.deferredObjects[objectid];
            }
            return yield exports.db.put(`object:${this.id(object)}`, object);
        });
    }
    validate(object, peer) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield message_1.ObjectTxOrBlock.match((obj) => __awaiter(this, void 0, void 0, function* () {
                const tx = transaction_1.Transaction.fromNetworkObject(obj);
                logger_1.logger.debug(`Validating transaction: ${tx.txid}`);
                yield tx.validate();
                if (!tx.isCoinbase()) {
                    const success = yield mempool_1.mempool.onTransactionArrival(tx);
                    if (!success) {
                        throw new message_1.AnnotatedError('INVALID_TX_OUTPOINT', 'Failed to add invalid transaction to mempool');
                    }
                }
                return tx;
            }), (obj) => __awaiter(this, void 0, void 0, function* () {
                const block = yield block_1.Block.fromNetworkObject(obj);
                logger_1.logger.debug(`Validating block: ${block.blockid}`);
                yield block.validate(peer);
                return block;
            }))(object);
        });
    }
    retrieve(objectid, peer) {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.debug(`Retrieving object ${objectid}`);
            let object;
            const deferred = new promise_1.Deferred();
            if (!(objectid in this.deferredObjects)) {
                this.deferredObjects[objectid] = [];
            }
            this.deferredObjects[objectid].push(deferred);
            try {
                object = yield this.get(objectid);
                logger_1.logger.debug(`Object ${objectid} was already in database`);
                return object;
            }
            catch (e) { }
            logger_1.logger.debug(`Object ${objectid} not in database. Requesting it from peer ${peer.peerAddr}.`);
            yield peer.sendGetObject(objectid);
            object = yield Promise.race([
                (0, promise_1.resolveToReject)((0, promise_1.delay)(OBJECT_AVAILABILITY_TIMEOUT), `Timeout of ${OBJECT_AVAILABILITY_TIMEOUT}ms in retrieving object ${objectid} exceeded`),
                deferred.promise
            ]);
            logger_1.logger.debug(`Object ${objectid} was retrieved from peer ${peer.peerAddr}.`);
            return object;
        });
    }
}
exports.objectManager = new ObjectManager();
