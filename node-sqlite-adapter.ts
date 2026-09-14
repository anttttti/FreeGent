// node-sqlite-adapter.js — NodeSqliteAdapter: SessionStore backend for chat/message/
// turn-log/worker-run persistence in Node (daemon/headless). Never imported by browser
// code. Injected via window.setSessionStore() in the headless runner, mirroring how
// node-fs-adapter.js is injected via window.setWorkspaceAdapter().
//
// Uses node:sqlite (Node's built-in, no native/compiled dependency) rather than
// better-sqlite3 — this repo has zero native deps today, and the same adapter also has
// to work inside arbitrary Docker task containers (see node-fs-adapter.js's DockerFsAdapter).
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSION_SCHEMA_SQL } from './session-schema.js';
import type { SessionStoreAdapter } from './session-store.js';

// process.getBuiltinModule (Node 22.3+) rather than a static `import 'node:sqlite'` —
// Vite 5's builtin-module resolver mishandles this specifier (strips the `node:` prefix
// and tries to resolve it as an npm package) when this file is pulled into vitest's
// client/jsdom transform graph; getBuiltinModule sidesteps static import analysis entirely
// and works identically under plain Node and under vite-node.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

export class NodeSqliteAdapter implements SessionStoreAdapter {
    private _db: any = null;
    private _dbPath: string;
    private _ready: Promise<void>;

    constructor(dbPath: string) {
        this._dbPath = dbPath;
        this._ready = this._open();
    }

    async _open() {
        await mkdir(dirname(this._dbPath), { recursive: true });
        this._db = new DatabaseSync(this._dbPath);
        this._db.exec('PRAGMA journal_mode = WAL');
        this._db.exec(SESSION_SCHEMA_SQL);
    }

    async _ensure() { if (!this._db) await this._ready; return this._db; }

    async syncChatList(list) {
        const db = await this._ensure();
        const stmt = db.prepare(`
            INSERT INTO chats(id, name, created_at, last_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_at = excluded.last_at
        `);
        for (const c of list) stmt.run(c.id, c.name ?? 'New Chat', c.createdAt ?? Date.now(), c.lastAt ?? Date.now());
    }

    async deleteChat(id) {
        const db = await this._ensure();
        db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    }

    async setChatRole(id, role) {
        const db = await this._ensure();
        // A chat row may not exist yet if the role is set before the first saveChatList() sync
        // (e.g. role restored immediately after chat creation) — upsert a bare row defensively.
        db.prepare(`
            INSERT INTO chats(id, name, created_at, last_at, main_role) VALUES (?, 'New Chat', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET main_role = excluded.main_role
        `).run(id, Date.now(), Date.now(), role ?? null);
    }

    _currentGeneration(db, chatId) {
        const row = db.prepare('SELECT COALESCE(MAX(generation), 0) AS gen FROM messages WHERE chat_id = ? AND raw = 0').get(chatId);
        return row?.gen ?? 0;
    }

