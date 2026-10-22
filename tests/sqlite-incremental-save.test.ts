// A save of the chat's history writes only from the first message that differs (it used to delete and insert all of them: 40-120 ms of blocked
// event loop for a 2-6 MB conversation, many times per turn).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');
import { NodeSqliteAdapter } from '../node-sqlite-adapter.ts';

const dirs: string[] = [];
function setup() {
    const d = mkdtempSync(join(tmpdir(), 'fg-sql-')); dirs.push(d);
    const path = join(d, 's.db');
    return { path, a: new NodeSqliteAdapter(path), peek: (): any => new DatabaseSync(path) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const msg = (i: number, extra: any = {}) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}`, ...extra });
const ids = (db: any, chat = 'c1') => (db.prepare('SELECT id FROM messages WHERE chat_id = ? AND raw = 0 ORDER BY seq').all(chat) as any[]).map(r => r.id);

describe('replaceMessages', () => {
    it('appending writes only the new messages: the stored ones keep their rows', async () => {
        const { a, peek } = setup();
        const h = [msg(0), msg(1), msg(2)];
        await a.replaceMessages('c1', h);
        const db = peek(); const before = ids(db);
        await a.replaceMessages('c1', [...h, msg(3), msg(4)]);
        const after = ids(db);
        expect(after.slice(0, 3)).toEqual(before);                          // not deleted and inserted again
        expect(after.length).toBe(5);
        expect(await a.loadHistory('c1')).toEqual([...h, msg(3), msg(4)]);
    });
    it('a message changed in the middle (a tool result trimmed) is written again from there on', async () => {
        const { a, peek } = setup();
        const h = [msg(0), msg(1), { role: 'tool', content: 'x'.repeat(50), tool_call_id: 't' }, msg(3)];
        await a.replaceMessages('c1', h);
        const db = peek(); const before = ids(db);
        const h2 = [h[0], h[1], { role: 'tool', content: 'x'.repeat(10) + '[trimmed]', tool_call_id: 't' }, h[3]];
        await a.replaceMessages('c1', h2);
        const after = ids(db);
        expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
        expect(after[2]).not.toBe(before[2]);
        expect(await a.loadHistory('c1')).toEqual(h2);
    });
    it('a same-length edit in the middle, tool calls and array content are noticed too', async () => {
        const { a } = setup();
        const h: any[] = [msg(0), { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"A"}' } }] },
            { role: 'user', content: [{ type: 'text', text: 'see' }] }];
        await a.replaceMessages('c1', h);
        const h2: any[] = [msg(0), { ...h[1], tool_calls: [{ ...h[1].tool_calls[0], function: { name: 'read_file', arguments: '{"path":"B"}' } }] }, { role: 'user', content: [{ type: 'text', text: 'saw' }] }];
        await a.replaceMessages('c1', h2);
        expect(await a.loadHistory('c1')).toEqual(h2);
    });
    it('a shorter history (a rewind) removes the tail', async () => {
        const { a } = setup();
        await a.replaceMessages('c1', [msg(0), msg(1), msg(2), msg(3)]);
        await a.replaceMessages('c1', [msg(0), msg(1)]);
        expect(await a.loadHistory('c1')).toEqual([msg(0), msg(1)]);
        await a.replaceMessages('c1', [msg(0), msg(1), msg(9)]);
        expect(await a.loadHistory('c1')).toEqual([msg(0), msg(1), msg(9)]);
        await a.replaceMessages('c1', []);
        expect(await a.loadHistory('c1')).toBeNull();
    });
    it('rows another process changed are not trusted: the chat is written in full again', async () => {
        const { a, path, peek } = setup();
        await a.replaceMessages('c1', [msg(0), msg(1), msg(2)]);
        const other = peek(); other.exec("DELETE FROM messages WHERE chat_id = 'c1' AND seq = 1"); other.close();
        await a.replaceMessages('c1', [msg(0), msg(1), msg(2), msg(3)]);
        expect(await a.loadHistory('c1')).toEqual([msg(0), msg(1), msg(2), msg(3)]);
        void path;
    });
    it('after a compaction the next save starts from the new generation', async () => {
        const { a } = setup();
        const pre = [msg(0), msg(1), msg(2), msg(3)];
        await a.replaceMessages('c1', pre);
        const post = [msg(0), { role: 'user', content: '[SYSTEM: compacted]' }];
        await a.compactHistory('c1', pre, post);
        await a.replaceMessages('c1', [...post, msg(7)]);
        expect(await a.loadHistory('c1')).toEqual([...post, msg(7)]);
    });
    it('a deleted chat that is saved again is written in full', async () => {
        const { a } = setup();
        await a.replaceMessages('c1', [msg(0), msg(1)]);
        await a.deleteChat('c1');
        await a.replaceMessages('c1', [msg(0), msg(1), msg(2)]);
        expect(await a.loadHistory('c1')).toEqual([msg(0), msg(1), msg(2)]);
    });
    it('an unchanged history writes nothing, and a large one is cheap to save again', async () => {
        const { a, peek } = setup();
        const h = Array.from({ length: 600 }, (_, i) => i % 3 === 2 ? { role: 'tool', content: 't'.repeat(20 * 1024), tool_call_id: 'x' } : msg(i));
        await a.replaceMessages('c1', h);
        const db = peek(); const before = ids(db);
        const t0 = performance.now();
        await a.replaceMessages('c1', [...h, msg(600)]);
        const ms = performance.now() - t0;
        expect(ids(db).slice(0, 600)).toEqual(before);
        expect(ms).toBeLessThan(60);                                        // the full rewrite of 4 MB took 40-120 ms
    });
});
