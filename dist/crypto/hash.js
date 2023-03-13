"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hash = void 0;
const blake2_1 = __importDefault(require("blake2"));
function hash(str) {
    const hash = blake2_1.default.createHash('blake2s');
    hash.update(Buffer.from(str));
    const hashHex = hash.digest('hex');
    return hashHex;
}
exports.hash = hash;
