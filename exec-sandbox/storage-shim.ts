// exec-sandbox/storage-shim.ts — in-memory Web Storage for the exec sandbox.
//
// The sandbox frame has an opaque origin, where touching localStorage/sessionStorage throws
// (even `typeof localStorage`) and IndexedDB is denied. The bundle build (dev-api.ts
// buildExecSandbox) rewrites every reference to them to these objects. Imported first by
// entry.ts so it exists before any shell module runs. Contents last for the page session only.

class MemStorage {
    private m = new Map<string, string>();
    get length(): number { return this.m.size; }
    key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
    getItem(k: string): string | null { return this.m.has(String(k)) ? this.m.get(String(k))! : null; }
    setItem(k: string, v: string): void { this.m.set(String(k), String(v)); }
    removeItem(k: string): void { this.m.delete(String(k)); }
    clear(): void { this.m.clear(); }
}

(globalThis as any).__fgMemStorage = new MemStorage();
(globalThis as any).__fgMemSession = new MemStorage();

// IndexedDB is denied in an opaque origin, and open() throws synchronously. The shell only uses it
// to cache downloaded binaries; this stand-in fails the way its code expects (an async onerror),
// so the caches are skipped instead of throwing.
(globalThis as any).__fgNoIndexedDB = {
    open() {
        const req: any = { error: new Error('IndexedDB is not available in the code sandbox'), result: null };
        setTimeout(() => req.onerror?.({ target: req }), 0);
        return req;
    },
};

export {};
