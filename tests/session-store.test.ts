/**
 * session-store tests — SessionStore injection point (no-op fallback) and the
 * NodeSqliteAdapter backend (schema creation, chat/message/turn-log/worker-run writes).
 */
import { NodeSqliteAdapter } from '../node-sqlite-adapter.js';

afterEach(() => {
    window.setSessionStore(null);
    localStorage.clear();
});

describe('session-store with no adapter injected', () => {
    it('every session* function is a safe no-op', () => {
        expect(() => {
            window.sessionSyncChatList([{ id: 'c1', name: 'Chat', createdAt: 1, lastAt: 1 }]);
            window.sessionDeleteChat('c1');
            window.sessionSetChatRole('c1', 'coder');
            window.sessionSaveHistory('c1', [{ role: 'user', content: 'hi' }]);
            window.sessionLogTurn({ chatId: 'c1', model: 'x' });
            window.sessionCreateWorkerRun('r1', 'c1');
            window.sessionFinishWorkerRun('r1', 'complete');
            window.sessionRecordWorkerAgent('r1', { id: 'a1', task: 't' });
        }).not.toThrow();
    });
});

describe('NodeSqliteAdapter', () => {
    function tables(adapter) {
        return (adapter as any)._db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all().map(r => r.name);
    }

    it('creates the full schema on open', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await (adapter as any)._ensure();
        expect(tables(adapter)).toEqual(expect.arrayContaining([
            'chats', 'messages', 'turn_log', 'worker_runs', 'worker_agents', 'worker_staged_files', 'schema_meta',
        ]));
    });

    it('syncChatList upserts chat rows, preserving unrelated fields on conflict', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.syncChatList([{ id: 'c1', name: 'First', createdAt: 100, lastAt: 100 }]);
        await adapter.setChatRole('c1', 'coder');
        await adapter.syncChatList([{ id: 'c1', name: 'Renamed', createdAt: 100, lastAt: 200 }]);
        const row = (adapter as any)._db.prepare('SELECT * FROM chats WHERE id = ?').get('c1');
        expect(row.name).toBe('Renamed');
        expect(row.last_at).toBe(200);
        expect(row.main_role).toBe('coder'); // untouched by a later syncChatList call
    });

    it('deleteChat removes the chat row', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.syncChatList([{ id: 'c1', name: 'X', createdAt: 1, lastAt: 1 }]);
        await adapter.deleteChat('c1');
        const row = (adapter as any)._db.prepare('SELECT * FROM chats WHERE id = ?').get('c1');
        expect(row).toBeUndefined();
    });

    it('replaceMessages round-trips an OAI-shaped history, splitting string vs. multi-part content', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        const history = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'file contents' },
            { role: 'user', content: [{ type: 'text', text: 'multi-part' }] },
        ];
        await adapter.replaceMessages('c1', history);
        const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq').all('c1');
        expect(rows).toHaveLength(4);
        expect(rows[0].content).toBe('hello');
        expect(rows[1].tool_calls).toContain('read_file');
        expect(rows[2].tool_call_id).toBe('t1');
        expect(rows[3].content).toBeNull();
        expect(JSON.parse(rows[3].content_json)).toEqual([{ type: 'text', text: 'multi-part' }]);
    });

    it('replaceMessages is idempotent (whole-blob replace, not append)', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'v1' }]);
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'v2' }, { role: 'assistant', content: 'reply' }]);
        const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq').all('c1');
        expect(rows).toHaveLength(2);
        expect(rows[0].content).toBe('v2');
    });

    describe('compactHistory — generation lineage', () => {
        it('seals the current generation with the full pre-compaction history and opens a new one', async () => {
            const adapter = new NodeSqliteAdapter(':memory:');
            await adapter.replaceMessages('c1', [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
            await adapter.compactHistory('c1',
                [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }],
                [{ role: 'user', content: 'summary of q1/a1/q2/a2' }, { role: 'assistant', content: 'Understood, continuing from the summary.' }],
            );
            const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? AND raw = 0 ORDER BY generation, seq').all('c1');
            const gen0 = rows.filter(r => r.generation === 0);
            const gen1 = rows.filter(r => r.generation === 1);
            expect(gen0.map(r => r.content)).toEqual(['q1', 'a1', 'q2', 'a2']); // full pre-compaction history, sealed
            expect(gen1.map(r => r.content)).toEqual(['summary of q1/a1/q2/a2', 'Understood, continuing from the summary.']);
        });

        it('does not create a new row in chats — same chat_id, no separate visible session', async () => {
            const adapter = new NodeSqliteAdapter(':memory:');
            await adapter.syncChatList([{ id: 'c1', name: 'My Chat', createdAt: 1, lastAt: 1 }]);
            await adapter.compactHistory('c1', [{ role: 'user', content: 'q' }], [{ role: 'user', content: 'summary' }]);
            const chats = (adapter as any)._db.prepare('SELECT * FROM chats').all();
            expect(chats).toHaveLength(1);
            expect(chats[0].id).toBe('c1');
        });

        it('a later replaceMessages() operates on the new (post-compaction) generation only, leaving the sealed one untouched', async () => {
            const adapter = new NodeSqliteAdapter(':memory:');
            await adapter.replaceMessages('c1', [{ role: 'user', content: 'q1' }]);
            await adapter.compactHistory('c1', [{ role: 'user', content: 'q1' }], [{ role: 'user', content: 'summary' }]);
            await adapter.replaceMessages('c1', [{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'a2' }]);
            const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? AND raw = 0 ORDER BY generation, seq').all('c1');
            const gen0 = rows.filter(r => r.generation === 0);
            const gen1 = rows.filter(r => r.generation === 1);
            expect(gen0.map(r => r.content)).toEqual(['q1']); // untouched by the later replaceMessages
            expect(gen1.map(r => r.content)).toEqual(['summary', 'a2']);
        });

        it('supports multiple compactions — every generation stays independently recoverable', async () => {
            const adapter = new NodeSqliteAdapter(':memory:');
            await adapter.replaceMessages('c1', [{ role: 'user', content: 'gen0' }]);
            await adapter.compactHistory('c1', [{ role: 'user', content: 'gen0' }], [{ role: 'user', content: 'gen1' }]);
            await adapter.compactHistory('c1', [{ role: 'user', content: 'gen1' }], [{ role: 'user', content: 'gen2' }]);
            const rows = (adapter as any)._db.prepare('SELECT generation, content FROM messages WHERE chat_id = ? AND raw = 0 ORDER BY generation').all('c1');
            expect(rows).toEqual([
                { generation: 0, content: 'gen0' },
                { generation: 1, content: 'gen1' },
                { generation: 2, content: 'gen2' },
            ]);
        });

        it('compactHistory works from an empty chat (no prior replaceMessages call) — sealing must not depend on a regular save having run', async () => {
            const adapter = new NodeSqliteAdapter(':memory:');
            await adapter.compactHistory('c1', [{ role: 'user', content: 'never separately saved' }], [{ role: 'user', content: 'summary' }]);
            const rows = (adapter as any)._db.prepare('SELECT generation, content FROM messages WHERE chat_id = ? AND raw = 0 ORDER BY generation').all('c1');
            expect(rows).toEqual([
                { generation: 0, content: 'never separately saved' },
                { generation: 1, content: 'summary' },
            ]);
        });
    });

    it('logTurn inserts a queryable turn_log row', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.logTurn({
            ts: '2026-07-10T00:00:00.000Z', chatId: 'c1', chatName: 'Chat', model: 'gpt', provider: 'openai',
            promptTokens: 10, responseTokens: 5, response: 'hi', toolCalls: [{ id: 't1' }], loopDetected: true,
        });
        const row = (adapter as any)._db.prepare('SELECT * FROM turn_log').get();
        expect(row.chat_id).toBe('c1');
        expect(row.model).toBe('gpt');
        expect(row.loop_detected).toBe(1);
        expect(JSON.parse(row.tool_calls)).toEqual([{ id: 't1' }]);
    });

    it('logTurn persists type/name/prompt — a validation (judge) call is distinguishable from a regular turn', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.logTurn({ chatId: 'c1', model: 'gpt', provider: 'openai', response: 'ok' }); // regular turn
        await adapter.logTurn({
            chatId: 'c1', type: 'validation', name: 'missing_state_line', model: 'gpt', provider: 'openai',
            prompt: 'Does this end with a state line?', response: 'NO', promptTokens: 40, responseTokens: 1,
        });
        const rows = (adapter as any)._db.prepare('SELECT * FROM turn_log ORDER BY id').all();
        expect(rows[0].type).toBeNull();
        expect(rows[1].type).toBe('validation');
        expect(rows[1].name).toBe('missing_state_line');
        expect(rows[1].prompt).toBe('Does this end with a state line?');
    });

    it('worker run lifecycle: create → record agents with staged files → finish', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.createWorkerRun('r1', 'c1');
        await adapter.recordWorkerAgent('r1', {
            id: 'w1', role: 'coder', model: 'gpt', task: 'do X', output: 'done', status: 'complete',
            staged: [{ path: 'a.txt', content: 'A' }, { path: 'b.txt', content: 'B' }],
        });
        await adapter.finishWorkerRun('r1', 'complete');

        const run = (adapter as any)._db.prepare('SELECT * FROM worker_runs WHERE id = ?').get('r1');
        expect(run.status).toBe('complete');
        expect(run.finished_at).not.toBeNull();

        const agents = (adapter as any)._db.prepare('SELECT * FROM worker_agents WHERE run_id = ?').all('r1');
        expect(agents).toHaveLength(1);
        expect(agents[0].agent_id).toBe('w1');

        const staged = (adapter as any)._db.prepare('SELECT * FROM worker_staged_files WHERE worker_agent_id = ?').all(agents[0].id);
        expect(staged.map(s => s.path).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('deleting a chat cascades to its messages', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.syncChatList([{ id: 'c1', name: 'X', createdAt: 1, lastAt: 1 }]);
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'hi' }]);
        await adapter.deleteChat('c1');
        const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ?').all('c1');
        expect(rows).toHaveLength(0);
    });

    it('saveRawMessage inserts an append-only raw=1 row, defensively creating the chat row', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.saveRawMessage('c1', { role: 'assistant', content: '<function=web_search>{}', kind: 'fn_tag_strip' });
        const row = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? AND raw = 1').get('c1');
        expect(row.role).toBe('assistant');
        expect(row.kind).toBe('fn_tag_strip');
        expect(row.content).toContain('web_search');
        const chat = (adapter as any)._db.prepare('SELECT * FROM chats WHERE id = ?').get('c1');
        expect(chat).toBeTruthy();
    });

    it('saveRawMessage rows do not collide with each other or with live (raw=0) rows at the same seq', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'live' }]);
        await adapter.saveRawMessage('c1', { role: 'assistant', content: 'raw 1', kind: 'fn_tag_strip' });
        await adapter.saveRawMessage('c1', { role: 'assistant', content: 'raw 2', kind: 'fn_tag_strip' });
        const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all('c1');
        expect(rows).toHaveLength(3); // no UNIQUE-constraint collisions
        expect(rows.filter(r => r.raw === 1)).toHaveLength(2);
    });
});

