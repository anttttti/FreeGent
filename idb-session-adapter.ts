// idb-session-adapter.ts — IDBSessionAdapter: session store for the browser using IndexedDB.
// No COOP/COEP headers or CDN wasm required — works on GitHub Pages and any static host.
// Replaces browser-sqlite-adapter.ts for deployments without cross-origin isolation.
// Registered as the session store via setSessionStore() on initIDBSession().

const _DB_NAME    = 'fg-session';
const _DB_VERSION = 1;

function _req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror   = () => reject(r.error);
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
    }

    async deleteChat(id: string) {
        await _req(this._db.transaction('chats', 'readwrite').objectStore('chats').delete(id));

        await new Promise<void>((resolve, reject) => {
            const req = this._db.transaction('history', 'readwrite')
                                .objectStore('history')
                                .index('chatId')
                                .openCursor(IDBKeyRange.only(id));
            req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } else { resolve(); } };
            req.onerror   = () => reject(req.error);
        });

        await new Promise<void>((resolve, reject) => {
            const req = this._db.transaction('raw_messages', 'readwrite')
                                .objectStore('raw_messages')
                                .index('chatId')
                                .openCursor(IDBKeyRange.only(id));
            req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } else { resolve(); } };
            req.onerror   = () => reject(req.error);
        });
    }

    async setChatRole(id: string, role: string | null) {
        const ex: any = await _req(this._db.transaction('chats', 'readonly').objectStore('chats').get(id));
        this._db.transaction('chats', 'readwrite').objectStore('chats').put({
            id,
            name:      ex?.name      ?? 'New Chat',
            createdAt: ex?.createdAt ?? Date.now(),
            lastAt:    ex?.lastAt    ?? Date.now(),
            archived:  ex?.archived  ?? 0,
            mainRole:  role ?? null,
        });
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
    }

    async compactHistory(chatId: string, preHistory: any[], postHistory: any[]) {
        const gen = await this._getGeneration(chatId);
        const tx = this._db.transaction('history', 'readwrite');
        tx.objectStore('history').put({ chatId, generation: gen,     history: preHistory  });
        tx.objectStore('history').put({ chatId, generation: gen + 1, history: postHistory });
    }

    async saveRawMessage(chatId: string, entry: any) {
        this._db.transaction('raw_messages', 'readwrite')
                .objectStore('raw_messages')
                .add({ chatId, createdAt: Date.now(), ...entry });
    }

    // ── Turn log ───────────────────────────────────────────────────────────────

    async logTurn(record: any) {
        this._db.transaction('turn_log', 'readwrite')
                .objectStore('turn_log')
                .add({ ts: new Date().toISOString(), ...record });
    }

    // ── Worker runs ────────────────────────────────────────────────────────────

    async createWorkerRun(id: string, chatId: string | null) {
        this._db.transaction('worker_runs', 'readwrite')
                .objectStore('worker_runs')
                .put({ id, chatId: chatId ?? null, startedAt: Date.now(), status: 'running' });
    }

    async finishWorkerRun(id: string, status: string | null) {
        const ex: any = await _req(this._db.transaction('worker_runs', 'readonly').objectStore('worker_runs').get(id));
        if (!ex) return;
        this._db.transaction('worker_runs', 'readwrite')
                .objectStore('worker_runs')
                .put({ ...ex, status: status ?? 'complete', finishedAt: Date.now() });
    }

    async recordWorkerAgent(runId: string, agent: any) {
        this._db.transaction('worker_agents', 'readwrite')
                .objectStore('worker_agents')
                .add({ runId, ...agent });
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
            if (!d.objectStoreNames.contains('chats'))
                d.createObjectStore('chats', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('history')) {
                const s = d.createObjectStore('history', { keyPath: ['chatId', 'generation'] });
                s.createIndex('chatId', 'chatId');
            }
            if (!d.objectStoreNames.contains('turn_log'))
                d.createObjectStore('turn_log', { autoIncrement: true });
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
