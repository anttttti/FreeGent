// polyfills.ts — FreeGent: ES2022/2023 array and string methods that Safari lacks before 15.4
// (older iPads stop receiving iPadOS updates there). A missing method throws mid-turn ("e.recent.findLast
// is not a function"), so they are defined here, first, before any other module runs.

const def = (proto: any, name: string, fn: Function) => {
    if (typeof proto[name] !== 'function') Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
};

function at(this: any, n: number) {
    const len = this.length >>> 0, i = Math.trunc(n) || 0, k = i < 0 ? len + i : i;
    return k < 0 || k >= len ? undefined : this[k];
}
def(Array.prototype, 'at', at);
def(String.prototype, 'at', at);
for (const T of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array])
    def(T.prototype, 'at', at);

def(Array.prototype, 'findLast', function (this: any[], pred: Function, thisArg?: any) {
    for (let i = this.length - 1; i >= 0; i--) if (pred.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
});
def(Array.prototype, 'findLastIndex', function (this: any[], pred: Function, thisArg?: any) {
    for (let i = this.length - 1; i >= 0; i--) if (pred.call(thisArg, this[i], i, this)) return i;
    return -1;
});
def(Object, 'hasOwn', (o: any, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k));
def(String.prototype, 'replaceAll', function (this: string, pat: any, rep: any) {
    if (pat instanceof RegExp) {
        if (!pat.global) throw new TypeError('replaceAll must be called with a global RegExp');
        return this.replace(pat, rep);
    }
    // A string pattern becomes an escaped global RegExp; `rep` keeps its $-patterns, as natively.
    return this.replace(new RegExp(String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), rep);
});

export {};