    _insertGeneration(db, chatId, generation, history) {
        const stmt = db.prepare(`
            INSERT INTO messages(chat_id, generation, seq, role, content, content_json, tool_calls, tool_call_id, name, raw, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);
        const now = Date.now();
        (history ?? []).forEach((m, seq) => {
            const isStringContent = typeof m?.content === 'string';
            stmt.run(
                chatId, generation, seq, m?.role ?? 'user',
                isStringContent ? m.content : null,
                isStringContent ? null : JSON.stringify(m?.content ?? null),
                m?.tool_calls ? JSON.stringify(m.tool_calls) : null,
                m?.tool_call_id ?? null,
                m?.name ?? null,
                now,
            );
        });
    }

    async replaceMessages(chatId, history) {
        const db = await this._ensure();
        // Defensively ensure the parent chat row exists — mirrors setChatRole() above.
        // messages.chat_id is a real foreign key (so ON DELETE CASCADE works when a chat is
        // deleted), so this must not depend on syncChatList() having already run first.
        db.prepare(`
            INSERT INTO chats(id, name, created_at, last_at) VALUES (?, 'New Chat', ?, ?)
            ON CONFLICT(id) DO NOTHING
        `).run(chatId, Date.now(), Date.now());
        db.exec('BEGIN');
        try {
            const gen = this._currentGeneration(db, chatId);
            db.prepare('DELETE FROM messages WHERE chat_id = ? AND generation = ? AND raw = 0').run(chatId, gen);
            this._insertGeneration(db, chatId, gen, history);
            db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    }

    // Compaction lineage (Hermes-style, hidden from the chat list): seals the CURRENT
    // generation with the full pre-compaction history (so it's captured even if a regular
    // save hasn't run recently — this must not depend on save timing) and opens a new
    // generation with the post-compaction history. Same chat_id throughout — the chats
    // table/chat list is untouched, so the user never sees this as a separate session.
    // Every prior generation stays fully queryable: SELECT * FROM messages WHERE chat_id=?
    // AND generation=? AND raw=0 ORDER BY seq.
    async compactHistory(chatId, preHistory, postHistory) {
        const db = await this._ensure();
        db.prepare(`
            INSERT INTO chats(id, name, created_at, last_at) VALUES (?, 'New Chat', ?, ?)
            ON CONFLICT(id) DO NOTHING
        `).run(chatId, Date.now(), Date.now());
        db.exec('BEGIN');
        try {
            const gen = this._currentGeneration(db, chatId);
            db.prepare('DELETE FROM messages WHERE chat_id = ? AND generation = ? AND raw = 0').run(chatId, gen);
            this._insertGeneration(db, chatId, gen, preHistory);
            this._insertGeneration(db, chatId, gen + 1, postHistory);
            db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    }

    // Append-only capture of content that would otherwise be silently lost to pruning/parsing —
    // fn-tag tool-call text before parseFnTagCalls strips it, tool results before
    // truncateResultForHistory shortens them. Not tied to seq/replace semantics (see schema
    // comment) — queryable by chat_id + created_at for benchmarking/debugging analysis.
    async saveRawMessage(chatId, entry) {
        const db = await this._ensure();
        db.prepare(`
            INSERT INTO chats(id, name, created_at, last_at) VALUES (?, 'New Chat', ?, ?)
            ON CONFLICT(id) DO NOTHING
        `).run(chatId, Date.now(), Date.now());
        db.prepare(`
            INSERT INTO messages(chat_id, seq, role, content, tool_call_id, name, raw, kind, created_at)
            VALUES (?, 0, ?, ?, ?, ?, 1, ?, ?)
        `).run(
            chatId, entry?.role ?? 'assistant', entry?.content ?? null,
            entry?.toolCallId ?? null, entry?.name ?? null, entry?.kind ?? null, Date.now(),
        );
    }

    async logTurn(record) {
        const db = await this._ensure();
        db.prepare(`
            INSERT INTO turn_log(ts, chat_id, chat_name, type, name, round, model, provider, prompt,
                prompt_tokens, response_tokens, response, tool_calls, system_prompt_snippet, last_user_message, loop_detected)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record?.ts ?? new Date().toISOString(),
            record?.chatId ?? null,
            record?.chatName ?? null,
            record?.type ?? null,
            record?.name ?? null,
            record?.round ?? null,
            record?.model ?? null,
            record?.provider ?? null,
            record?.prompt ?? null,
            record?.promptTokens ?? null,
            record?.responseTokens ?? null,
            record?.response ?? null,
            record?.toolCalls ? JSON.stringify(record.toolCalls) : null,
            record?.systemPrompt ?? null,
            record?.lastUserMessage ?? null,
            record?.loopDetected ? 1 : 0,
        );
    }

    async createWorkerRun(id, chatId) {
        const db = await this._ensure();
        db.prepare('INSERT INTO worker_runs(id, chat_id, started_at, status) VALUES (?, ?, ?, ?)')
            .run(id, chatId ?? null, Date.now(), 'running');
    }

    async finishWorkerRun(id, status) {
        const db = await this._ensure();
        db.prepare('UPDATE worker_runs SET status = ?, finished_at = ? WHERE id = ?')
            .run(status ?? 'complete', Date.now(), id);
    }

    async recordWorkerAgent(runId, agent) {
        const db = await this._ensure();
        const result = db.prepare(`
            INSERT INTO worker_agents(run_id, agent_id, role, model, task, output, error, status, note, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            runId, agent?.id ?? agent?.agentId ?? 'unknown', agent?.role ?? null, agent?.model ?? null,
            agent?.task ?? '', agent?.output ?? null, agent?.error ?? null, agent?.status ?? null,
            agent?.note ?? null, agent?.startedAt ?? Date.now(), agent?.finishedAt ?? Date.now(),
        );
        const workerAgentId = result.lastInsertRowid;
        if (agent?.staged?.length) {
            const stmt = db.prepare('INSERT INTO worker_staged_files(worker_agent_id, path, content) VALUES (?, ?, ?)');
            for (const f of agent.staged) stmt.run(workerAgentId, f.path, f.content ?? null);
        }
    }

    async close() {
        if (this._db) { this._db.close(); this._db = null; }
    }

    // ── Read methods ───────────────────────────────────────────────────────────

    async loadChatList(): Promise<{id: string; name: string; createdAt: number; lastAt: number}[]> {
        const db = await this._ensure();
        return db.prepare('SELECT id, name, created_at, last_at FROM chats WHERE archived = 0 ORDER BY last_at ASC')
            .all()
            .map((r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastAt: r.last_at }));
    }

    async loadHistory(chatId: string): Promise<any[] | null> {
        const db = await this._ensure();
        const gen = this._currentGeneration(db, chatId);
        const rows = db.prepare(
            'SELECT role, content, content_json, tool_calls, tool_call_id, name FROM messages WHERE chat_id = ? AND generation = ? AND raw = 0 ORDER BY seq',
        ).all(chatId, gen);
        if (!rows.length) return null;
        return rows.map((r: any) => ({
            role: r.role,
            content: r.content_json ? JSON.parse(r.content_json) : r.content,
            ...(r.tool_calls   ? { tool_calls:   JSON.parse(r.tool_calls) } : {}),
            ...(r.tool_call_id ? { tool_call_id: r.tool_call_id }          : {}),
            ...(r.name         ? { name:          r.name }                  : {}),
        }));
    }
}
