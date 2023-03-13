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
exports.Peer = exports.NAME = void 0;
const logger_1 = require("./logger");
const semver_1 = __importDefault(require("semver"));
const message_1 = require("./message");
const peermanager_1 = require("./peermanager");
const json_canonicalize_1 = require("json-canonicalize");
const object_1 = require("./object");
const network_1 = require("./network");
const chain_1 = require("./chain");
const mempool_1 = require("./mempool");
const VERSION = '0.10.0';
exports.NAME = 'Overtaker (Malibu pset 5 fork, GitHub: arjvik/undertaker, branch pset6, commit {{GIT-HASH}})';
// Number of peers that each peer is allowed to report to us
const MAX_PEERS_PER_PEER = 30;
class Peer {
    sendHello() {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'hello',
                version: VERSION,
                agent: exports.NAME
            });
        });
    }
    sendGetPeers() {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'getpeers'
            });
        });
    }
    sendPeers() {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'peers',
                peers: [...peermanager_1.peerManager.knownPeers]
            });
        });
    }
    sendIHaveObject(obj) {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'ihaveobject',
                objectid: object_1.objectManager.id(obj)
            });
        });
    }
    sendObject(obj) {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'object',
                object: obj
            });
        });
    }
    sendGetObject(objid) {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'getobject',
                objectid: objid
            });
        });
    }
    sendGetChainTip() {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'getchaintip'
            });
        });
    }
    sendChainTip(blockid) {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'chaintip',
                blockid
            });
        });
    }
    sendGetMempool() {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'getmempool'
            });
        });
    }
    sendMempool(txids) {
        return __awaiter(this, void 0, void 0, function* () {
            this.sendMessage({
                type: 'mempool',
                txids
            });
        });
    }
    sendError(err) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                this.sendMessage(err.getJSON());
            }
            catch (error) {
                this.sendMessage(new message_1.AnnotatedError('INTERNAL_ERROR', `Failed to serialize error message: ${error}`).getJSON());
            }
        });
    }
    sendMessage(obj) {
        const message = (0, json_canonicalize_1.canonicalize)(obj);
        this.debug(`Sending message: ${message}`);
        this.socket.sendMessage(message);
    }
    fatalError(err) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.sendError(err);
            this.warn(`Peer error: ${err}`);
            this.fail();
        });
    }
    fail() {
        return __awaiter(this, void 0, void 0, function* () {
            this.active = false;
            this.socket.end();
            peermanager_1.peerManager.peerFailed(this.peerAddr);
        });
    }
    onConnect() {
        return __awaiter(this, void 0, void 0, function* () {
            this.active = true;
            yield this.sendHello();
            yield this.sendGetPeers();
            yield this.sendGetChainTip();
            yield this.sendGetMempool();
        });
    }
    onTimeout() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.fatalError(new message_1.AnnotatedError('INVALID_FORMAT', 'Timed out before message was complete'));
        });
    }
    onMessage(message) {
        return __awaiter(this, void 0, void 0, function* () {
            this.debug(`Message arrival: ${message}`);
            let msg;
            try {
                msg = JSON.parse(message);
                this.debug(`Parsed message into: ${JSON.stringify(msg)}`);
            }
            catch (_a) {
                return yield this.fatalError(new message_1.AnnotatedError('INVALID_FORMAT', `Failed to parse incoming message as JSON: ${message}`));
            }
            if (!message_1.Message.guard(msg)) {
                const validation = message_1.Message.validate(msg);
                return yield this.fatalError(new message_1.AnnotatedError('INVALID_FORMAT', `The received message does not match one of the known message formats: ${message}
         Validation error: ${JSON.stringify(validation)}`));
            }
            if (!this.handshakeCompleted) {
                if (message_1.HelloMessage.guard(msg)) {
                    return this.onMessageHello(msg);
                }
                return yield this.fatalError(new message_1.AnnotatedError('INVALID_HANDSHAKE', `Received message ${message} prior to "hello"`));
            }
            message_1.Message.match(() => __awaiter(this, void 0, void 0, function* () {
                return yield this.fatalError(new message_1.AnnotatedError('INVALID_HANDSHAKE', `Received a second "hello" message, even though handshake is completed`));
            }), this.onMessageGetPeers.bind(this), this.onMessagePeers.bind(this), this.onMessageIHaveObject.bind(this), this.onMessageGetObject.bind(this), this.onMessageObject.bind(this), this.onMessageGetChainTip.bind(this), this.onMessageChainTip.bind(this), this.onMessageGetMempool.bind(this), this.onMessageMempool.bind(this), this.onMessageError.bind(this))(msg);
        });
    }
    onMessageHello(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!semver_1.default.satisfies(msg.version, `^${VERSION}`)) {
                return yield this.fatalError(new message_1.AnnotatedError('INVALID_FORMAT', `You sent an incorrect version (${msg.version}), which is not compatible with this node's version ${VERSION}.`));
            }
            this.info(`Handshake completed. Remote peer running ${msg.agent} at protocol version ${msg.version}`);
            this.handshakeCompleted = true;
        });
    }
    onMessagePeers(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const peer of msg.peers.slice(0, MAX_PEERS_PER_PEER)) {
                this.info(`Remote party reports knowledge of peer ${peer}`);
                peermanager_1.peerManager.peerDiscovered(peer);
            }
            if (msg.peers.length > MAX_PEERS_PER_PEER) {
                this.info(`Remote party reported ${msg.peers.length} peers, but we processed only ${MAX_PEERS_PER_PEER} of them.`);
            }
        });
    }
    onMessageGetPeers(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            this.info(`Remote party is requesting peers. Sharing.`);
            yield this.sendPeers();
        });
    }
    onMessageIHaveObject(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            this.info(`Peer claims knowledge of: ${msg.objectid}`);
            if (!(yield object_1.objectManager.exists(msg.objectid))) {
                this.info(`Object ${msg.objectid} discovered`);
                yield this.sendGetObject(msg.objectid);
            }
        });
    }
    onMessageGetObject(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            this.info(`Peer requested object with id: ${msg.objectid}`);
            let obj;
            try {
                obj = yield object_1.objectManager.get(msg.objectid);
            }
            catch (e) {
                this.warn(`We don't have the requested object with id: ${msg.objectid}`);
                this.sendError(new message_1.AnnotatedError('UNKNOWN_OBJECT', `Unknown object with id ${msg.objectid}`));
                return;
            }
            yield this.sendObject(obj);
        });
    }
    onMessageObject(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            const objectid = object_1.objectManager.id(msg.object);
            let known = false;
            this.info(`Received object with id ${objectid}: %o`, msg.object);
            known = yield object_1.objectManager.exists(objectid);
            if (known) {
                this.debug(`Object with id ${objectid} is already known`);
            }
            else {
                this.info(`New object with id ${objectid} downloaded: %o`, msg.object);
                // store object even if it is invalid
                yield object_1.objectManager.put(msg.object);
            }
            let instance;
            try {
                instance = yield object_1.objectManager.validate(msg.object, this);
            }
            catch (e) {
                this.sendError(e);
                return;
            }
            if (!known) {
                // gossip
                network_1.network.broadcast({
                    type: 'ihaveobject',
                    objectid
                });
            }
        });
    }
    onMessageGetChainTip(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            if (chain_1.chainManager.longestChainTip === null) {
                this.warn(`Chain was not initialized when a peer requested it`);
                return;
            }
            this.sendChainTip(chain_1.chainManager.longestChainTip.blockid);
        });
    }
    onMessageChainTip(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            if (yield object_1.objectManager.exists(msg.blockid)) {
                return;
            }
            this.sendGetObject(msg.blockid);
        });
    }
    onMessageGetMempool(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            const txids = [];
            for (const tx of mempool_1.mempool.txs) {
                txids.push(tx.txid);
            }
            this.sendMempool(txids);
        });
    }
    onMessageMempool(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const txid of msg.txids) {
                object_1.objectManager.retrieve(txid, this); // intentionally delayed
            }
        });
    }
    onMessageError(msg) {
        return __awaiter(this, void 0, void 0, function* () {
            this.warn(`Peer reported error: ${msg.name}`);
        });
    }
    log(level, message, ...args) {
        logger_1.logger.log(level, `[peer ${this.socket.peerAddr}:${this.socket.netSocket.remotePort}] ${message}`, ...args);
    }
    warn(message, ...args) {
        this.log('warn', message, ...args);
    }
    info(message, ...args) {
        this.log('info', message, ...args);
    }
    debug(message, ...args) {
        this.log('debug', message, ...args);
    }
    constructor(socket, peerAddr) {
        this.active = false;
        this.handshakeCompleted = false;
        this.socket = socket;
        this.peerAddr = peerAddr;
        socket.netSocket.on('connect', this.onConnect.bind(this));
        socket.netSocket.on('error', err => {
            this.warn(`Socket error: ${err}`);
            this.fail();
        });
        socket.on('message', this.onMessage.bind(this));
        socket.on('timeout', this.onTimeout.bind(this));
    }
}
exports.Peer = Peer;
