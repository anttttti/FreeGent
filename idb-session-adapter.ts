// idb-session-adapter.ts — IDBSessionAdapter: session store for the browser using IndexedDB.
// No COOP/COEP headers or CDN wasm required — works on GitHub Pages and any static host.
// Replaces browser-sqlite-adapter.ts for deployments without cross-origin isolation.
// Registered as the session store via setSessionStore() on initIDBSession().

const _DB_NAME    = 'fg-session';
// v2: chatId index on turn_log, checkpoint_attachments store.
const _DB_VERSION = 2;

function _req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror   = () => reject(r.error);
    });
}

// Resolves when the transaction has COMMITTED; rejects if it aborts or errors. A request's
// onsuccess only means the write was queued: a quota failure or abort afterwards still loses it,
// and callers (sessionSaveHistory → chat-cache eviction) treat a resolved write as durable.
function _commit(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort    = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        tx.onerror    = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
}

// Delete the rows of `store` whose chatId index matches `chatId` and for which `match` is true.
function _deleteByChat(db: IDBDatabase, store: string, chatId: string, match: (row: any) => boolean = () => true): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).index('chatId').openCursor(IDBKeyRange.only(chatId));
        req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(); return; }
            if (match(c.value)) c.delete();
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

export class IDBSessionAdapter {
    constructor(private _db: IDBDatabase) {}

    // Compute current generation from the max generation stored in the history store.
    // Avoids storing generation on the chat record (which would require read-modify-write on every sync).
    private async _getGeneration(chatId: string): Promise<number> {
        const records: any[] = await _req(
            this._db.transaction('history', 'readonly')
                    .objectStore('history')
                    .index('chatId')
                    .getAll(IDBKeyRange.only(chatId))
        );
        return records.length ? Math.max(...records.map((r: any) => r.generation)) : 0;
    }

    // ── Chats ──────────────────────────────────────────────────────────────────

    async syncChatList(list: any[]) {
        // Read first to preserve mainRole/archived that syncChatList doesn't supply.
        const all: any[] = await _req(this._db.transaction('chats', 'readonly').objectStore('chats').getAll());
        const byId = new Map(all.map((c: any) => [c.id, c]));
        const tx = this._db.transaction('chats', 'readwrite');
        const store = tx.objectStore('chats');
        for (const c of list) {
            const ex = byId.get(c.id);
            store.put({
                id:        c.id,
                name:      c.name      ?? 'New Chat',
                createdAt: c.createdAt ?? Date.now(),
                lastAt:    c.lastAt    ?? Date.now(),
                mainRole:  ex?.mainRole ?? null,
                archived:  ex?.archived ?? 0,
            });
        }
        await _commit(tx);
    }

    async deleteChat(id: string) {
        const delTx = this._db.transaction('chats', 'readwrite');
        delTx.objectStore('chats').delete(id);
        await _commit(delTx);
        await _deleteByChat(this._db, 'history', id);
        await _deleteByChat(this._db, 'raw_messages', id);
        await _deleteByChat(this._db, 'turn_log', id);
    }

    async setChatRole(id: string, role: string | null) {
        const ex: any = await _req(this._db.transaction('chats', 'readonly').objectStore('chats').get(id));
        const tx = this._db.transaction('chats', 'readwrite');
        tx.objectStore('chats').put({
            id,
            name:      ex?.name      ?? 'New Chat',
            createdAt: ex?.createdAt ?? Date.now(),
            lastAt:    ex?.lastAt    ?? Date.now(),
            archived:  ex?.archived  ?? 0,
            mainRole:  role ?? null,
        });
        await _commit(tx);
    }

    // ── Messages ───────────────────────────────────────────────────────────────

    async replaceMessages(chatId: string, history: any[]) {
        const [gen, ex] = await Promise.all([
            this._getGeneration(chatId),
            _req(this._db.transaction('chats', 'readonly').objectStore('chats').get(chatId)),
        ]);
        const tx = this._db.transaction(['chats', 'history'], 'readwrite');
        if (!ex) tx.objectStore('chats').put({ id: chatId, name: 'New Chat', createdAt: Date.now(), lastAt: Date.now(), mainRole: null, archived: 0 });
        tx.objectStore('history').put({ chatId, generation: gen, history });
        await _commit(tx);
    }

    async compactHistory(chatId: string, preHistory: any[], postHistory: any[]) {
        const gen = await this._getGeneration(chatId);
        const tx = this._db.transaction('history', 'readwrite');
        tx.objectStore('history').put({ chatId, generation: gen,     history: preHistory  });
        tx.objectStore('history').put({ chatId, generation: gen + 1, history: postHistory });
        await _commit(tx);
    }

    async saveRawMessage(chatId: string, entry: any) {
        const tx = this._db.transaction('raw_messages', 'readwrite');
        tx.objectStore('raw_messages').add({ chatId, createdAt: Date.now(), ...entry });
        await _commit(tx);
    }

    // Same shape as the localStorage fallback in session-store.ts: { ts, ...entry }, oldest first.
    async loadRawMessages(chatId: string): Promise<any[]> {
        const rows: any[] = await _req(this._db.transaction('raw_messages', 'readonly')
            .objectStore('raw_messages').index('chatId').getAll(IDBKeyRange.only(chatId)));
        return rows.map(({ chatId: _c, createdAt, ...entry }) => ({ ...entry, ts: createdAt }));
    }

    async pruneRawFrom(chatId: string, sinceMs: number) {
        await _deleteByChat(this._db, 'raw_messages', chatId, r => (r.createdAt ?? 0) >= sinceMs);
    }

