// convo-log.js — FreeGent: conversation logging and export
// Depends on: config.js, chat-state.js
// Loaded after chat-state.js, before agent-core.js
import { chatKey, SESSION_KEYS } from './storage-keys.js';
import { FG_VERSION } from './build-info.js';
import { SESSION_ID } from './dev-log.js';
import { escapeHtml } from './html-escape.js';
import { redactText } from './secrets.js';
import { getMcpServers } from './mcp.js';
import { getChatHistory, setChatHistory } from './chat-history.js';

// ── In-memory session log ─────────────────────────────────────────────────
// Each entry records one LLM response turn (may include tool calls).
// Two-layer persistence: sessionStorage (hot-reload cache, ephemeral) and a per-chat store
// that survives page reloads and is restored on chat switch — the session store's turn log
// (IndexedDB) in the browser, per-chat localStorage (fg_chat_<id>_log) without one.

type ConvoLogEntry = {
    ts: string;
    chatId: string | null;
    chatName: string | null;
    round?: number;
    step?: number;
    type?: string;
    name?: string;
    prompt?: string;
    model?: string;
    provider?: string;
    promptTokens?: number;
    cachedTokens?: number;
    responseTokens?: number;
    response?: string;
    toolCalls?: unknown[];
    systemPrompt?: string;
    lastUserMessage?: string;
    loopDetected?: boolean;
    history?: unknown[];
    // classify_tools entries
    selected?: string[] | null;
    taskText?: string;
};

let conversationLog: ConvoLogEntry[] = [];

// Restore any log saved to sessionStorage (survives hot-reloads within a tab session).
try {
    const saved = sessionStorage.getItem(SESSION_KEYS.CONVO_LOG);
    if (saved) conversationLog = JSON.parse(saved);
} catch {}

const _LOG_CAP = 200;

// Injected by headless-runner to write turns to the per-task JSONL log file.
// Using a module-level slot avoids the static-import aliasing problem: llm-loops.ts
// imports convoLogTurn directly, so patching window/globalThis doesn't intercept it.
let _headlessWriter: ((record: object) => void) | null = null;
export function setConvoLogWriter(fn: ((record: object) => void) | null): void { _headlessWriter = fn; }

// Injected by headless-runner per run() call to accumulate per-task metrics
// (steps, tokens, compactions). Installed before runAgentTurn, cleared in finally.
let _metricsWriter: ((record: object) => void) | null = null;
export function setMetricsWriter(fn: ((record: object) => void) | null): void { _metricsWriter = fn; }
/** Report a model request that is not a main-loop step (a worker's request) to the run's metrics
 *  only: it is counted, not added to the conversation log. No-op outside a headless run. */
export function metricsNote(record: { type: string; promptTokens?: number; responseTokens?: number; cachedTokens?: number }): void {
    try { _metricsWriter?.(record); } catch {}
}

export function convoLogTurn(entry: Partial<ConvoLogEntry>): void {
    const record = {
        ts:             new Date().toISOString(),
        chatId:         activeChatId ?? null,
        chatName:       (() => { try { return getChatList().find(c => c.id === activeChatId)?.name ?? null; } catch { return null; } })(),
        ...entry,
    };
    conversationLog.push(record);
    if (conversationLog.length > _LOG_CAP) conversationLog.splice(0, conversationLog.length - _LOG_CAP);
    try { sessionStorage.setItem(SESSION_KEYS.CONVO_LOG, JSON.stringify(conversationLog)); } catch {}
    // Per-chat localStorage persistence so the log survives full page reloads, unless the
    // session store keeps it (sessionLogTurn below). loadChatLog() reads it back on chat switch.
    if (record.chatId && !(typeof sessionHas === 'function' && sessionHas('loadTurnLog'))) {
        try {
            const key = chatKey.log(record.chatId);
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            list.push(record);
            if (list.length > _LOG_CAP) list.splice(0, list.length - _LOG_CAP);
            localStorage.setItem(key, JSON.stringify(list));
        } catch {}
    }
    // Additive: also persist to the session-store adapter (SQLite in daemon/headless mode)
    // for durable, queryable turn history. No-op when no adapter is injected.
    sessionLogTurn?.(record);
    _headlessWriter?.(record);
    _metricsWriter?.(record);
}

