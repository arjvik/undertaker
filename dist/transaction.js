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
exports.Transaction = exports.Input = exports.Outpoint = exports.Output = void 0;
const object_1 = require("./object");
const message_1 = require("./message");
const json_canonicalize_1 = require("json-canonicalize");
const signature_1 = require("./crypto/signature");
const logger_1 = require("./logger");
class Output {
    static fromNetworkObject(outputMsg) {
        return new Output(outputMsg.pubkey, outputMsg.value);
    }
    constructor(pubkey, value) {
        this.pubkey = pubkey;
        this.value = value;
    }
    toNetworkObject() {
        return {
            pubkey: this.pubkey,
            value: this.value
        };
    }
}
exports.Output = Output;
class Outpoint {
    static fromNetworkObject(outpoint) {
        return new Outpoint(outpoint.txid, outpoint.index);
    }
    constructor(txid, index) {
        this.txid = txid;
        this.index = index;
    }
    resolve() {
        return __awaiter(this, void 0, void 0, function* () {
            const refTxMsg = yield object_1.objectManager.get(this.txid);
            const refTx = Transaction.fromNetworkObject(refTxMsg);
            if (this.index >= refTx.outputs.length) {
                throw new message_1.AnnotatedError('INVALID_TX_OUTPOINT', `Invalid index reference ${this.index} for transaction ${this.txid}. The transaction only has ${refTx.outputs.length} outputs.`);
            }
            return refTx.outputs[this.index];
        });
    }
    toNetworkObject() {
        return {
            txid: this.txid,
            index: this.index
        };
    }
    toString() {
        return `<outpoint: (${this.txid}, ${this.index})>`;
    }
}
exports.Outpoint = Outpoint;
class Input {
    static fromNetworkObject(inputMsg) {
        return new Input(Outpoint.fromNetworkObject(inputMsg.outpoint), inputMsg.sig);
    }
    constructor(outpoint, sig = null) {
        this.outpoint = outpoint;
        this.sig = sig;
    }
    toNetworkObject() {
        return {
            outpoint: this.outpoint.toNetworkObject(),
            sig: this.sig
        };
    }
    toUnsigned() {
        return new Input(this.outpoint);
    }
}
exports.Input = Input;
class Transaction {
    static inputsFromNetworkObject(inputMsgs) {
        return inputMsgs.map(Input.fromNetworkObject);
    }
    static outputsFromNetworkObject(outputMsgs) {
        return outputMsgs.map(Output.fromNetworkObject);
    }
    static fromNetworkObject(txObj) {
        let inputs = [];
        let height = null;
        if (message_1.SpendingTransactionObject.guard(txObj)) {
            inputs = Transaction.inputsFromNetworkObject(txObj.inputs);
        }
        else {
            height = txObj.height;
        }
        const outputs = Transaction.outputsFromNetworkObject(txObj.outputs);
        return new Transaction(object_1.objectManager.id(txObj), inputs, outputs, height);
    }
    static byId(txid) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.fromNetworkObject(yield object_1.objectManager.get(txid));
        });
    }
    constructor(txid, inputs, outputs, height = null) {
        this.inputs = [];
        this.outputs = [];
        this.height = null;
        this.txid = txid;
        this.inputs = inputs;
        this.outputs = outputs;
        this.height = height;
    }
    isCoinbase() {
        return this.inputs.length === 0;
    }
    validate(idx, block) {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.debug(`Validating transaction ${this.txid}`);
            const unsignedTxStr = (0, json_canonicalize_1.canonicalize)(this.toNetworkObject(false));
            if (this.inputs.length === 0 && this.outputs.length === 0) {
                throw new message_1.AnnotatedError('INVALID_FORMAT', 'Non-coinbase transactions must have at least one input.');
            }
            if (this.isCoinbase()) {
                if (this.outputs.length > 1) {
                    throw new message_1.AnnotatedError('INVALID_FORMAT', `Invalid coinbase transaction ${this.txid}. Coinbase must have only a single output.`);
                }
                if (block !== undefined && idx !== undefined) {
                    // validating coinbase transaction in the context of a block
                    if (idx > 0) {
                        throw new message_1.AnnotatedError('INVALID_BLOCK_COINBASE', `Coinbase transaction ${this.txid} must be the first in block.`);
                    }
                }
                this.fees = 0;
                return;
            }
            let blockCoinbase;
            if (block !== undefined) {
                try {
                    blockCoinbase = yield block.getCoinbase();
                }
                catch (e) { }
            }
            const inputValues = yield Promise.all(this.inputs.map((input, i) => __awaiter(this, void 0, void 0, function* () {
                if (blockCoinbase !== undefined && input.outpoint.txid === blockCoinbase.txid) {
                    throw new message_1.AnnotatedError('INVALID_TX_OUTPOINT', `Transaction ${this.txid} is spending immature coinbase`);
                }
                const prevOutput = yield input.outpoint.resolve();
                if (input.sig === null) {
                    throw new message_1.AnnotatedError('INVALID_TX_SIGNATURE', `No signature available for input ${i} of transaction ${this.txid}`);
                }
                if (!(yield (0, signature_1.ver)(input.sig, unsignedTxStr, prevOutput.pubkey))) {
                    throw new message_1.AnnotatedError('INVALID_TX_SIGNATURE', `Signature validation failed for input ${i} of transaction ${this.txid}`);
                }
                return prevOutput.value;
            })));
            let sumInputs = 0;
            let sumOutputs = 0;
            logger_1.logger.debug(`Checking the law of conservation for transaction ${this.txid}`);
            for (const inputValue of inputValues) {
                sumInputs += inputValue;
            }
            logger_1.logger.debug(`Sum of inputs is ${sumInputs}`);
            for (const output of this.outputs) {
                sumOutputs += output.value;
            }
            logger_1.logger.debug(`Sum of outputs is ${sumOutputs}`);
            if (sumInputs < sumOutputs) {
                throw new message_1.AnnotatedError('INVALID_TX_CONSERVATION', `Transaction ${this.txid} does not respect the Law of Conservation. Inputs summed to ${sumInputs}, while outputs summed to ${sumOutputs}.`);
            }
            this.fees = sumInputs - sumOutputs;
            logger_1.logger.debug(`Transaction ${this.txid} pays fees ${this.fees}`);
            logger_1.logger.debug(`Transaction ${this.txid} is valid`);
        });
    }
    inputsUnsigned() {
        return this.inputs.map(input => input.toUnsigned().toNetworkObject());
    }
    toNetworkObject(signed = true) {
        const outputObjs = this.outputs.map(output => output.toNetworkObject());
        if (this.height !== null) {
            // coinbase
            return {
                type: 'transaction',
                outputs: outputObjs,
                height: this.height
            };
        }
        if (signed) {
            return {
                type: 'transaction',
                inputs: this.inputs.map(input => input.toNetworkObject()),
                outputs: outputObjs
            };
        }
        return {
            type: 'transaction',
            inputs: this.inputsUnsigned(),
            outputs: outputObjs
        };
    }
    toString() {
        return `<Transaction ${this.txid}>`;
    }
}
exports.Transaction = Transaction;