    // ── Turn log ───────────────────────────────────────────────────────────────

    async logTurn(record: any) {
        const tx = this._db.transaction('turn_log', 'readwrite');
        tx.objectStore('turn_log').add({ ts: new Date().toISOString(), ...record });
        await _commit(tx);
    }

    // The chat's most recent `limit` turns, oldest first.
    async loadTurnLog(chatId: string, limit: number): Promise<any[]> {
        const rows: any[] = await _req(this._db.transaction('turn_log', 'readonly')
            .objectStore('turn_log').index('chatId').getAll(IDBKeyRange.only(chatId)));
        return rows.slice(-limit);
    }

    async pruneTurnLogFrom(chatId: string, sinceMs: number) {
        await _deleteByChat(this._db, 'turn_log', chatId, r => new Date(r.ts).getTime() >= sinceMs);
    }

    // ── Checkpoint attachments ─────────────────────────────────────────────────
    // Images and files sent with a message, kept for Rerun/Edit. The rest of the checkpoint
    // (small metadata) stays in localStorage — see saveCheckpoint in agent-core.ts.

    async saveCheckpointAttachments(id: string, data: { images: any[]; files: any[] }) {
        const tx = this._db.transaction('checkpoint_attachments', 'readwrite');
        tx.objectStore('checkpoint_attachments').put({ id, images: data.images, files: data.files });
        await _commit(tx);
    }

    async loadCheckpointAttachments(id: string): Promise<{ images: any[]; files: any[] } | null> {
        const r: any = await _req(this._db.transaction('checkpoint_attachments', 'readonly')
            .objectStore('checkpoint_attachments').get(id));
        return r ? { images: r.images ?? [], files: r.files ?? [] } : null;
    }

    async deleteCheckpointAttachments(ids: string[]) {
        const tx = this._db.transaction('checkpoint_attachments', 'readwrite');
        const store = tx.objectStore('checkpoint_attachments');
        for (const id of ids) store.delete(id);
        await _commit(tx);
    }

    // ── Worker runs ────────────────────────────────────────────────────────────

    async createWorkerRun(id: string, chatId: string | null) {
        const tx = this._db.transaction('worker_runs', 'readwrite');
        tx.objectStore('worker_runs').put({ id, chatId: chatId ?? null, startedAt: Date.now(), status: 'running' });
        await _commit(tx);
    }

    async finishWorkerRun(id: string, status: string | null) {
        const ex: any = await _req(this._db.transaction('worker_runs', 'readonly').objectStore('worker_runs').get(id));
        if (!ex) return;
        const tx = this._db.transaction('worker_runs', 'readwrite');
        tx.objectStore('worker_runs').put({ ...ex, status: status ?? 'complete', finishedAt: Date.now() });
        await _commit(tx);
    }

    async recordWorkerAgent(runId: string, agent: any) {
        const tx = this._db.transaction('worker_agents', 'readwrite');
        tx.objectStore('worker_agents').add({ runId, ...agent });
        await _commit(tx);
    }

    // ── Read methods ───────────────────────────────────────────────────────────

    async loadChatList(): Promise<{id: string; name: string; createdAt: number; lastAt: number}[]> {
        const all: any[] = await _req(this._db.transaction('chats', 'readonly').objectStore('chats').getAll());
        return all
            .filter((r: any) => !r.archived)
            .sort((a: any, b: any) => a.lastAt - b.lastAt)
            .map((r: any) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastAt: r.lastAt }));
    }

    async loadHistory(chatId: string): Promise<any[] | null> {
        const gen = await this._getGeneration(chatId);
        const record: any = await _req(
            this._db.transaction('history', 'readonly')
                    .objectStore('history')
                    .get([chatId, gen])
        );
        return record?.history ?? null;
    }
}

// ── Init ───────────────────────────────────────────────────────────────────────

// Exported so tests can pass a fake-indexeddb IDBFactory and an isolated DB name.
export async function openIDBSession(idb: IDBFactory = indexedDB, dbName = _DB_NAME): Promise<IDBSessionAdapter> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = idb.open(dbName, _DB_VERSION);
        req.onupgradeneeded = () => {
            const d = req.result;
            const tx = req.transaction!;
            if (!d.objectStoreNames.contains('chats'))
                d.createObjectStore('chats', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('history')) {
                const s = d.createObjectStore('history', { keyPath: ['chatId', 'generation'] });
                s.createIndex('chatId', 'chatId');
            }
            if (!d.objectStoreNames.contains('turn_log'))
                d.createObjectStore('turn_log', { autoIncrement: true });
            const turnLog = tx.objectStore('turn_log');
            if (!turnLog.indexNames.contains('chatId')) turnLog.createIndex('chatId', 'chatId');
            if (!d.objectStoreNames.contains('worker_runs'))
                d.createObjectStore('worker_runs', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('worker_agents')) {
                const s = d.createObjectStore('worker_agents', { autoIncrement: true });
                s.createIndex('runId', 'runId');
            }
            if (!d.objectStoreNames.contains('raw_messages')) {
                const s = d.createObjectStore('raw_messages', { autoIncrement: true });
                s.createIndex('chatId', 'chatId');
            }
            if (!d.objectStoreNames.contains('checkpoint_attachments'))
                d.createObjectStore('checkpoint_attachments', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
    return new IDBSessionAdapter(db);
}

async function initIDBSession(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        setSessionStore(await openIDBSession());
    } catch (e) {
        console.warn('[idb-session] init failed:', (e as any)?.message);
    }
}

Object.assign(window, { initIDBSession });
