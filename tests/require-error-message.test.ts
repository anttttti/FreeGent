// A module that fails to load inside the sandbox's node: on Safari the error's stack holds only frames (WebKit leaves the
// "SyntaxError: <message>" head out), so a script printing e.stack showed "Function@[native code]" and no error (chat log 45cdc500).
import { describe, it, expect } from 'vitest';
import { createRequireFunction } from '../shiro/node-compat/require.ts';

function load(src: string) {
    const fileCache = new Map([['/workspace/src/render.js', src]]);
    const req = createRequireFunction({
        ctx: { cwd: '/workspace', env: {}, fs: { resolvePath: (p: string, from: string) => (p.startsWith('/') ? p : `${from}/${p.replace(/^\.\//, '')}`) } } as any, fileCache, fileMtimes: new Map(), moduleCache: new Map(), pendingPromises: [],
        processEvents: {}, getBuiltinModule: () => null, fakeConsole: console, fakeProcess: { env: {}, cwd: () => '/workspace' },
        FakeBuffer: Buffer, createExpressShim: () => ({}), createSqliteShim: () => ({}), createAutoStub: (_p: string, t: any) => t,
    });
    try { req('./src/render.js', '/workspace'); return null; } catch (e: any) { return e; }
}

describe('a module that fails to load', () => {
    it('keeps the error name and message in the stack when the engine left them out (WebKit)', () => {
        const e = load("const e = new SyntaxError(\"Unexpected token '}'\"); e.stack = 'Function@[native code]\\n_requireModule@blob:null/1:36060:38'; throw e;");
        expect(e.message).toBe("Error loading module '/workspace/src/render.js': Unexpected token '}'");
        expect(e.stack).toMatch(/^Error loading module '\/workspace\/src\/render\.js':\nSyntaxError: Unexpected token '\}'\nFunction@\[native code\]/);
    });
    it('does not repeat a message the stack already starts with (V8)', () => {
        const e = load('}');
        expect(e.stack.split('\n')[1]).toMatch(/^SyntaxError: /);
        expect(e.stack.match(/SyntaxError: /g)).toHaveLength(1);
    });
});
