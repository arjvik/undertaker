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
Object.defineProperty(exports, "__esModule", { value: true });
exports.chainManager = exports.Chain = void 0;
const block_1 = require("./block");
const logger_1 = require("./logger");
const mempool_1 = require("./mempool");
const miner_1 = require("./miner");
const object_1 = require("./object");
class ChainManager {
    constructor() {
        this.longestChainHeight = 0;
        this.longestChainTip = null;
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            let tip, height, inited = false;
            try {
                [tip, height] = yield object_1.db.get('longestchain');
                logger_1.logger.debug(`Retrieved cached longest chain tip ${tip.blockid} at height ${height}.`);
            }
            catch (_a) {
                tip = yield block_1.Block.makeGenesis();
                height = 0;
                logger_1.logger.debug(`No cached longest chain exists. Initializing to genesis ${tip.blockid} at height ${height}.`);
                inited = true;
            }
            this.longestChainTip = yield block_1.Block.fromNetworkObject(tip);
            this.longestChainHeight = height;
            if (inited) {
                yield miner_1.miner.buildCoinbase(height, this.longestChainTip.blockid);
                yield this.save();
            }
            logger_1.logger.debug(`Chain manager initialized.`);
        });
    }
    save() {
        return __awaiter(this, void 0, void 0, function* () {
            yield object_1.db.put('longestchain', [this.longestChainTip, this.longestChainHeight]);
        });
    }
    onValidBlockArrival(block) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!block.valid) {
                throw new Error(`Received onValidBlockArrival() call for invalid block ${block.blockid}`);
            }
            const height = block.height;
            if (this.longestChainTip === null) {
                throw new Error('We do not have a local chain to compare against');
            }
            if (height === undefined) {
                throw new Error(`We received a block ${block.blockid} we thought was valid, but had no calculated height.`);
            }
            if (height > this.longestChainHeight) {
                logger_1.logger.debug(`New longest chain has height ${height} and tip ${block.blockid}`);
                const [lca, shortFork, longFork] = yield Chain.getForks(this.longestChainTip, block);
                if (shortFork.blocks.length !== 0) {
                    logger_1.logger.info(`Reorged chain by abandoning a temporary fork of `
                        + `length ${shortFork.blocks.length}, `
                        + `tip ${this.longestChainTip.blockid}, `
                        + `and height ${this.longestChainHeight} and adopting a chain of `
                        + `height ${height} and tip ${block.blockid}.`);
                }
                this.longestChainHeight = height;
                this.longestChainTip = block;
                yield miner_1.miner.buildCoinbase(height, block.blockid);
                yield mempool_1.mempool.reorg(lca, shortFork, longFork);
                yield this.save();
            }
        });
    }
}
class Chain {
    constructor(blocks) {
        this.blocks = blocks;
    }
    // Given two blocks b1, b2, of which b2 belongs to the longer chain,
    // find the LCA block between the two respective chains and return an array of
    // 1. The LCA
    // 2. The fork LCA..b1
    // 3. The fork LCA..b2
    static getForks(b1, b2) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!b1.valid) {
                throw new Error(`Attempted to compare forks of blocks ${b1.blockid} and ${b2.blockid}, but ${b1.blockid} is invalid.`);
            }
            if (!b2.valid) {
                throw new Error(`Attempted to compare forks of blocks ${b1.blockid} and ${b2.blockid}, but ${b2.blockid} is invalid.`);
            }
            if (b1.blockid === b2.blockid) {
                return [b1, new Chain([]), new Chain([])];
            }
            const l1 = b1.height;
            const l2 = b2.height;
            if (l1 === null || l2 === null) {
                throw new Error('Attempting to get forks between chains with no known length');
            }
            const b2Parent = yield b2.loadParent();
            if (b2Parent === null) {
                throw new Error('Attempting to get forks between chains with no shared ancestor');
            }
            if (l1 === l2) {
                const b1Parent = yield b1.loadParent();
                if (b1Parent === null) {
                    throw new Error('Attempting to get forks between chains with no shared ancestor');
                }
                const [lca, b1Fork, b2Fork] = yield Chain.getForks(b1Parent, b2Parent);
                b1Fork.blocks.push(b1);
                b2Fork.blocks.push(b2);
                return [lca, b1Fork, b2Fork];
            }
            const [lca, shortFork, longFork] = yield Chain.getForks(b1, b2Parent);
            longFork.blocks.push(b2);
            return [lca, shortFork, longFork];
        });
    }
}
exports.Chain = Chain;
exports.chainManager = new ChainManager();
