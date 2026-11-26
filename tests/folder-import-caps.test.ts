// codex R201: a folder import that left files out for size or for the 500-file cap said so only in the console.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
const W = globalThis as any;

beforeAll(async () => { globalThis.indexedDB = new IDBFactory(); await W.initDB(); });

const file = (rel: string, size?: number) => {
    const f = new File(['x'], rel.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    if (size) Object.defineProperty(f, 'size', { value: size });
    return f;
};

describe('folder import caps', () => {
    it('names the files left out for size and says how many the count cap left out', async () => {
        const alert = vi.fn(); vi.stubGlobal('alert', alert);
        const files = [file('proj/big.bin', 11 * 1024 * 1024), ...Array.from({ length: 503 }, (_, i) => file(`proj/f${i}.txt`))];
        W.uploadFiles(true);
        const input = document.body.querySelector('input[type=file]') as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: files });
        await (input.onchange as any)();
        await vi.waitFor(() => expect(alert).toHaveBeenCalled(), { timeout: 20000 });
        const msg = alert.mock.calls.map(c => c[0]).join('\n');
        expect(msg).toMatch(/1 file was not imported because it is larger than 10 MB:\nproj\/big\.bin/);
        expect(msg).toMatch(/Only the first 500 files were selected for import[^;]*; 3 more were left out/);
        vi.unstubAllGlobals();
    }, 30000);

    it('picking a folder called `out` imports what is in it, and a build folder inside a picked folder is still skipped (review of fe38c85)', async () => {
        vi.stubGlobal('alert', vi.fn());
        const files = ['out/report.md', 'out/sub/a.txt', 'out/node_modules/x.js', 'out/vendor/y.js'].map(rel => { const f: any = file(rel); f.arrayBuffer = async () => new TextEncoder().encode('x').buffer; return f; });
        W.uploadFiles(true);
        const input = document.body.querySelector('input[type=file]') as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: files });
        await (input.onchange as any)();
        await vi.waitFor(async () => expect((await W.agentListFiles()).map((f: any) => f.name)).toContain('out/report.md'), { timeout: 20000 });
        const names = (await W.agentListFiles()).map((f: any) => f.name);
        expect(names).toContain('out/sub/a.txt');
        expect(names).not.toContain('out/node_modules/x.js');
        expect(names).not.toContain('out/vendor/y.js');
        vi.unstubAllGlobals();
    }, 30000);
});
