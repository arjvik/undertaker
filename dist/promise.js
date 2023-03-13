"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveToReject = exports.delay = exports.Deferred = void 0;
class Deferred {
    constructor() {
        this.resolve = () => { };
        this.reject = () => { };
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
exports.Deferred = Deferred;
function delay(ms) {
    const deferred = new Deferred();
    setTimeout(() => deferred.resolve(), ms);
    return deferred.promise;
}
exports.delay = delay;
function resolveToReject(promise, reason) {
    const deferred = new Deferred();
    promise.then(() => {
        deferred.reject(new Error(reason));
    });
    promise.catch(() => {
        deferred.reject(new Error(reason));
    });
    return deferred.promise;
}
exports.resolveToReject = resolveToReject;
