"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Message = exports.Messages = exports.MempoolMessage = exports.GetMempoolMessage = exports.ChainTipMessage = exports.GetChainTipMessage = exports.ObjectMessage = exports.ObjectTxOrBlock = exports.IHaveObjectMessage = exports.GetObjectMessage = exports.PeersMessage = exports.GetPeersMessage = exports.HelloMessage = exports.BlockObject = exports.HumanReadable = exports.TransactionObject = exports.SpendingTransactionObject = exports.CoinbaseTransactionObject = exports.TransactionOutputObject = exports.TransactionInputObject = exports.OutpointObject = exports.AnnotatedError = exports.ErrorMessage = void 0;
const runtypes_1 = require("runtypes");
const Hash = runtypes_1.String.withConstraint(s => /^[0-9a-f]{64}$/.test(s));
const Sig = runtypes_1.String.withConstraint(s => /^[0-9a-f]{128}$/.test(s));
const PK = runtypes_1.String.withConstraint(s => /^[0-9a-f]{64}$/.test(s));
const NonNegative = runtypes_1.Number.withConstraint(n => n >= 0 && global.Number.isInteger(n));
const Coins = NonNegative;
const ErrorChoices = (0, runtypes_1.Union)((0, runtypes_1.Literal)('INTERNAL_ERROR'), (0, runtypes_1.Literal)('INVALID_FORMAT'), (0, runtypes_1.Literal)('UNKNOWN_OBJECT'), (0, runtypes_1.Literal)('UNFINDABLE_OBJECT'), (0, runtypes_1.Literal)('INVALID_HANDSHAKE'), (0, runtypes_1.Literal)('INVALID_TX_OUTPOINT'), (0, runtypes_1.Literal)('INVALID_TX_SIGNATURE'), (0, runtypes_1.Literal)('INVALID_TX_CONSERVATION'), (0, runtypes_1.Literal)('INVALID_BLOCK_COINBASE'), (0, runtypes_1.Literal)('INVALID_BLOCK_TIMESTAMP'), (0, runtypes_1.Literal)('INVALID_BLOCK_POW'), (0, runtypes_1.Literal)('INVALID_GENESIS'));
exports.ErrorMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('error'),
    name: ErrorChoices,
    description: runtypes_1.String
});
class AnnotatedError extends Error {
    constructor(name, description) {
        super(description);
        this.err = "";
        this.name = name;
        Object.setPrototypeOf(this, AnnotatedError.prototype);
    }
    getJSON() {
        const jsonError = { type: "error", name: this.name, description: this.message };
        if (exports.ErrorMessage.guard(jsonError)) {
            return jsonError;
        }
        else {
            return { type: "error", name: "INTERNAL_ERROR", description: "Something went wrong." };
        }
    }
}
exports.AnnotatedError = AnnotatedError;
exports.OutpointObject = (0, runtypes_1.Record)({
    txid: Hash,
    index: NonNegative
});
exports.TransactionInputObject = (0, runtypes_1.Record)({
    outpoint: exports.OutpointObject,
    sig: (0, runtypes_1.Union)(Sig, runtypes_1.Null)
});
exports.TransactionOutputObject = (0, runtypes_1.Record)({
    pubkey: PK,
    value: Coins
});
exports.CoinbaseTransactionObject = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('transaction'),
    outputs: (0, runtypes_1.Array)(exports.TransactionOutputObject).withConstraint(a => a.length <= 1),
    height: NonNegative
});
exports.SpendingTransactionObject = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('transaction'),
    inputs: (0, runtypes_1.Array)(exports.TransactionInputObject),
    outputs: (0, runtypes_1.Array)(exports.TransactionOutputObject)
});
exports.TransactionObject = (0, runtypes_1.Union)(exports.CoinbaseTransactionObject, exports.SpendingTransactionObject);
exports.HumanReadable = runtypes_1.String.withConstraint(s => s.length <= 128 &&
    s.match(/^[ -~]+$/) !== null // ASCII-printable
);
exports.BlockObject = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('block'),
    txids: (0, runtypes_1.Array)(Hash),
    nonce: runtypes_1.String,
    previd: (0, runtypes_1.Union)(Hash, runtypes_1.Null),
    created: NonNegative,
    T: Hash,
    miner: (0, runtypes_1.Optional)(exports.HumanReadable),
    note: (0, runtypes_1.Optional)(exports.HumanReadable),
    studentids: (0, runtypes_1.Optional)((0, runtypes_1.Array)(runtypes_1.String))
});
exports.HelloMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('hello'),
    version: runtypes_1.String,
    agent: runtypes_1.String
});
exports.GetPeersMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('getpeers')
});
exports.PeersMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('peers'),
    peers: (0, runtypes_1.Array)(runtypes_1.String)
});
exports.GetObjectMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('getobject'),
    objectid: Hash
});
exports.IHaveObjectMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('ihaveobject'),
    objectid: Hash
});
exports.ObjectTxOrBlock = (0, runtypes_1.Union)(exports.TransactionObject, exports.BlockObject);
exports.ObjectMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('object'),
    object: exports.ObjectTxOrBlock
});
exports.GetChainTipMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('getchaintip')
});
exports.ChainTipMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('chaintip'),
    blockid: Hash
});
exports.GetMempoolMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('getmempool')
});
exports.MempoolMessage = (0, runtypes_1.Record)({
    type: (0, runtypes_1.Literal)('mempool'),
    txids: (0, runtypes_1.Array)(runtypes_1.String)
});
exports.Messages = [
    exports.HelloMessage,
    exports.GetPeersMessage, exports.PeersMessage,
    exports.IHaveObjectMessage, exports.GetObjectMessage, exports.ObjectMessage,
    exports.GetChainTipMessage, exports.ChainTipMessage,
    exports.GetMempoolMessage, exports.MempoolMessage,
    exports.ErrorMessage
];
exports.Message = (0, runtypes_1.Union)(exports.HelloMessage, exports.GetPeersMessage, exports.PeersMessage, exports.IHaveObjectMessage, exports.GetObjectMessage, exports.ObjectMessage, exports.GetChainTipMessage, exports.ChainTipMessage, exports.GetMempoolMessage, exports.MempoolMessage, exports.ErrorMessage);
