// idb-session-adapter.ts — IDBSessionAdapter: session store for the browser using IndexedDB.
// No COOP/COEP headers or CDN wasm required — works on GitHub Pages and any static host.
// Replaces browser-sqlite-adapter.ts for deployments without cross-origin isolation.
// Registered as the session store via setSessionStore() on initIDBSession().

const _DB_NAME    = 'fg-session';
// v2: chatId index on turn_log, checkpoint_attachments store.
const _DB_VERSION = 3;

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
    // Resolves when the transaction COMMITTED, not when the cursor ran out: an abort after the last request still keeps the rows (exploration O012, E024).
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).index('chatId').openCursor(IDBKeyRange.only(chatId));
    req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (match(c.value)) c.delete();
        c.continue();
    };
    return _commit(tx);
}

// The newest generation of a chat's history, read INSIDE the transaction that then writes (callback style: the transaction stays active). A generation read in
// a transaction of its own and written in another let two overlapping operations choose the same generation and overwrite each other (codex R107).
function _latestGeneration(store: IDBObjectStore, chatId: string, then: (gen: number) => void): void {
    const req = store.index('chatId').getAll(IDBKeyRange.only(chatId));
    req.onsuccess = () => { const rs: any[] = req.result || []; then(rs.length ? Math.max(...rs.map((r: any) => r.generation)) : 0); };
}

// A handle the browser has closed (iOS Safari does this to backgrounded or memory-pressured tabs)
// throws InvalidStateError on every transaction until reopened. WebKit's "UnknownError: An internal error was encountered in the
// Indexed Database server" is the same kind of dead connection (console uploads, sessions 19438115, a60117bc, d8eb3808: every store
// call of the next minute failed with it), so it is retried once on a new connection too.
const _isClosedDbError = (e: any) => e?.name === 'InvalidStateError' || /connection is closing|database.*closed/i.test(String(e?.message ?? ''))
    || (e?.name === 'UnknownError' && /internal error/i.test(String(e?.message ?? '')));

let _outdatedTold = false;
function _tellOutdated() {
    if (_outdatedTold) return;
    _outdatedTold = true;
    (window as any).__fgTabOutdated = true;   // agentSend refuses new turns while it is set
    console.warn('[idb-session] the database was upgraded by a newer FreeGent build in another tab; this tab can no longer save its history');
    try {
        const b = document.createElement('div');
        b.id = 'fg-outdated-tab';
        b.textContent = 'FreeGent was updated in another tab. Reload this tab: until you do, new messages here are not saved.';
        b.style.cssText = 'position:fixed;left:0;right:0;top:0;padding:10px 14px;background:#a15c00;color:#fff;font:14px/1.3 system-ui,sans-serif;z-index:2147483000;text-align:center';
        document.body.appendChild(b);
    } catch {}
}

export class IDBSessionAdapter {
    private _reopening: Promise<void> | null = null;
    constructor(private _db: IDBDatabase, private _reopen: (() => Promise<IDBDatabase>) | null = null) {
        this._watch(_db);
        if (!_reopen) return;
        // Every public async method retries once on a closed connection, after reopening it.
        const proto = IDBSessionAdapter.prototype as any;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor' || name.startsWith('_') || name === 'revive' || typeof proto[name] !== 'function') continue;
            const orig = proto[name];
            (this as any)[name] = async (...a: any[]) => {
                try { return await orig.apply(this, a); }
                catch (e) {
                    if (!_isClosedDbError(e)) throw e;
                    await this.revive(true);
                    return await orig.apply(this, a);
                }
            };
        }
    }

    private _watch(db: IDBDatabase) {
        db.onclose = () => { if (this._db === db) this.revive(true).catch(() => {}); };
        // A version change means the other way round from a closed connection: a newer build upgraded the database, this tab's code is older than
        // the data and can never reopen it (VersionError on every call, the session store dead and silent). Say so once and stop reviving (exploration G02).
        db.onversionchange = () => { try { db.close(); } catch {} if (this._db === db) _tellOutdated(); };
    }

    /** Reopen the connection if the browser closed it (or `force`). Safe to call often. */
    async revive(force = false): Promise<void> {
        if (!this._reopen) return;
        if (!force) { try { this._db.transaction('chats', 'readonly').abort(); return; } catch {} }
        if (!this._reopening) {
            this._reopening = (async () => { const d = await this._reopen!(); this._db = d; this._watch(d); })()
                .finally(() => { this._reopening = null; });
        }
        await this._reopening;
    }

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
        // One transaction for the chat row and everything stored under it: a save queued behind a deletion then finds either all of it or none (codex R108).
        const tx = this._db.transaction(['chats', 'history', 'raw_messages', 'turn_log'], 'readwrite');
        tx.objectStore('chats').delete(id);
        for (const name of ['history', 'raw_messages', 'turn_log']) {
            const cur = tx.objectStore(name).index('chatId').openCursor(IDBKeyRange.only(id));
            cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } };
        }
        await _commit(tx);
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
        // The chat row, the newest generation and the write are one transaction: read apart, an overlapping compaction could move the newest generation between the
        // read and the write, and this save then replaced the history the compaction had just sealed (codex R107).
        const tx = this._db.transaction(['chats', 'history'], 'readwrite');
        const done = _commit(tx);
        let chat: any, haveChat = false, gen = 0, haveGen = false;
        const go = () => {
            if (!haveChat || !haveGen) return;
            if (!chat) tx.objectStore('chats').put({ id: chatId, name: 'New Chat', createdAt: Date.now(), lastAt: Date.now(), mainRole: null, archived: 0 });
            tx.objectStore('history').put({ chatId, generation: gen, history });
        };
        const creq = tx.objectStore('chats').get(chatId);
        creq.onsuccess = () => { chat = creq.result; haveChat = true; go(); };
        _latestGeneration(tx.objectStore('history'), chatId, g => { gen = g; haveGen = true; go(); });
        await done;
    }

    async compactHistory(chatId: string, preHistory: any[], postHistory: any[]) {
        const tx = this._db.transaction('history', 'readwrite');
        const done = _commit(tx);
        _latestGeneration(tx.objectStore('history'), chatId, gen => {
            tx.objectStore('history').put({ chatId, generation: gen,     history: preHistory  });
            tx.objectStore('history').put({ chatId, generation: gen + 1, history: postHistory });
        });
        await done;
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
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
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
            // Worker run tables were written and never read, and outlived their chat: dropped in v3.
            for (const old of ['worker_runs', 'worker_agents']) if (d.objectStoreNames.contains(old)) d.deleteObjectStore(old);
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
    return new IDBSessionAdapter(await open(), open);
}

async function initIDBSession(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const adapter = await openIDBSession();
        setSessionStore(adapter);
        // Coming back to the tab is when a closed connection is noticed first.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) adapter.revive().catch(() => {}); });
    } catch (e) {
        console.warn('[idb-session] init failed:', (e as any)?.message);
    }
}

Object.assign(window, { initIDBSession });
