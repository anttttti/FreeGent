// polyfills.ts — FreeGent: library methods that older iPads' Safari lacks (iPads stop getting
// updates at iPadOS 12/15/16 depending on model). A missing method throws mid-turn ("e.recent.findLast
// is not a function"), so they are defined here, first, before any other module runs. Syntax is
// handled by the build (esbuild target safari12) — except regex lookbehind and BigInt literals,
// which it cannot lower: tests/polyfills.test.ts fails if a lookbehind literal reaches the page.

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

// Safari < 13: Object.fromEntries 12.1, matchAll/allSettled 13, Blob.arrayBuffer/text 14.
def(Object, 'fromEntries', (it: Iterable<[PropertyKey, any]>) => { const o: any = {}; for (const [k, v] of it) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); return o; });
def(Promise, 'allSettled', (ps: Iterable<any>) => Promise.all([...ps].map(p => Promise.resolve(p).then(
    value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })))));
def(String.prototype, 'matchAll', function (this: string, re: RegExp | string) {
    if (re instanceof RegExp && !re.global) throw new TypeError('matchAll requires a global RegExp');
    const g = re instanceof RegExp ? new RegExp(re.source, re.flags) : new RegExp(String(re), 'g');
    if (re instanceof RegExp) g.lastIndex = re.lastIndex;
    const text = String(this);
    return (function* () { for (let m; (m = g.exec(text));) {
        yield m;
        if (m[0] === '') {
            const i = g.lastIndex;
            const hi = text.charCodeAt(i), lo = text.charCodeAt(i + 1);
            g.lastIndex += g.unicode && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1;
        }
    } })();
});
if (typeof Blob !== 'undefined') {
    const read = (b: Blob, how: 'readAsArrayBuffer' | 'readAsText') => new Promise<any>((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('Could not read blob')); r.onabort = () => rej(new DOMException('File reading cancelled', 'AbortError')); (r as any)[how](b);
    });
    def(Blob.prototype, 'arrayBuffer', function (this: Blob) { return read(this, 'readAsArrayBuffer'); });
    def(Blob.prototype, 'text', function (this: Blob) { return read(this, 'readAsText'); });
}

// Safari < 16 has no AbortSignal.timeout, < 17.4 no AbortSignal.any; the request path uses both.
if (typeof AbortSignal !== 'undefined' && typeof AbortController !== 'undefined') {
    // Old engines ignore abort(reason). Preserve it for retry/timeout classification.
    if (!('reason' in AbortSignal.prototype)) {
        const reasons = new WeakMap<AbortSignal, any>();
        const abort = AbortController.prototype.abort;
        Object.defineProperty(AbortSignal.prototype, 'reason', { configurable: true,
            get() { return this.aborted ? reasons.get(this) ?? new DOMException('Operation aborted', 'AbortError') : undefined; } });
        AbortController.prototype.abort = function (reason?: any) {
            if (!this.signal.aborted) reasons.set(this.signal, reason ?? new DOMException('Operation aborted', 'AbortError'));
            return abort.call(this);
        };
    }
    def(AbortSignal, 'timeout', (ms: number) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
        return c.signal;
    });
    def(AbortSignal, 'any', (signals: Iterable<AbortSignal>) => {
        const c = new AbortController();
        const listeners: [AbortSignal, () => void][] = [];
        const cleanup = () => { for (const [s, fn] of listeners) s.removeEventListener('abort', fn); listeners.length = 0; };
        const inputs = Array.from(signals);
        for (const s of inputs) {
            if (!s || typeof s.addEventListener !== 'function') throw new TypeError('Expected AbortSignal');
        }
        const aborted = inputs.find(s => s.aborted);
        if (aborted) { c.abort(aborted.reason); return c.signal; }
        for (const s of inputs) {
            const onAbort = () => { cleanup(); c.abort(s.reason); };
            listeners.push([s, onAbort]);
            s.addEventListener('abort', onAbort, { once: true });
        }
        return c.signal;
    });
}

// Safari < 15.4: no crypto.randomUUID (and no structuredClone — callers already fall back to JSON).
if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID !== 'function' && crypto.getRandomValues) {
    (crypto as any).randomUUID = () => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
}
if (typeof globalThis === 'undefined') (self as any).globalThis = self;

export {};
