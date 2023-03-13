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
exports.peerManager = void 0;
const object_1 = require("./object");
const logger_1 = require("./logger");
const is_valid_hostname_1 = __importDefault(require("is-valid-hostname"));
const BOOTSTRAP_PEERS = ['45.63.84.226:18018', '45.63.89.228:18018', '144.202.122.8:18018'];
class PeerManager {
    constructor() {
        this.knownPeers = new Set();
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                this.knownPeers = new Set(yield object_1.db.get('peers'));
                logger_1.logger.debug(`Loaded known peers: ${[...this.knownPeers]}`);
            }
            catch (_a) {
                logger_1.logger.info(`Initializing peers database`);
                this.knownPeers = new Set(BOOTSTRAP_PEERS);
                yield this.store();
            }
        });
    }
    store() {
        return __awaiter(this, void 0, void 0, function* () {
            yield object_1.db.put('peers', [...this.knownPeers]);
        });
    }
    peerDiscovered(peerAddr) {
        const peerParts = peerAddr.split(':');
        if (peerParts.length !== 2) {
            logger_1.logger.warn(`Remote party reported knowledge of invalid peer ${peerAddr}, which is not in the host:port format; skipping`);
            return;
        }
        const [host, portStr] = peerParts;
        const port = +portStr;
        if (!(port >= 0 && port <= 65535)) {
            logger_1.logger.warn(`Remote party reported knowledge of peer ${peerAddr} with invalid port number ${port}`);
            return;
        }
        if (!(0, is_valid_hostname_1.default)(host)) {
            logger_1.logger.warn(`Remote party reported knowledge of invalid peer ${peerAddr}; skipping`);
            return;
        }
        this.knownPeers.add(peerAddr);
        this.store(); // intentionally delayed await
        logger_1.logger.info(`Known peers: ${this.knownPeers.size}`);
    }
    peerFailed(peerAddr) {
        logger_1.logger.warn(`Removing known peer, as it is considered faulty`);
        this.knownPeers.delete(peerAddr);
        this.store(); // intentionally delayed await
        logger_1.logger.info(`Known peers: ${this.knownPeers.size}`);
    }
}
exports.peerManager = new PeerManager();