describe('session-store wrappers with a NodeSqliteAdapter injected', () => {
    it('routes chat/message/turn-log/worker calls through to the adapter', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        window.setSessionStore(adapter);

        window.sessionSyncChatList([{ id: 'c1', name: 'Chat', createdAt: 1, lastAt: 1 }]);
        window.sessionSaveHistory('c1', [{ role: 'user', content: 'hi' }]);
        window.sessionLogTurn({ chatId: 'c1', model: 'gpt' });
        window.sessionCreateWorkerRun('r1', 'c1');
        window.sessionRecordWorkerAgent('r1', { id: 'w1', task: 't', status: 'complete' });
        window.sessionFinishWorkerRun('r1', 'complete');

        // These are fire-and-forget (not awaited by the wrappers) — every one of them awaits
        // the same shared _ready promise as its first step, so awaiting it here (after they've
        // already started) orders our continuation after theirs in the microtask queue. A
        // setTimeout(0) is NOT reliably enough margin — flaked once the schema grew (FTS5).
        await (adapter as any)._ensure();

        expect((adapter as any)._db.prepare('SELECT * FROM chats').all()).toHaveLength(1);
        expect((adapter as any)._db.prepare('SELECT * FROM messages').all()).toHaveLength(1);
        expect((adapter as any)._db.prepare('SELECT * FROM turn_log').all()).toHaveLength(1);
        expect((adapter as any)._db.prepare('SELECT * FROM worker_runs').all()).toHaveLength(1);
        expect((adapter as any)._db.prepare('SELECT * FROM worker_agents').all()).toHaveLength(1);
    });

    it('sessionCompactHistory routes through to compactHistory, sealing a recoverable generation', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        window.setSessionStore(adapter);

        window.sessionCompactHistory('c1', [{ role: 'user', content: 'pre' }], [{ role: 'user', content: 'post' }]);
        await (adapter as any)._ensure();

        const rows = (adapter as any)._db.prepare('SELECT generation, content FROM messages WHERE chat_id = ? ORDER BY generation').all('c1');
        expect(rows).toEqual([{ generation: 0, content: 'pre' }, { generation: 1, content: 'post' }]);
    });

    it('a throwing adapter method does not propagate to the caller', () => {
        window.setSessionStore({
            syncChatList: () => { throw new Error('boom'); },
        });
        expect(() => window.sessionSyncChatList([])).not.toThrow();
    });

    it('sessionSaveRawMessage also routes to the adapter when one is injected', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        window.setSessionStore(adapter);
        window.sessionSaveRawMessage('c1', { role: 'assistant', content: 'raw text', kind: 'fn_tag_strip' });
        await (adapter as any)._ensure();
        const rows = (adapter as any)._db.prepare('SELECT * FROM messages WHERE chat_id = ? AND raw = 1').all('c1');
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe('raw text');
    });
});

