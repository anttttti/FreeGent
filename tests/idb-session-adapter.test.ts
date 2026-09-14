/**
 * IDBSessionAdapter tests — mirrors session-store.test.ts's NodeSqliteAdapter suite.
 * Uses fake-indexeddb so no browser environment is required.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IDBSessionAdapter, openIDBSession } from '../idb-session-adapter.js';

// fake-indexeddb provides IDBKeyRange but doesn't set it as a global — the adapter uses it as one.
globalThis.IDBKeyRange = IDBKeyRange;

// Each test gets a fresh IDBFactory (isolated DB, no cross-test state).
async function makeAdapter(): Promise<IDBSessionAdapter> {
    return openIDBSession(new IDBFactory());
}

// Read all records from an object store via the adapter's internal db.
async function getAll(adapter: IDBSessionAdapter, store: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = (adapter as any)._db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function getByIndex(adapter: IDBSessionAdapter, store: string, index: string, key: any): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = (adapter as any)._db
            .transaction(store, 'readonly')
            .objectStore(store)
            .index(index)
            .getAll(IDBKeyRange.only(key));
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

// ── Schema ────────────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — schema', () => {
    it('creates all object stores on open', async () => {
        const adapter = await makeAdapter();
        const names = Array.from((adapter as any)._db.objectStoreNames).sort();
        expect(names).toEqual(['chats', 'history', 'raw_messages', 'turn_log', 'worker_agents', 'worker_runs']);
    });
});

// ── Chats ─────────────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — chats', () => {
    it('syncChatList upserts chats', async () => {
        const a = await makeAdapter();
        await a.syncChatList([{ id: 'c1', name: 'First', createdAt: 100, lastAt: 100 }]);
        const rows = await getAll(a, 'chats');
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('First');
    });

    it('syncChatList preserves mainRole on re-sync', async () => {
        const a = await makeAdapter();
        await a.syncChatList([{ id: 'c1', name: 'First', createdAt: 100, lastAt: 100 }]);
        await a.setChatRole('c1', 'coder');
        await a.syncChatList([{ id: 'c1', name: 'Renamed', createdAt: 100, lastAt: 200 }]);
        const rows = await getAll(a, 'chats');
        expect(rows[0].name).toBe('Renamed');
        expect(rows[0].lastAt).toBe(200);
        expect(rows[0].mainRole).toBe('coder');
    });

    it('deleteChat removes the chat record', async () => {
        const a = await makeAdapter();
        await a.syncChatList([{ id: 'c1', name: 'X', createdAt: 1, lastAt: 1 }]);
        await a.deleteChat('c1');
        expect(await getAll(a, 'chats')).toHaveLength(0);
    });

    it('deleteChat removes all history generations for the chat', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'hi' }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'hi' }], [{ role: 'user', content: 'summary' }]);
        await a.deleteChat('c1');
        expect(await getAll(a, 'history')).toHaveLength(0);
    });

    it('deleteChat removes raw_messages for the chat', async () => {
        const a = await makeAdapter();
        await a.saveRawMessage('c1', { role: 'assistant', content: 'raw', kind: 'fn_tag_strip' });
        await a.deleteChat('c1');
        expect(await getAll(a, 'raw_messages')).toHaveLength(0);
    });

    it('deleteChat does not touch other chats', async () => {
        const a = await makeAdapter();
        await a.syncChatList([
            { id: 'c1', name: 'A', createdAt: 1, lastAt: 1 },
            { id: 'c2', name: 'B', createdAt: 1, lastAt: 1 },
        ]);
        await a.replaceMessages('c1', [{ role: 'user', content: 'c1 msg' }]);
        await a.replaceMessages('c2', [{ role: 'user', content: 'c2 msg' }]);
        await a.deleteChat('c1');
        const chats = await getAll(a, 'chats');
        expect(chats.map((c: any) => c.id)).toEqual(['c2']);
        const hist = await getAll(a, 'history');
        expect(hist).toHaveLength(1);
        expect(hist[0].chatId).toBe('c2');
    });

    it('loadChatList returns chats sorted by lastAt ascending', async () => {
        const a = await makeAdapter();
        await a.syncChatList([
            { id: 'c1', name: 'Old', createdAt: 1, lastAt: 1 },
            { id: 'c2', name: 'New', createdAt: 2, lastAt: 2 },
        ]);
        const list = await a.loadChatList();
        expect(list.map((c: any) => c.id)).toEqual(['c1', 'c2']);
    });
});

// ── Messages ──────────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — messages', () => {
    it('replaceMessages round-trips an OAI-shaped history', async () => {
        const a = await makeAdapter();
        const history = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'file contents' },
            { role: 'user', content: [{ type: 'text', text: 'multi-part' }] },
        ];
        await a.replaceMessages('c1', history);
        const loaded = await a.loadHistory('c1');
        expect(loaded).toHaveLength(4);
        expect(loaded![0]).toEqual({ role: 'user', content: 'hello' });
        expect(loaded![1].tool_calls[0].function.name).toBe('read_file');
        expect(loaded![2].tool_call_id).toBe('t1');
        expect(loaded![3].content).toEqual([{ type: 'text', text: 'multi-part' }]);
    });

    it('replaceMessages is idempotent — whole-blob replace, not append', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'v1' }]);
        await a.replaceMessages('c1', [{ role: 'user', content: 'v2' }, { role: 'assistant', content: 'reply' }]);
        const loaded = await a.loadHistory('c1');
        expect(loaded).toHaveLength(2);
        expect(loaded![0].content).toBe('v2');
    });

    it('loadHistory returns null for an unknown chatId', async () => {
        const a = await makeAdapter();
        expect(await a.loadHistory('nonexistent')).toBeNull();
    });

    it('replaceMessages auto-creates a chat record if missing', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'hi' }]);
        const chats = await getAll(a, 'chats');
        expect(chats.map((c: any) => c.id)).toContain('c1');
    });
});

// ── compactHistory — generation lineage ───────────────────────────────────────

describe('IDBSessionAdapter — compactHistory', () => {
    it('seals the current generation with the full pre-compaction history and opens a new one', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
        await a.compactHistory('c1',
            [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }],
            [{ role: 'user', content: 'summary' }],
        );
        const hist = await getByIndex(a, 'history', 'chatId', 'c1');
        const gen0 = hist.find((r: any) => r.generation === 0);
        const gen1 = hist.find((r: any) => r.generation === 1);
        expect(gen0.history.map((m: any) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
        expect(gen1.history.map((m: any) => m.content)).toEqual(['summary']);
    });

    it('loadHistory returns the latest generation after compaction', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'old' }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'old' }], [{ role: 'user', content: 'new' }]);
        const loaded = await a.loadHistory('c1');
        expect(loaded![0].content).toBe('new');
    });

    it('a later replaceMessages operates on the new generation only, leaving the sealed one untouched', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'q1' }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'q1' }], [{ role: 'user', content: 'summary' }]);
        await a.replaceMessages('c1', [{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'a2' }]);
        const hist = await getByIndex(a, 'history', 'chatId', 'c1');
        const gen0 = hist.find((r: any) => r.generation === 0);
        const gen1 = hist.find((r: any) => r.generation === 1);
        expect(gen0.history.map((m: any) => m.content)).toEqual(['q1']);
        expect(gen1.history.map((m: any) => m.content)).toEqual(['summary', 'a2']);
    });

    it('supports multiple compactions — every generation stays independently recoverable', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'gen0' }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'gen0' }], [{ role: 'user', content: 'gen1' }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'gen1' }], [{ role: 'user', content: 'gen2' }]);
        const hist = (await getByIndex(a, 'history', 'chatId', 'c1'))
            .sort((a: any, b: any) => a.generation - b.generation);
        expect(hist.map((r: any) => r.history[0].content)).toEqual(['gen0', 'gen1', 'gen2']);
    });

    it('compactHistory works from an empty chat (no prior replaceMessages)', async () => {
        const a = await makeAdapter();
        await a.compactHistory('c1', [{ role: 'user', content: 'never separately saved' }], [{ role: 'user', content: 'summary' }]);
        const hist = (await getByIndex(a, 'history', 'chatId', 'c1'))
            .sort((a: any, b: any) => a.generation - b.generation);
        expect(hist[0].history[0].content).toBe('never separately saved');
        expect(hist[1].history[0].content).toBe('summary');
    });

    it('does not create a new chat row — same chat_id, no separate visible session', async () => {
        const a = await makeAdapter();
        await a.syncChatList([{ id: 'c1', name: 'My Chat', createdAt: 1, lastAt: 1 }]);
        await a.compactHistory('c1', [{ role: 'user', content: 'q' }], [{ role: 'user', content: 'summary' }]);
        expect(await getAll(a, 'chats')).toHaveLength(1);
    });
});

// ── Turn log ──────────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — turn_log', () => {
    it('logTurn inserts a queryable record', async () => {
        const a = await makeAdapter();
        await a.logTurn({ chatId: 'c1', chatName: 'Chat', model: 'gpt', provider: 'openai',
            promptTokens: 10, responseTokens: 5, response: 'hi', loopDetected: true });
        const rows = await getAll(a, 'turn_log');
        expect(rows).toHaveLength(1);
        expect(rows[0].chatId).toBe('c1');
        expect(rows[0].model).toBe('gpt');
        expect(rows[0].loopDetected).toBe(true);
    });

    it('logTurn preserves type/name/prompt for validation calls', async () => {
        const a = await makeAdapter();
        await a.logTurn({ chatId: 'c1', model: 'gpt', response: 'ok' });
        await a.logTurn({ chatId: 'c1', type: 'validation', name: 'missing_state_line',
            model: 'gpt', prompt: 'Does this end with a state line?', response: 'NO' });
        const rows = await getAll(a, 'turn_log');
        expect(rows[0].type).toBeUndefined();
        expect(rows[1].type).toBe('validation');
        expect(rows[1].name).toBe('missing_state_line');
        expect(rows[1].prompt).toBe('Does this end with a state line?');
    });
});

// ── Worker runs ───────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — worker runs', () => {
    it('worker run lifecycle: create → record agent → finish', async () => {
        const a = await makeAdapter();
        await a.createWorkerRun('r1', 'c1');
        await a.recordWorkerAgent('r1', { id: 'w1', role: 'coder', model: 'gpt', task: 'do X', output: 'done', status: 'complete' });
        await a.finishWorkerRun('r1', 'complete');

        const runs = await getAll(a, 'worker_runs');
        expect(runs[0].status).toBe('complete');
        expect(runs[0].finishedAt).toBeTypeOf('number');

        const agents = await getByIndex(a, 'worker_agents', 'runId', 'r1');
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe('w1');
    });

    it('finishWorkerRun is a no-op for an unknown run id', async () => {
        const a = await makeAdapter();
        await expect(a.finishWorkerRun('nonexistent', 'complete')).resolves.not.toThrow();
    });
});

// ── Raw messages ──────────────────────────────────────────────────────────────

describe('IDBSessionAdapter — raw_messages', () => {
    it('saveRawMessage appends without overwriting live history', async () => {
        const a = await makeAdapter();
        await a.replaceMessages('c1', [{ role: 'user', content: 'live' }]);
        await a.saveRawMessage('c1', { role: 'assistant', content: 'raw 1', kind: 'fn_tag_strip' });
        await a.saveRawMessage('c1', { role: 'assistant', content: 'raw 2', kind: 'fn_tag_strip' });
        const raw = await getByIndex(a, 'raw_messages', 'chatId', 'c1');
        expect(raw).toHaveLength(2);
        // live history untouched
        const loaded = await a.loadHistory('c1');
        expect(loaded).toHaveLength(1);
    });
});
