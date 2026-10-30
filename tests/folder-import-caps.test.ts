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
        expect(msg).toMatch(/Only the first 500 files were imported; 3 more were left out/);
        vi.unstubAllGlobals();
    }, 30000);
});