// sessionSaveRawMessage/sessionLoadRawMessages get a REAL localStorage fallback (unlike the
// other session* functions above, which are no-ops without an adapter) — there's no
// pre-existing legacy implementation for raw capture to fall through to, and it needs to stay
// explorable without an adapter injected (plain browser mode today).
describe('sessionSaveRawMessage / sessionLoadRawMessages — localStorage fallback (no adapter)', () => {
    it('persists and reads back raw captures for a chat', () => {
        window.sessionSaveRawMessage('c1', { role: 'assistant', content: 'first', kind: 'fn_tag_strip' });
        window.sessionSaveRawMessage('c1', { role: 'tool', content: 'second', kind: 'tool_truncate' });
        const list = window.sessionLoadRawMessages('c1');
        expect(list).toHaveLength(2);
        expect(list[0].content).toBe('first');
        expect(list[1].kind).toBe('tool_truncate');
        expect(list[0].ts).toBeTypeOf('number');
    });

    it('is scoped per chat', () => {
        window.sessionSaveRawMessage('c1', { role: 'assistant', content: 'for c1' });
        window.sessionSaveRawMessage('c2', { role: 'assistant', content: 'for c2' });
        expect(window.sessionLoadRawMessages('c1')).toHaveLength(1);
        expect(window.sessionLoadRawMessages('c2')).toHaveLength(1);
        expect(window.sessionLoadRawMessages('c3')).toHaveLength(0);
    });

    it('is a no-op when chatId is falsy', () => {
        expect(() => window.sessionSaveRawMessage(null, { content: 'x' })).not.toThrow();
        expect(window.sessionLoadRawMessages(null)).toHaveLength(0);
    });

    it('caps the log so it does not grow unbounded', () => {
        for (let i = 0; i < 105; i++) window.sessionSaveRawMessage('c1', { role: 'assistant', content: `msg ${i}` });
        const list = window.sessionLoadRawMessages('c1');
        expect(list.length).toBeLessThanOrEqual(100);
        expect(list[list.length - 1].content).toBe('msg 104'); // most recent kept
    });
});

