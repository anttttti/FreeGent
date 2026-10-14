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
});
