// Checkpoint restore (review 2026-10-14, opencode M11 and uploads 7.2): binary records keep their
// encoding tag across a restore, and a failed restore puts the workspace back as it was.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

const W = window as any;

beforeAll(async () => {
    W.indexedDB = new IDBFactory();
    await import('../workspace.ts');
});
afterEach(() => vi.restoreAllMocks());

const read = async (n: string) => { const r = await W.readWorkspaceFile(n); return r ? { content: r.content, encoding: r.encoding ?? null } : null; };
const names = async () => (await W.listWorkspaceFiles()).map((r: any) => r.name).sort();

describe('restoreCheckpointWorkspace', () => {
    it('restores text and binary records, removes later files, and keeps the base64 tag', async () => {
        await W.writeWorkspaceFile('a.txt', 'A');
        await W.writeWorkspaceFile('img.png', 'iVBORw0KGgo=', null, 'base64');
        await W.saveCheckpointSnapshot('chat-r', '1000');
        await W.writeWorkspaceFile('a.txt', 'B');
        await W.writeWorkspaceFile('img.png', 'not an image any more');       // text under the same name
        await W.writeWorkspaceFile('later.txt', 'L');
        await W.saveCheckpointSnapshot('chat-r', '2000');

        await W.restoreCheckpointWorkspace('chat-r', '1000');
        expect(await read('a.txt')).toEqual({ content: 'A', encoding: null });
        expect(await read('img.png')).toEqual({ content: 'iVBORw0KGgo=', encoding: 'base64' });
        expect(await names()).toEqual(['a.txt', 'img.png']);
    });

    it('puts the workspace back when a write fails part-way', async () => {
        await W.writeWorkspaceFile('a.txt', 'A');
        await W.writeWorkspaceFile('boom.txt', 'X');
        await W.saveCheckpointSnapshot('chat-f', '1000');
        await W.writeWorkspaceFile('a.txt', 'NEW');
        await W.writeWorkspaceFile('z.txt', 'Z');
        await W.deleteWorkspaceFile('boom.txt');
        const before = await names();

        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: any, value: any, key?: any) {
            if (value?.name === 'boom.txt') throw new Error('quota exceeded');
            return put.call(this, value, key);
        });
        await expect(W.restoreCheckpointWorkspace('chat-f', '1000')).rejects.toThrow('quota exceeded');
        vi.restoreAllMocks();

        expect(await read('a.txt')).toEqual({ content: 'NEW', encoding: null });
        expect(await read('z.txt')).toEqual({ content: 'Z', encoding: null });
        expect(await names()).toEqual(before);
    });

    it('restores with one transaction for all its writes and deletes', async () => {
        await W.writeWorkspaceFile('a.txt', 'A');
        await W.writeWorkspaceFile('gone.txt', 'G');
        await W.saveCheckpointSnapshot('chat-t', '1000');
        await W.writeWorkspaceFile('a.txt', 'NEW');
        await W.deleteWorkspaceFile('gone.txt');
        await W.writeWorkspaceFile('only-later.txt', 'Z');
        const before = { a: await read('a.txt'), names: await names() };
        const txs: any[] = [];
        // the restore must use one write transaction for its writes and deletes
        const open = IDBObjectStore.prototype.put; let writes = 0;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: any, value: any, key?: any) {
            if (value?.name) { writes++; txs.push(this.transaction); }
            return open.call(this, value, key);
        });
        await W.restoreCheckpointWorkspace('chat-t', '1000');
        vi.restoreAllMocks();
        expect(writes).toBeGreaterThanOrEqual(2);                  // every file of the snapshot (earlier tests' files are in it too)
        expect(new Set(txs).size).toBe(1);                         // one transaction for all of them
        expect(await read('a.txt')).toEqual({ content: 'A', encoding: null });
        expect(await names()).toContain('gone.txt');
        expect(await names()).not.toContain('only-later.txt');
        expect(before.a).toEqual({ content: 'NEW', encoding: null });
    });
});

describe('checkpoint snapshots of one chat', () => {
    it('a snapshot with a smaller id than the one before it still replays after it', async () => {
        await W.writeWorkspaceFile('h.txt', 'H');                  // unchanged between the two snapshots: only the first one's delta holds it
        await W.writeWorkspaceFile('f.txt', 'v1');
        await W.saveCheckpointSnapshot('chat-o', '2000');
        await W.writeWorkspaceFile('f.txt', 'v2');
        await W.saveCheckpointSnapshot('chat-o', '1000');          // earlier by number, taken later (a post-turn id, a clock step back)
        await W.writeWorkspaceFile('f.txt', 'v3'); await W.writeWorkspaceFile('x.txt', 'X');
        await W.restoreCheckpointWorkspace('chat-o', '1000');
        expect(await read('f.txt')).toEqual({ content: 'v2', encoding: null });
        expect(await read('h.txt')).toEqual({ content: 'H', encoding: null });   // came from the first snapshot's delta
        expect(await names()).toEqual(expect.not.arrayContaining(['x.txt']));
    });
    it('overlapping saves for one chat run one after the other, in the order they were started', async () => {
        await W.writeWorkspaceFile('p.txt', 'P');
        const done: string[] = [];
        const a = W.saveCheckpointSnapshot('chat-q', '3000').then(() => done.push('a'));
        const b = W.saveCheckpointSnapshot('chat-q', '2500').then(() => done.push('b'));
        const c = W.saveCheckpointSnapshot('chat-q', 'post_1_x').then(() => done.push('c'));
        await Promise.all([a, b, c]);
        expect(done).toEqual(['a', 'b', 'c']);
        const rows = (await W.getCheckpointDiff('chat-q', 'post_1_x'));
        expect(rows).toBeTruthy();
        await W.restoreCheckpointWorkspace('chat-q', 'post_1_x');
        expect(await read('p.txt')).toEqual({ content: 'P', encoding: null });
    });
    it('a failed save does not stop the ones queued behind it', async () => {
        const first = W.saveCheckpointSnapshot('chat-e', '1000');
        const spy = vi.spyOn(W, 'listWorkspaceFiles');
        void spy;
        await first;
        await expect(W.saveCheckpointSnapshot('chat-e', '2000')).resolves.toBeUndefined();
    });
});