// A chat's persisted log: the session store's copy, else the localStorage one.
async function _loadPersistedLog(chatId: string): Promise<ConvoLogEntry[]> {
    const fromStore = typeof sessionHas === 'function' && sessionHas('loadTurnLog') ? await sessionLoadTurnLog(chatId, _LOG_CAP) : [];
    if (fromStore.length) return fromStore;
    const saved = localStorage.getItem(chatKey.log(chatId));
    return saved ? JSON.parse(saved) : [];
}

// Merge a chat's persisted log into the in-memory conversationLog. Called by switchToChat so
// the log viewer and exports correctly reflect the restored session's history after a reload.
async function loadChatLog(chatId: string | null): Promise<void> {
    if (!chatId) return;
    try {
        const entries = await _loadPersistedLog(chatId);
        if (!entries.length) return;
        // Replace any existing in-memory entries for this chat with the persisted ones
        // (sessionStorage may have a stale subset; localStorage is the authoritative copy).
        conversationLog = [
            ...conversationLog.filter(e => e.chatId !== chatId),
            ...entries,
        ];
        window.conversationLog = conversationLog;
        _updateLogBadge();
    } catch {}
}

// Per-chat numbers for the Chats tab: user turns and the models that answered (with step counts).
async function getChatStats(chatId: string): Promise<{ turns: number; models: { model: string; steps: number }[] }> {
    const hist = (await _chatHistoryFor(chatId)) ?? [];
    const turns = hist.filter((m: any) => m?.role === 'user').length;
    const counts = new Map<string, number>();
    try {
        for (const e of await _loadPersistedLog(chatId)) {
            const m = e.model; if (m) counts.set(m, (counts.get(m) || 0) + 1);
        }
    } catch {}
    return { turns, models: [...counts].map(([model, steps]) => ({ model, steps })).sort((a, b) => b.steps - a.steps) };
}

// Drops turns logged for this chat at/after a checkpoint's creation time. Called on
// Rewind/Rerun so a superseded run's log entries don't linger alongside the replacement —
// without this, conversationLog only ever grows, and a single export can show the same
// failed attempt repeated many times over instead of just the current one.
function pruneConvoLogFrom(chatId: string, sinceMs: number): void {
    const before = conversationLog.length;
    conversationLog = conversationLog.filter(e => !(e.chatId === chatId && new Date(e.ts).getTime() >= sinceMs));
    if (conversationLog.length !== before) {
        window.conversationLog = conversationLog; // Object.assign below only copied the reference once
        try { sessionStorage.setItem(SESSION_KEYS.CONVO_LOG, JSON.stringify(conversationLog)); } catch {}
        _updateLogBadge();
    }
    // Also prune the per-chat localStorage so restored sessions don't replay pruned entries.
    try {
        const key = chatKey.log(chatId);
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const pruned = list.filter((e: ConvoLogEntry) => new Date(e.ts).getTime() < sinceMs);
        if (pruned.length !== list.length) localStorage.setItem(key, JSON.stringify(pruned));
    } catch {}
    if (typeof sessionPruneTurnLogFrom === 'function') sessionPruneTurnLogFrom(chatId, sinceMs);
}

// A chat's LLM history: in memory for the active chat, else its localStorage cache, else the
// session store (localStorage keeps only the most recent chats — see saveHistory).
async function _chatHistoryFor(id: string): Promise<any[] | null> {
    if (id === activeChatId) { const live = getChatHistory(); if (live.length) return live; }
    let cached: any[] | null = null;
    try { const oh = localStorage.getItem(chatKey.oh(id)); if (oh) cached = JSON.parse(oh); } catch {}
    // The localStorage copy can be a trimmed snapshot (first message + recent tail) of a history
    // the store holds whole, or a newer one the async store save hasn't reached yet: the longer wins.
    const stored = typeof sessionLoadHistory === 'function' ? (await sessionLoadHistory(id)) ?? null : null;
    let stamp: HistoryStamp | null = null;
    try { stamp = JSON.parse(localStorage.getItem(chatKey.rev(id)) || 'null'); } catch {}
    return chooseHistory(cached, stored, stamp);
}

/** What saveHistory records beside the localStorage copy: which save wrote it, whether it is a
 *  trimmed snapshot, and which save the session store last acknowledged. */
export interface HistoryStamp { rev: string; trimmed: boolean; acked?: string }

