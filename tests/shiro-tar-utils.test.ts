// npm package extraction keeps empty files (explorations Y009): a zero-length regular member is created or emptied, other zero-size members are not files.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarToFS } from '../shiro/utils/tar-utils';

const hasTar = spawnSync('tar', ['--version']).status === 0;
describe.skipIf(!hasTar)('extractTarToFS', () => {
    it('writes an empty regular member, and does not turn a hard link into an empty file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'tar-'));
        try {
            mkdirSync(join(dir, 'nested'));
            writeFileSync(join(dir, 'empty.txt'), ''); writeFileSync(join(dir, 'nested', 'empty2.txt'), ''); writeFileSync(join(dir, 'full.txt'), 'seventeen bytes!!');
            linkSync(join(dir, 'full.txt'), join(dir, 'link.txt'));
            const tar = new Uint8Array(spawnSync('tar', ['-cf', '-', '-C', dir, 'empty.txt', 'nested', 'full.txt', 'link.txt'], { maxBuffer: 1 << 24 }).stdout);
            const written = new Map<string, number>();
            await extractTarToFS(tar, '/pkg', { writeFile: async (p, d) => { written.set(p, d.length); }, mkdir: async () => {} });
            expect(Object.fromEntries(written)).toEqual({ '/pkg/empty.txt': 0, '/pkg/nested/empty2.txt': 0, '/pkg/full.txt': 17 });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
