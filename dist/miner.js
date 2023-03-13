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
exports.miner = void 0;
const child = __importStar(require("child_process"));
const json_canonicalize_1 = require("json-canonicalize");
const logger_1 = require("./logger");
const message_1 = require("./message");
const network_1 = require("./network");
const object_1 = require("./object");
const peer_1 = require("./peer");
class Miner {
    constructor() {
        this.minerProcess = null;
        this.height = null;
        this.coinbase = null;
        this.prevblock = null;
        this.block = null;
    }
    startMining() {
        var _a;
        logger_1.logger.debug(`Starting miner..., height=${this.height} block: ${JSON.stringify(this.block)}`);
        if (this.minerProcess !== null) {
            this.minerProcess.kill('SIGKILL');
        }
        this.block['nonce'] = '<<NONCE>>';
        const [prefix, suffix] = (0, json_canonicalize_1.canonicalize)(this.block).split('<<NONCE>>');
        this.minerProcess = child.spawn('./hasher', [prefix, suffix]);
        (_a = this.minerProcess.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (data) => {
            logger_1.logger.info(`Mined block ${data}`);
            const mined = message_1.BlockObject.check(JSON.parse(data));
            object_1.objectManager.put(mined);
            network_1.network.broadcast({
                type: 'ihaveobject',
                objectid: object_1.objectManager.id(mined)
            });
        });
    }
    buildCoinbase(height, prevBlock) {
        return __awaiter(this, void 0, void 0, function* () {
            const coinbase = {
                "type": "transaction",
                "height": height,
                "outputs": [
                    {
                        "pubkey": "ee37413dd87d1a056da15f6ebfef6a9dc1691f2828f02c69a58520098506aedc",
                        "value": 50000000000000
                    }
                ]
            };
            yield object_1.objectManager.put(coinbase);
            this.coinbase = object_1.objectManager.id(coinbase);
            network_1.network.broadcast({
                type: 'ihaveobject',
                objectid: this.coinbase
            });
            this.prevblock = prevBlock;
            this.height = height;
        });
    }
    setTransactions(txs) {
        var _a, _b;
        this.block = {
            "T": "00000000abc00000000000000000000000000000000000000000000000000000",
            "created": Math.floor(new Date().getTime() / 1000),
            "miner": peer_1.NAME,
            "nonce": "<<NONCE>>",
            "note": `Block Height: ${((_a = this.height) !== null && _a !== void 0 ? _a : -2) + 1}`,
            "previd": this.prevblock,
            "studentids": ["arjvik", "aalinur"],
            "txids": [(_b = this.coinbase) !== null && _b !== void 0 ? _b : '', ...txs],
            "type": "block"
        };
    }
}
exports.miner = new Miner();
