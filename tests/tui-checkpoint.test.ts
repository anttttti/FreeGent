import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { takeSnapshot, restoreSnapshot, dropSnapshot, MAX_FILE_BYTES } from '../tui-checkpoint.ts';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('TUI checkpoints', () => {
    it('restores changed files, removes created ones and brings back deleted ones (case 022)', () => {
        const root = tmp('fg-ws-'), store = tmp('fg-ck-');
        writeFileSync(join(root, 'note.txt'), 'ORIGINAL');
        mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub', 'keep.txt'), 'KEEP');
        writeFileSync(join(root, 'gone.txt'), 'WILL BE DELETED');
        const snap = takeSnapshot(root, store, '1');
        expect(snap.files.sort()).toEqual(['gone.txt', 'note.txt', join('sub', 'keep.txt')].sort());
        // the turn
        writeFileSync(join(root, 'note.txt'), 'CHANGED');
        writeFileSync(join(root, 'created.txt'), 'NEW');
        mkdirSync(join(root, 'newdir')); writeFileSync(join(root, 'newdir', 'a.txt'), 'A');
        rmSync(join(root, 'gone.txt'));
        const r = restoreSnapshot(root, snap);
        expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('ORIGINAL');
        expect(readFileSync(join(root, 'gone.txt'), 'utf8')).toBe('WILL BE DELETED');
        expect(existsSync(join(root, 'created.txt'))).toBe(false);
        expect(existsSync(join(root, 'newdir'))).toBe(false);          // the emptied folder goes too
        expect(readFileSync(join(root, 'sub', 'keep.txt'), 'utf8')).toBe('KEEP');
        expect(r.restored.sort()).toEqual(['gone.txt', 'note.txt']);
        expect(r.removed.sort()).toEqual(['created.txt', join('newdir', 'a.txt')].sort());
    });
    it('leaves .git, node_modules and symlinks alone', () => {
        const root = tmp('fg-ws-'), store = tmp('fg-ck-');
        mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), 'ref');
        mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'x.js'), '1');
        writeFileSync(join(root, 'a.txt'), 'A');
        symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
        const snap = takeSnapshot(root, store, '1');
        expect(snap.files).toEqual(['a.txt']);
        writeFileSync(join(root, '.git', 'HEAD'), 'changed'); writeFileSync(join(root, 'node_modules', 'y.js'), '2');
        restoreSnapshot(root, snap);
        expect(readFileSync(join(root, '.git', 'HEAD'), 'utf8')).toBe('changed');   // not ours to touch
        expect(existsSync(join(root, 'node_modules', 'y.js'))).toBe(true);
    });
    it('a file over the size limit is neither copied nor removed, and is reported', () => {
        const root = tmp('fg-ws-'), store = tmp('fg-ck-');
        writeFileSync(join(root, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1, 1));
        writeFileSync(join(root, 'a.txt'), 'A');
        const snap = takeSnapshot(root, store, '1');
        expect(snap.skippedLarge).toEqual(['big.bin']);
        const r = restoreSnapshot(root, snap);
        expect(existsSync(join(root, 'big.bin'))).toBe(true);
        expect(r.skippedLarge).toEqual(['big.bin']);
    });
    it('an unusable snapshot is refused, not half-restored', () => {
        const root = tmp('fg-ws-'), store = tmp('fg-ck-');
        const snap = takeSnapshot(root, store, '1');
        snap.tooBig = true;
        expect(() => restoreSnapshot(root, snap)).toThrow(/too large/);
    });
    it('dropSnapshot removes the copies', () => {
        const root = tmp('fg-ws-'), store = tmp('fg-ck-');
        writeFileSync(join(root, 'a.txt'), 'A');
        const snap = takeSnapshot(root, store, '1');
        dropSnapshot(snap);
        expect(readdirSync(store)).toEqual([]);
    });
});
