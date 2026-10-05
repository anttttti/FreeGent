// The polyfills must behave like the natives they stand in for. Each is checked by deleting the
// native, loading the module, and comparing — so the fallback itself is what runs.
describe('polyfills', () => {
    const saved: Record<string, any> = {};
    beforeAll(async () => {
        for (const [o, n] of [[Array.prototype, 'at'], [Array.prototype, 'findLast'], [Array.prototype, 'findLastIndex'], [String.prototype, 'at'], [String.prototype, 'replaceAll'], [Object, 'hasOwn']] as any) {
            saved[`${o === Object ? 'O' : o === Array.prototype ? 'A' : 'S'}.${n}`] = o[n];
            delete o[n];
        }
        await import('../polyfills.ts');
    });
    it('Array findLast / findLastIndex / at', () => {
        expect([1, 2, 3, 4].findLast(x => x % 2)).toBe(3);
        expect([1, 2].findLast(x => x > 5)).toBeUndefined();
        expect([1, 2, 3, 2].findLastIndex(x => x === 2)).toBe(3);
        expect([1, 2, 3].at(-1)).toBe(3);
        expect([1, 2, 3].at(0)).toBe(1);
        expect([1, 2, 3].at(-4)).toBeUndefined();
        expect('abc'.at(-1)).toBe('c');
    });
    it('replaceAll and hasOwn', () => {
        expect('a.b.c'.replaceAll('.', '-')).toBe('a-b-c');
        expect('a$b$'.replaceAll('$', '$$')).toBe('a$b$');   // "$$" in the replacement means one "$", natively too
        expect('a.b'.replaceAll('.', (m: string) => m + m)).toBe('a..b');
        expect('aXbX'.replaceAll(/x/gi, '_')).toBe('a_b_');
        expect(() => 'a'.replaceAll(/a/, 'b')).toThrow(TypeError);
        expect(Object.hasOwn({ a: 1 }, 'a')).toBe(true);
        expect(Object.hasOwn({}, 'toString')).toBe(false);
    });
});

// Syntax the build cannot lower and an older Safari rejects at parse time, which stops every module
// that imports the file. Shipped = everything the page (or its static import graph) can load.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

describe('no unsupported syntax in page code', () => {
    const root = join(__dirname, '..');
    const skip = /^(tests|bench|docs|scripts|work|cf-worker|smoke|node_modules|dist|public|\.)/;
    const files: string[] = [];
    const walk = (d: string) => {
        for (const e of readdirSync(d)) {
            const p = join(d, e), rel = relative(root, p);
            if (skip.test(rel) || /^(fg-tui|tui-app|headless|dev-api|native-exec|vite\.config|vitest)/.test(rel)) continue;
            if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|js)$/.test(e)) files.push(rel);
        }
    };
    walk(root);
    // Sandbox/worker bundles are built for es2020 (own frame); the wasm/x86 runtime needs BigInt anyway.
    const bundled = /^(shiro\/(x86|wasi-runtime|wasi-host|wasi-worker|wasm-module)|exec-sandbox\/|pyodide-worker)/;

    it('has no regex-literal lookbehind (Safari < 16.4 SyntaxError)', () => {
        const bad = files.filter(f => !bundled.test(f)).flatMap(f => readFileSync(join(root, f), 'utf8').split('\n')
            .map((l, i) => ({ f, i: i + 1, l }))
            .filter(({ l }) => /\/(?:[^/\n\\]|\\.)*\(\?<[=!](?:[^/\n\\]|\\.)*\/[dgimsuy]*/.test(l) && !/^\s*(\/\/|\*)/.test(l))
            .map(({ f, i }) => `${f}:${i}`));
        expect(bad).toEqual([]);
    });
});
