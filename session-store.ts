// session-store.js — SessionStore adapter interface + injection point.
// Mirrors workspace.ts's `_wa`/setWorkspaceAdapter() pattern (see agentListFiles etc.)
// for chat/message/turn-log/worker-run persistence.
import { chatKey } from './storage-keys.js';
//
// Write calls are fire-and-forget: a broken adapter must never break the primary
// localStorage-backed behavior. Read calls (sessionLoadChatList, sessionLoadHistory) are
// async and return null/[] when no adapter is injected, letting callers fall back to
// localStorage. In the browser, BrowserSqliteAdapter is injected by initBrowserSqlite()
// (browser-sqlite-adapter.ts); in Node/headless, NodeSqliteAdapter is injected by the
// headless runner.
//
// With no adapter injected (setSessionStore never called), write functions are no-ops and
// read functions return empty results — behavior is unchanged from before this file existed.

export interface SessionStoreAdapter {
    syncChatList(list: Array<{id: string; name: string; createdAt: number; lastAt: number}>): Promise<void>;
    deleteChat(id: string): Promise<void>;
    setChatRole(id: string, role: string | null): Promise<void>;
    replaceMessages(chatId: string, history: any[]): Promise<void>;
    compactHistory(chatId: string, preHistory: any[], postHistory: any[]): Promise<void>;
    saveRawMessage(chatId: string, entry: any): Promise<void>;
    logTurn(record: any): Promise<void>;
    createWorkerRun(id: string, chatId: string | null): Promise<void>;
    finishWorkerRun(id: string, status: string): Promise<void>;
    recordWorkerAgent(runId: string, agent: any): Promise<void>;
    loadChatList(): Promise<Array<{id: string; name: string; createdAt: number; lastAt: number}>>;
    loadHistory(chatId: string): Promise<any[] | null>;
}

let _store: SessionStoreAdapter | null = null;

function setSessionStore(s: SessionStoreAdapter | null) { _store = s; }

function _safeCall(method, ...args) {
    if (!_store) return;
    try {
        const p = _store[method]?.(...args);
        if (p?.catch) p.catch(e => console.warn(`[session-store] ${method} failed:`, e?.message));
    } catch (e) { console.warn(`[session-store] ${method} failed:`, e?.message); }
}

async function _asyncCall<T>(method: string, ...args: any[]): Promise<T | null> {
    if (!_store || typeof _store[method] !== 'function') return null;
    try { return await _store[method](...args) as T; }
    catch (e) { console.warn(`[session-store] ${method} failed:`, (e as any)?.message); return null; }
}

// ── Chats ───────────────────────────────────────────────────────────────────

// list: [{id, name, createdAt, lastAt}, ...] — same shape chat-state.js's getChatList() returns.
function sessionSyncChatList(list) { _safeCall('syncChatList', list); }
function sessionDeleteChat(id)     { _safeCall('deleteChat', id); }
export function sessionSetChatRole(id, role) { _safeCall('setChatRole', id, role); }

// ── Messages ────────────────────────────────────────────────────────────────

// Whole-blob replace semantics, matching chat-state.js's saveHistory() (one JSON blob per chat).
function sessionSaveHistory(chatId, history) { _safeCall('replaceMessages', chatId, history); }

// Compaction lineage (net-new — no legacy behavior to preserve, adapter-only like worker runs).
// Seals the chat's current generation with the FULL pre-compaction history and opens a new
// generation with the post-compaction result — same chat_id, so the chat list/UI sees nothing
// different (Hermes Agent's session-lineage model, minus the visible child session). See
// NodeSqliteAdapter.compactHistory() for why sealing happens here rather than relying on a
// regular save having already captured the pre-compaction state.
export function sessionCompactHistory(chatId, preHistory, postHistory) { _safeCall('compactHistory', chatId, preHistory, postHistory); }

// ── Turn log ────────────────────────────────────────────────────────────────

function sessionLogTurn(record) { _safeCall('logTurn', record); }

// ── Worker runs (net-new — no legacy behavior to preserve) ────────────────────

export function sessionCreateWorkerRun(id, chatId)      { _safeCall('createWorkerRun', id, chatId); }
export function sessionFinishWorkerRun(id, status)       { _safeCall('finishWorkerRun', id, status); }
export function sessionRecordWorkerAgent(runId, agent)   { _safeCall('recordWorkerAgent', runId, agent); }

// ── Raw captures (net-new) ─────────────────────────────────────────────────────
// Audit log for content that would otherwise be silently lost — fn-tag tool-call text before
// parseFnTagCalls strips it (llm-loops.js), tool results before truncateResultForHistory
// shortens them (history.js). Unlike everything above, this gets a REAL localStorage fallback,
// not a no-op: there's no pre-existing legacy implementation to fall through to, and the whole
// point is that it stays explorable (export, future UI) even without a SessionStore adapter
// injected, per the design discussion — SQLite when available (queryable for benchmarking/
// debugging), a capped localStorage log otherwise.

const _RAW_CAP = 100; // smaller than convo-log's 200 — raw captures can be large blobs

export function sessionSaveRawMessage(chatId, entry) {
    if (!chatId) return;
    _safeCall('saveRawMessage', chatId, entry);
    try {
        const key = chatKey.raw(chatId);
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        list.push({ ts: Date.now(), ...entry });
        if (list.length > _RAW_CAP) list.splice(0, list.length - _RAW_CAP);
        localStorage.setItem(key, JSON.stringify(list));
    } catch (e) { console.warn('[session-store] raw capture localStorage fallback failed:', e?.message); }
}

function sessionLoadRawMessages(chatId) {
    try { return JSON.parse(localStorage.getItem(chatKey.raw(chatId)) || '[]'); }
    catch { return []; }
}

// Drops raw captures for this chat at/after a checkpoint's creation time — the raw-capture
// counterpart to convo-log.js's pruneConvoLogFrom, called on Rewind/Rerun for the same reason.
// ── Read methods ───────────────────────────────────────────────────────────────
// Return data from the adapter when one is injected; empty results otherwise.
// Callers (init.ts, chat-state.ts) fall back to localStorage when these return null/[].

async function sessionLoadChatList(): Promise<{id: string; name: string; createdAt: number; lastAt: number}[]> {
    return (await _asyncCall<{id: string; name: string; createdAt: number; lastAt: number}[]>('loadChatList')) ?? [];
}

async function sessionLoadHistory(chatId: string): Promise<any[] | null> {
    return _asyncCall<any[]>('loadHistory', chatId);
}

function sessionPruneRawFrom(chatId: string, sinceMs: number): void {
    if (!chatId) return;
    try {
        const key = chatKey.raw(chatId);
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const pruned = list.filter((e: { ts?: number }) => (e.ts ?? 0) < sinceMs);
        if (pruned.length !== list.length) localStorage.setItem(key, JSON.stringify(pruned));
    } catch (e) { console.warn('[session-store] raw prune failed:', e?.message); }
}

// Window bridge for classic scripts and inline handlers (ESM migration convention).
Object.assign(window, {
    setSessionStore,
    sessionSyncChatList, sessionDeleteChat, sessionSetChatRole,
    sessionSaveHistory, sessionCompactHistory,
    sessionLogTurn,
    sessionCreateWorkerRun, sessionFinishWorkerRun, sessionRecordWorkerAgent,
    sessionSaveRawMessage, sessionLoadRawMessages, sessionPruneRawFrom,
    sessionLoadChatList, sessionLoadHistory,
});