/**
 * Picks the history to use when the localStorage copy and the session store disagree.
 * Length is not freshness: after a rewind the cache is shorter and newer than a store whose save
 * has not landed. The stamp settles it:
 *   - cache whole (not trimmed)            → the cache, it is the latest synchronous write;
 *   - cache trimmed, store acked that save → the store holds that save in full;
 *   - cache trimmed, store behind          → the longer of the two (the cache is partial);
 *   - no stamp (older cache)               → the longer of the two.
 */
export function chooseHistory(cached: any[] | null, stored: any[] | null, stamp: HistoryStamp | null): any[] | null {
    if (!cached || !stored) return stored ?? cached;
    if (!stamp || typeof stamp.rev !== 'string') return fullerHistory(cached, stored);
    if (!stamp.trimmed) return cached;
    if (stamp.acked === stamp.rev) return stored;
    return fullerHistory(cached, stored);
}
export function fullerHistory(cached: any[] | null, stored: any[] | null): any[] | null {
    if (cached && stored) return stored.length >= cached.length ? stored : cached;
    return stored ?? cached;
}

// ── Badge helper ──────────────────────────────────────────────────────────

export function _updateLogBadge() {
    const el = document.getElementById('convo-log-count');
    if (el) el.textContent = conversationLog.length ? ` (${conversationLog.length})` : '';
}

// ── Download helpers ───────────────────────────────────────────────────────

function _downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href  = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    // Revoked after the browser has started the download: a synchronous revoke cancels it in Firefox.
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function _slugDate() {
    return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

const _turnKey = (e: ConvoLogEntry) => `${e.ts}|${e.step ?? ''}|${e.round ?? ''}|${e.type ?? ''}|${e.model ?? ''}`;
/** Union of two copies of a chat's turn log, by identity, oldest first. The same turn in both is kept once
 *  (the in-memory copy wins: it is the one still being written). */
export function mergeTurnLogs(memory: ConvoLogEntry[], persisted: ConvoLogEntry[]): ConvoLogEntry[] {
    const byKey = new Map<string, ConvoLogEntry>();
    for (const e of persisted) byKey.set(_turnKey(e), e);
    for (const e of memory) byKey.set(_turnKey(e), e);
    return [...byKey.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

async function _buildChatPayload(id) {
    const list = getChatList();
    const meta = list.find(c => c.id === id);
    const oai = await _chatHistoryFor(id);
    // conversationLog holds only chats opened this session and is itself capped, so a non-empty memory
    // subset can be a tail of the chat: merge it with the persisted log instead of preferring it.
    let persisted: ConvoLogEntry[] = [];
    try { persisted = await _loadPersistedLog(id); } catch {}
    const turns = mergeTurnLogs(conversationLog.filter(e => e.chatId === id), persisted);

    const payload = {
        exportedAt: new Date().toISOString(),
        deployVersion: FG_VERSION,
        sessionId: SESSION_ID,
        cfKeys: typeof getCfKeysDiagnostics === 'function' ? getCfKeysDiagnostics() : null,
        id,
        name:       meta?.name ?? 'Untitled',
        createdAt:  meta?.createdAt ? new Date(meta.createdAt).toISOString() : null,
        lastAt:     meta?.lastAt    ? new Date(meta.lastAt).toISOString()    : null,
        geminiHistory: null,
        openaiHistory: oai,
        sessionLogTurns: turns,
        // What the export holds, so a capped log does not read as a complete session.
        sessionLogInfo: { retained: turns.length, cap: _LOG_CAP, firstTs: turns[0]?.ts ?? null, lastTs: turns.at(-1)?.ts ?? null,
            possiblyTruncated: turns.length >= _LOG_CAP },
        // fn-tag strips, tool-result truncations, and failed requests — content that never
        // enters the exported history/sessionLogTurns at all (see session-store.js). Without this,
        // a failure cascade with no successful turn in between is a silent gap in every export.
        rawCaptures: typeof sessionLoadRawMessages === 'function' ? await sessionLoadRawMessages(id) : [],
    };
    return payload;
}

async function exportChat(id) {
    if (!id) { alert('No chat to export.'); return; }
    _downloadBlob(
        new Blob([JSON.stringify(await _buildChatPayload(id), null, 2)], { type: 'application/json' }),
        `fg-chat-${_slugDate()}.json`
    );
}

// ── Send a chat log to the developer (one tap, no download/upload) ────────────
// POSTs the chat JSON to the Worker's /log endpoint (cf-worker/worker.js), which keeps it for 14 days.
// Credentials are removed first: this chat may hold pasted keys, and the user's own saved keys.
export function redactSecrets(text: string, extra: string[] = []): string {
    return redactText(text, extra);
}
export function storedSecretValues(): string[] {
    const vals: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || '';
            if (/key|token|secret|password/i.test(k)) { const v = localStorage.getItem(k) || ''; if (v) vals.push(v.replace(/^"|"$/g, '')); }
        }
        // MCP server headers hold credentials under a key name that does not match the pattern above.
        for (const srv of getMcpServers()) vals.push(...Object.values(srv.headers || {}).map(String));
    } catch {}
    return vals;
}
/** The chat's payload as JSON with stored credentials removed (what sendChatLog posts). */
export async function buildRedactedChatJson(id: string): Promise<string> {
    return redactSecrets(JSON.stringify(await _buildChatPayload(id)), storedSecretValues());
}
async function sendChatLog(id) {
    if (!id) { alert('No chat to send.'); return; }
    const url = 'https://proxy.freegent.ai/log';
    if (!confirm('Send this chat (messages, tool calls and results) to the FreeGent developer for debugging? API keys are removed first. It is kept for 14 days.')) return;
    try {
        const body = redactSecrets(JSON.stringify(await _buildChatPayload(id)), storedSecretValues());
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) throw new Error(j.error || `HTTP ${r.status}`);
    } catch (e) {
        alert(`Could not send the log: ${(e as any)?.message ?? e}. Use the ⬇ download instead.`);
    }
}

