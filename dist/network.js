"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.network = exports.MessageSocket = void 0;
const net = __importStar(require("net"));
const logger_1 = require("./logger");
const peer_1 = require("./peer");
const events_1 = require("events");
const peermanager_1 = require("./peermanager");
const TIMEOUT_DELAY = 10000; // 10 seconds
const MAX_BUFFER_SIZE = 100 * 1024; // 100 kB
class Network {
    constructor() {
        this.peers = [];
    }
    init(bindPort, bindIP) {
        return __awaiter(this, void 0, void 0, function* () {
            yield peermanager_1.peerManager.load();
            const server = net.createServer(socket => {
                logger_1.logger.info(`New connection from peer ${socket.remoteAddress}`);
                const peer = new peer_1.Peer(new MessageSocket(socket, `${socket.remoteAddress}:${socket.remotePort}`), `${socket.remoteAddress}:${socket.remotePort}`);
                this.peers.push(peer);
                peer.onConnect();
            });
            logger_1.logger.info(`Listening for connections on port ${bindPort} and IP ${bindIP}`);
            server.listen(bindPort, bindIP);
            for (const peerAddr of peermanager_1.peerManager.knownPeers) {
                logger_1.logger.info(`Attempting connection to known peer ${peerAddr}`);
                try {
                    const peer = new peer_1.Peer(MessageSocket.createClient(peerAddr), peerAddr);
                    this.peers.push(peer);
                }
                catch (e) {
                    logger_1.logger.warn(`Failed to create connection to peer ${peerAddr}: ${e.message}`);
                }
            }
        });
    }
    broadcast(obj) {
        logger_1.logger.info(`Broadcasting object to all peers: %o`, obj);
        for (const peer of this.peers) {
            if (peer.active) {
                peer.sendMessage(obj); // intentionally delayed
            }
        }
    }
}
class MessageSocket extends events_1.EventEmitter {
    static createClient(peerAddr) {
        const [host, portStr] = peerAddr.split(':');
        const port = +portStr;
        if (port < 0 || port > 65535) {
            throw new Error('Invalid port');
        }
        const netSocket = new net.Socket();
        const socket = new MessageSocket(netSocket, peerAddr);
        netSocket.connect(port, host);
        return socket;
    }
    constructor(netSocket, peerAddr) {
        super();
        this.buffer = ''; // defragmentation buffer
        this.peerAddr = peerAddr;
        this.netSocket = netSocket;
        this.netSocket.on('data', (data) => {
            if (this.buffer.length > MAX_BUFFER_SIZE) {
                this.emit('timeout');
                return;
            }
            this.buffer += data;
            const messages = this.buffer.split('\n');
            if (messages.length > 1) {
                for (const message of messages.slice(0, -1)) {
                    this.emit('message', message);
                    if (this.timeout)
                        clearTimeout(this.timeout);
                }
                this.buffer = messages[messages.length - 1];
            }
            if (!this.timeout && this.buffer.length > 0) {
                this.timeout = setTimeout(() => {
                    this.emit('timeout');
                }, TIMEOUT_DELAY);
            }
        });
    }
    sendMessage(message) {
        this.netSocket.write(`${message}\n`);
    }
    end() {
        this.netSocket.end();
    }
}
exports.MessageSocket = MessageSocket;
exports.network = new Network();