// Rewind/Rerun (agent-core.ts's restoreCheckpointState) must erase a superseded run's raw
// captures, not just its openaiHistory — otherwise every retry leaves the old failed
// attempt's captures sitting alongside the new one forever.
describe('sessionPruneRawFrom', () => {
    it('removes entries at/after the checkpoint time, keeps earlier ones', () => {
        // Set explicit ts values directly — sessionSaveRawMessage's Date.now() has only
        // millisecond resolution and two fast calls can otherwise land on the same tick.
        localStorage.setItem('fg_chat_c1_raw', JSON.stringify([
            { ts: 1000, content: 'before' },
            { ts: 2000, content: 'after' },
        ]));
        window.sessionPruneRawFrom('c1', 2000);
        const list = window.sessionLoadRawMessages('c1');
        expect(list.map(e => e.content)).toEqual(['before']);
    });
    it('leaves other chats untouched', () => {
        window.sessionSaveRawMessage('c1', { role: 'assistant', content: 'c1 entry' });
        window.sessionSaveRawMessage('c2', { role: 'assistant', content: 'c2 entry' });
        window.sessionPruneRawFrom('c1', 0);
        expect(window.sessionLoadRawMessages('c2')).toHaveLength(1);
    });
    it('is a no-op when chatId is falsy', () => {
        expect(() => window.sessionPruneRawFrom(null, Date.now())).not.toThrow();
    });
});