// ── Markdown export ───────────────────────────────────────────────────────

async function exportChatMarkdown(id) {
    if (!id) { alert('No chat to export.'); return; }
    const list = getChatList();
    const meta = list.find(c => c.id === id);
    const history: any[] = (await _chatHistoryFor(id)) ?? [];

    const lines: string[] = [`# ${meta?.name ?? 'Chat'}\n`];
    for (const msg of history) {
        if (msg.role === 'system') {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            lines.push(`## System\n\n${content}\n`);
            continue;
        }
        if (msg.role === 'user') {
            const content = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content)
                    ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
                    : JSON.stringify(msg.content));
            lines.push(`## User\n\n${content}\n`);
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls?.length) {
                const names = msg.tool_calls.map((tc: any) => tc.function?.name ?? '?').join(', ');
                if (msg.content?.trim()) {
                    lines.push(`## Assistant\n\n${msg.content}\n\n> *(tool calls: ${names})*\n`);
                } else {
                    lines.push(`## Assistant\n\n> *(tool calls: ${names})*\n`);
                }
            } else if (msg.content?.trim()) {
                lines.push(`## Assistant\n\n${msg.content}\n`);
            }
        }
        // role='tool' results are omitted — they are verbose and not human-readable
    }
    _downloadBlob(
        new Blob([lines.join('\n')], { type: 'text/markdown' }),
        `fg-chat-${_slugDate()}.md`
    );
}

// ── Import chat history from JSON export ──────────────────────────────────

async function importChat() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        let data: any;
        try { data = JSON.parse(await file.text()); }
        catch { alert('Could not parse file — is it a valid FreeGent JSON export?'); return; }
        if (!Array.isArray(data?.openaiHistory)) {
            alert('File does not look like a FreeGent chat export (missing openaiHistory array).');
            return;
        }
        // Create a new chat, populate it, and persist.
        createNewChat?.();
        setChatHistory(data.openaiHistory);

        // Restore the chat name from the export.
        if (data.name) {
            const id = activeChatId;
            const chatList = getChatList?.() ?? [];
            const entry = chatList.find((c: any) => c.id === id);
            if (entry) {
                entry.name = data.name;
                saveChatList?.(chatList);
            }
        }

        // Restore conversation log turns if present.
        if (Array.isArray(data.sessionLogTurns)) {
            const id = activeChatId;
            for (const t of data.sessionLogTurns) conversationLog.push({ ...t, chatId: id });
        }

        saveHistory?.();
        updateChatNameBar?.();
        renderChatsDropdown?.();
        // Render history from JSON since there is no saved HTML for the imported chat.
        renderHistoryFallback?.(activeChatId);
    };
    input.click();
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { metricsNote, getChatStats, conversationLog, convoLogTurn, loadChatLog, _updateLogBadge, exportChat, sendChatLog, exportChatMarkdown, importChat, esc: escapeHtml, pruneConvoLogFrom });
