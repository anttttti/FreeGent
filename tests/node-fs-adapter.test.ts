import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFsAdapter } from '../node-fs-adapter.js';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fg-nfa-'));
    for (const d of ['src/deep/er/est/x', 'node_modules/pkg', '.hidden']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'hello');
    writeFileSync(join(root, 'src/b.ts'), 'export {}');
    writeFileSync(join(root, 'src/deep/er/est/x/too-deep.txt'), 'x');
    writeFileSync(join(root, 'node_modules/pkg/i.js'), 'x');
    writeFileSync(join(root, '.hidden/h.txt'), 'x');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(root, 'doc.pdf'), Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from([0])]));
    return new NodeFsAdapter(root);
}
const names = (l: any[]) => l.map(f => f.name).sort();

describe('NodeFsAdapter listing (shared walker)', () => {
    it('agentListFiles skips noise and dot dirs and reports size/mtime', async () => {
        const l = await fixture().agentListFiles();
        expect(names(l)).toEqual(['a.txt', 'bin.dat', 'doc.pdf', 'src/b.ts', 'src/deep/er/est/x/too-deep.txt']);
        const a = l.find(f => f.name === 'a.txt')!;
        expect(a.size).toBe(5);
        expect(a.lastModified).toBeGreaterThan(0);
    });
    it('agentListFilesNoStat caps the depth and has no stat fields', async () => {
        const l = await fixture().agentListFilesNoStat(2);
        expect(names(l)).toEqual(['a.txt', 'bin.dat', 'doc.pdf', 'src/b.ts']);
        expect(l[0]).toEqual({ name: l[0].name });
    });
    it('agentListFilesInDir lists one subtree without the noise filter', async () => {
        expect(names(await fixture().agentListFilesInDir('node_modules'))).toEqual(['pkg/i.js']);
    });
});

describe('NodeFsAdapter agentReadFile', () => {
    it('reads text, and gives a typed hint for binary files', async () => {
        const fs = fixture();
        expect(await fs.agentReadFile('a.txt')).toBe('hello');
        await expect(fs.agentReadFile('bin.dat')).rejects.toThrow(/Binary file.*file "bin.dat"/);
        await expect(fs.agentReadFile('doc.pdf')).rejects.toThrow(/pdftotext "doc.pdf"/);
        await expect(fs.agentReadFile('missing.txt')).rejects.toThrow(/File not found: missing.txt/);
    });
});