describe('FTS5 full-text search — messages_fts / turn_log_fts', () => {
    it('messages_fts finds a match and joins back to the full row', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.replaceMessages('c1', [
            { role: 'user', content: 'search for agentic coding frameworks' },
            { role: 'assistant', content: 'here are the results' },
        ]);
        const rows = (adapter as any)._db.prepare(`
            SELECT m.role, m.content FROM messages m
            JOIN messages_fts f ON f.rowid = m.id
            WHERE messages_fts MATCH 'agentic'
        `).all();
        expect(rows).toEqual([{ role: 'user', content: 'search for agentic coding frameworks' }]);
    });

    it('finds raw-capture rows too — e.g. every request_failed mentioning a specific model', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.saveRawMessage('c1', { role: 'assistant', kind: 'request_failed', name: 'nvidia|glm-5.2', content: 'HTTP 400: Pass ?q= for search or ?url= for fetch' });
        await adapter.saveRawMessage('c1', { role: 'assistant', kind: 'request_failed', name: 'mistral|mistral-medium-3.5', content: 'HTTP 429: rate limited' });
        const rows = (adapter as any)._db.prepare(`
            SELECT m.name FROM messages m JOIN messages_fts f ON f.rowid = m.id
            WHERE messages_fts MATCH 'kind:request_failed AND "HTTP 400"'
        `).all();
        expect(rows).toEqual([{ name: 'nvidia|glm-5.2' }]);
    });

    it('the index stays consistent after a delete — replaceMessages() (delete+reinsert) does not leave stale matches', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'original needle content' }]);
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'replacement text' }]);
        const stale = (adapter as any)._db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle'`).all();
        expect(stale).toHaveLength(0);
        const fresh = (adapter as any)._db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'replacement'`).all();
        expect(fresh).toHaveLength(1);
    });

    it('the index stays consistent through an ON DELETE CASCADE (deleting the chat)', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.syncChatList([{ id: 'c1', name: 'X', createdAt: 1, lastAt: 1 }]);
        await adapter.replaceMessages('c1', [{ role: 'user', content: 'cascade needle' }]);
        await adapter.deleteChat('c1');
        const stale = (adapter as any)._db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle'`).all();
        expect(stale).toHaveLength(0);
    });

    it('turn_log_fts finds a match across response/prompt/name columns', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.logTurn({ chatId: 'c1', type: 'nudge', name: 'compaction_loss', response: 'Note: a possible compaction information loss was logged' });
        await adapter.logTurn({ chatId: 'c1', model: 'gpt', response: 'an unrelated normal turn' });
        const rows = (adapter as any)._db.prepare(`
            SELECT t.name FROM turn_log t JOIN turn_log_fts f ON f.rowid = t.id
            WHERE turn_log_fts MATCH 'compaction'
        `).all();
        expect(rows).toEqual([{ name: 'compaction_loss' }]);
    });

    it('turn_log_fts index survives a delete (no explicit delete path exists today, but the trigger must not corrupt the index if one is ever added)', async () => {
        const adapter = new NodeSqliteAdapter(':memory:');
        await adapter.logTurn({ chatId: 'c1', response: 'delete me needle' });
        const db = (adapter as any)._db;
        db.exec('DELETE FROM turn_log');
        const stale = db.prepare(`SELECT rowid FROM turn_log_fts WHERE turn_log_fts MATCH 'needle'`).all();
        expect(stale).toHaveLength(0);
    });
});
