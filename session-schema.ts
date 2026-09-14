// session-schema.js — canonical SQLite DDL for chat/message/turn-log/worker persistence.
// Imported by both node-sqlite-adapter.ts (native node:sqlite) and, later, the browser
// WASM+OPFS adapter — defining the schema once here is what actually guarantees a
// session database is portable between the two, not just an assertion.
// Browser-safe: no Node or WASM imports.

export const SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1');

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'New Chat',
  created_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  main_role   TEXT,
  archived    INTEGER NOT NULL DEFAULT 0
);

-- raw=0 rows are the live, pruned history for the chat's CURRENT generation —
-- replaceMessages() does a whole-generation delete+reinsert keyed by (chat_id, generation,
-- seq), enforced by the partial unique index below. A chat starts at generation 0; each
-- compaction seals the current generation (rewritten with the full pre-compaction history,
-- so it's never lossy even if a regular save hadn't run recently) and opens generation+1 as
-- the new current one — same idea as Hermes Agent's session lineage, except the lineage
-- lives inside ONE chat_id/one chats row instead of spinning off a new visible session, so
-- the chat list UI sees nothing different. Only the latest generation is "the chat" for
-- normal reads; every prior generation stays fully queryable for recovery/debugging.
-- raw=1 rows are append-only captures of content that would otherwise be silently lost
-- (fn-tag tool-call text before parseFnTagCalls strips it, tool results before
-- truncateResultForHistory shortens them, failed requests) — NOT tied to seq/replace
-- semantics at all, since precise alignment with the live array isn't needed for an
-- audit/debug log that's correlated by chat_id + created_at. seq/generation are unused (0)
-- on raw rows; kind/name describe what was captured.
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation   INTEGER NOT NULL DEFAULT 0,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT,
  content_json TEXT,
  tool_calls   TEXT,
  tool_call_id TEXT,
  name         TEXT,
  raw          INTEGER NOT NULL DEFAULT 0,
  kind         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_live_unique ON messages(chat_id, generation, seq) WHERE raw = 0;
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, generation, seq);
CREATE INDEX IF NOT EXISTS idx_messages_raw ON messages(chat_id, raw, created_at);

-- Full-text search, external-content mode: indexes text living in messages, no duplicated
-- storage. Query by joining back to messages on rowid — the FTS table only holds the
-- indexed columns, not chat_id/role/generation/etc:
--   SELECT m.* FROM messages m JOIN messages_fts f ON f.rowid = m.id
--   WHERE messages_fts MATCH 'compaction OR "HTTP 400"' ORDER BY rank;
-- The three triggers below are required for external-content FTS5 — without them the index
-- goes stale (or references deleted rowids) whenever a row is written or removed, including
-- via the ON DELETE CASCADE from chats above (SQLite fires row triggers for cascade deletes
-- the same as an explicit DELETE).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, name, tool_calls, kind,
  content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, name, tool_calls, kind)
  VALUES (new.id, new.content, new.name, new.tool_calls, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, name, tool_calls, kind)
  VALUES ('delete', old.id, old.content, old.name, old.tool_calls, old.kind);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, name, tool_calls, kind)
  VALUES ('delete', old.id, old.content, old.name, old.tool_calls, old.kind);
  INSERT INTO messages_fts(rowid, content, name, tool_calls, kind)
  VALUES (new.id, new.content, new.name, new.tool_calls, new.kind);
END;

-- chat_id is NOT a foreign key here: turn-log writes are best-effort/audit-log style and
-- must never hard-fail because the chats row hasn't been synced yet (e.g. a race between
-- the first logged turn and the chat-list sync). messages.chat_id below IS enforced, since
-- that relationship is fully owned by this adapter's own call order (see NodeSqliteAdapter).
-- type/name distinguish what kind of entry this is: null = a regular main-loop turn,
-- 'nudge' = a framework nudge (name = nudge name, e.g. 'post_state_validation'),
-- 'validation' = a step-validator judge call (name = check name, e.g. 'missing_state_line').
-- prompt is only meaningful for 'validation' rows (what was actually asked to the judge) —
-- these calls are otherwise invisible once their live UI step box scrolls away or the page
-- reloads: not in openaiHistory (see llm-loops.js/callLLMComplete), so this is their only
-- durable record.
CREATE TABLE IF NOT EXISTS turn_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                     TEXT NOT NULL,
  chat_id                TEXT,
  chat_name              TEXT,
  type                   TEXT,
  name                   TEXT,
  round                  INTEGER,
  model                  TEXT,
  provider               TEXT,
  prompt                 TEXT,
  prompt_tokens          INTEGER,
  response_tokens        INTEGER,
  response               TEXT,
  tool_calls             TEXT,
  system_prompt_snippet  TEXT,
  last_user_message      TEXT,
  loop_detected          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turn_log_chat_ts ON turn_log(chat_id, ts);

-- Same external-content FTS5 pattern as messages_fts above.
--   SELECT t.* FROM turn_log t JOIN turn_log_fts f ON f.rowid = t.id
--   WHERE turn_log_fts MATCH 'compaction_loss OR "HTTP 400"' ORDER BY rank;
CREATE VIRTUAL TABLE IF NOT EXISTS turn_log_fts USING fts5(
  response, prompt, name, last_user_message, system_prompt_snippet, tool_calls,
  content='turn_log', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS turn_log_ai AFTER INSERT ON turn_log BEGIN
  INSERT INTO turn_log_fts(rowid, response, prompt, name, last_user_message, system_prompt_snippet, tool_calls)
  VALUES (new.id, new.response, new.prompt, new.name, new.last_user_message, new.system_prompt_snippet, new.tool_calls);
END;
CREATE TRIGGER IF NOT EXISTS turn_log_ad AFTER DELETE ON turn_log BEGIN
  INSERT INTO turn_log_fts(turn_log_fts, rowid, response, prompt, name, last_user_message, system_prompt_snippet, tool_calls)
  VALUES ('delete', old.id, old.response, old.prompt, old.name, old.last_user_message, old.system_prompt_snippet, old.tool_calls);
END;
CREATE TRIGGER IF NOT EXISTS turn_log_au AFTER UPDATE ON turn_log BEGIN
  INSERT INTO turn_log_fts(turn_log_fts, rowid, response, prompt, name, last_user_message, system_prompt_snippet, tool_calls)
  VALUES ('delete', old.id, old.response, old.prompt, old.name, old.last_user_message, old.system_prompt_snippet, old.tool_calls);
  INSERT INTO turn_log_fts(rowid, response, prompt, name, last_user_message, system_prompt_snippet, tool_calls)
  VALUES (new.id, new.response, new.prompt, new.name, new.last_user_message, new.system_prompt_snippet, new.tool_calls);
END;

-- chat_id is not a foreign key for the same reason as turn_log.chat_id above.
CREATE TABLE IF NOT EXISTS worker_runs (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS worker_agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  role          TEXT,
  model         TEXT,
  task          TEXT NOT NULL,
  output        TEXT,
  error         TEXT,
  status        TEXT,
  note          TEXT,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_worker_agents_run ON worker_agents(run_id);

CREATE TABLE IF NOT EXISTS worker_staged_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_agent_id  INTEGER NOT NULL REFERENCES worker_agents(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  content          TEXT
);
`;

// Window bridge for classic scripts and the headless runner (ESM migration convention).
Object.assign(window, { SESSION_SCHEMA_SQL });
