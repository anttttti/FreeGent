// The browser shell's url module against Node's own (D033, D034): format of an ordinary object, file URLs with # and ? in a name, and the refusals.
import { describe, it, expect } from 'vitest';
import nodeUrl from 'node:url';
import { createUrlModule } from '../shiro/node-compat/modules/url.ts';

const m = createUrlModule();
const outcome = (f: () => unknown) => { try { return f(); } catch (e: any) { return `ERR ${e.code}`; } };

describe('url module matches Node', () => {
    it('format: strings, URL objects, parse results and hand-built field objects', () => {
        const cases: any[] = [{ protocol: 'https', host: 'a.com', pathname: '/x', search: '?q=1' }, {}, { toString: () => 'custom', pathname: '/p' },
            nodeUrl.parse('https://u:p@a.com:81/x/y?z=1#f'), { protocol: 'file', pathname: '/a/b' }, { hostname: 'h', pathname: 'x', query: 'a=1' },
            { protocol: 'http', host: 'h', query: { a: 1, b: 'x y' } }, 'http://x/y', new URL('http://q/r?s#t')];
        for (const c of cases) expect(m.format(c), JSON.stringify(c)).toBe((nodeUrl.format as any)(c));
    });
    it('pathToFileURL keeps # and ? in a file name as name; fileURLToPath reads the path alone and refuses what Node refuses', () => {
        for (const p of ['/a b', '/a#b?c', '/a%20b', '/é/日']) expect(m.pathToFileURL(p).href).toBe(nodeUrl.pathToFileURL(p).href);
        for (const u of ['file:///a%20b?x#y', 'file://localhost/a/b', 'file://host/a', 'file:///a%2Fb', 'http://x/a', 'a'])
            expect(outcome(() => m.fileURLToPath(u)), u).toBe(outcome(() => nodeUrl.fileURLToPath(u)));
    });
});
