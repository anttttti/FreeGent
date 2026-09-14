// Tests for pruneOAIHistory, pruneGeminiHistory, repairOAIHistory, and _historyResult.
// Functions are on window via tests/setup.js (imported from history.ts).
import { describe, it, expect, beforeEach } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BIG = 'x'.repeat(900); // > _PRUNE_MIN_CHARS (800)
const SMALL = 'x'.repeat(100); // < _PRUNE_MIN_CHARS

let _tcId = 0;
function tcId() { return `tc_${++_tcId}`; }

// OAI history builders
function oaiAssistant(calls) {
    return { role: 'assistant', tool_calls: calls.map(([id, name, args]) => ({
        id, function: { name, arguments: JSON.stringify(args) },
    })) };
}
function oaiTool(id, content) { return { role: 'tool', tool_call_id: id, content }; }
function oaiUser(text)        { return { role: 'user', content: text }; }
function oaiAsstText(text)    { return { role: 'assistant', content: text }; }

// ── pruneOAIHistory ───────────────────────────────────────────────────────────

describe('pruneOAIHistory', () => {
    it('returns 0 and leaves history unchanged for a single read', () => {
        const id1 = tcId();
        const history = [
            oaiAssistant([[id1, 'read_file', { path: 'a.txt' }]]),
            oaiTool(id1, BIG),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(0);
        expect(history[1].content).toBe(BIG);
    });

    it('prunes the older of two reads of the same file when no write between', () => {
        const id1 = tcId(), id2 = tcId();
        const history = [
            oaiAssistant([[id1, 'read_file', { path: 'a.txt' }]]),
            oaiTool(id1, BIG),
            oaiAssistant([[id2, 'read_file', { path: 'a.txt' }]]),
            oaiTool(id2, BIG),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(BIG.length);
        expect(history[1].content).toMatch(/^\[pruned:/);
        expect(history[3].content).toBe(BIG); // most recent read kept
    });

    it('does NOT prune when a write occurred between two reads', () => {
        const id1 = tcId(), id2 = tcId(), id3 = tcId();
        const history = [
            oaiAssistant([[id1, 'read_file',  { path: 'a.txt' }]]),
            oaiTool(id1, BIG),
            oaiAssistant([[id2, 'write_file', { path: 'a.txt' }]]),
            oaiTool(id2, '{"success":true}'),
            oaiAssistant([[id3, 'read_file',  { path: 'a.txt' }]]),
            oaiTool(id3, BIG),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(0);
        expect(history[1].content).toBe(BIG);
    });

    it('does NOT prune reads smaller than the minimum threshold', () => {
        const id1 = tcId(), id2 = tcId();
        const history = [
            oaiAssistant([[id1, 'read_file', { path: 'tiny.txt' }]]),
            oaiTool(id1, SMALL),
            oaiAssistant([[id2, 'read_file', { path: 'tiny.txt' }]]),
            oaiTool(id2, SMALL),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(0);
    });

    it('handles three reads of the same file — prunes first two, keeps last', () => {
        const id1 = tcId(), id2 = tcId(), id3 = tcId();
        const history = [
            oaiAssistant([[id1, 'read_file', { path: 'f.txt' }]]),
            oaiTool(id1, BIG),
            oaiAssistant([[id2, 'read_file', { path: 'f.txt' }]]),
            oaiTool(id2, BIG),
            oaiAssistant([[id3, 'read_file', { path: 'f.txt' }]]),
            oaiTool(id3, BIG),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(BIG.length * 2);
        expect(history[1].content).toMatch(/^\[pruned:/);
        expect(history[3].content).toMatch(/^\[pruned:/);
        expect(history[5].content).toBe(BIG);
    });

    it('prunes reads of different files independently', () => {
        const a1 = tcId(), a2 = tcId(), b1 = tcId();
        const history = [
            oaiAssistant([[a1, 'read_file', { path: 'a.txt' }]]),
            oaiTool(a1, BIG),
            oaiAssistant([[b1, 'read_file', { path: 'b.txt' }]]),
            oaiTool(b1, BIG),
            oaiAssistant([[a2, 'read_file', { path: 'a.txt' }]]),
            oaiTool(a2, BIG),
        ];
        const saved = window.pruneOAIHistory(history);
        expect(saved).toBe(BIG.length); // only first read of a.txt pruned
        expect(history[1].content).toMatch(/^\[pruned:/);
        expect(history[3].content).toBe(BIG); // b.txt only read once — kept
        expect(history[5].content).toBe(BIG); // most recent a.txt — kept
    });
});

// ── repairOAIHistory ──────────────────────────────────────────────────────────

describe('repairOAIHistory', () => {
    beforeEach(() => { window.openaiHistory = []; });

    it('leaves a clean conversation untouched', () => {
        const id1 = tcId();
        window.openaiHistory = [
            oaiUser('hello'),
            oaiAssistant([[id1, 'read_file', { path: 'f.txt' }]]),
            oaiTool(id1, 'content'),
            oaiAsstText('Done.'),
        ];
        window.repairOAIHistory();
        expect(window.openaiHistory).toHaveLength(4);
    });

    it('removes null entries', () => {
        window.openaiHistory = [oaiUser('hi'), null, oaiAsstText('ok'), null];
        window.repairOAIHistory();
        expect(window.openaiHistory).toHaveLength(2);
        expect(window.openaiHistory.every(m => m != null)).toBe(true);
    });

    it('strips trailing orphaned tool messages', () => {
        const id1 = tcId();
        window.openaiHistory = [
            oaiUser('go'),
            oaiTool(id1, 'orphan'), // no preceding assistant with this id
        ];
        window.repairOAIHistory();
        expect(window.openaiHistory.some(m => m.role === 'tool')).toBe(false);
    });

    it('removes trailing assistant message that declared tool_calls with no responses', () => {
        const id1 = tcId();
        window.openaiHistory = [
            oaiUser('go'),
            oaiAssistant([[id1, 'read_file', { path: 'f.txt' }]]),
            // no tool response follows
        ];
        window.repairOAIHistory();
        expect(window.openaiHistory).toHaveLength(1);
        expect(window.openaiHistory[0].role).toBe('user');
    });

    it('removes an assistant+tool turn where a tool_call_id has no matching response', () => {
        const id1 = tcId(), id2 = tcId();
        window.openaiHistory = [
            oaiUser('go'),
            oaiAssistant([[id1, 'read_file', { path: 'a.txt' }], [id2, 'read_file', { path: 'b.txt' }]]),
            oaiTool(id1, 'content-a'), // id2 has no response
        ];
        window.repairOAIHistory();
        // The broken assistant+tool block is removed, only user remains
        expect(window.openaiHistory).toHaveLength(1);
        expect(window.openaiHistory[0].role).toBe('user');
    });

    it('removes orphaned tool messages not declared by any assistant', () => {
        const id1 = tcId(), id2 = tcId();
        window.openaiHistory = [
            oaiAssistant([[id1, 'read_file', { path: 'f.txt' }]]),
            oaiTool(id1, 'content'),   // valid — id1 is declared above
            oaiUser('nudge'),
            oaiTool(id2, 'orphan'),    // id2 declared nowhere
        ];
        window.repairOAIHistory();
        const roles = window.openaiHistory.map(m => m.role);
        // The orphaned tool after user must be removed; the valid tool(id1) may be kept
        const userIdx = roles.indexOf('user');
        expect(userIdx).toBeGreaterThan(-1);
        expect(roles.slice(userIdx + 1).every(r => r !== 'tool')).toBe(true);
    });
});

// ── _historyResult raw capture ─────────────────────────────────────────────────
// Otherwise-lost content (truncated tool results) gets captured via sessionSaveRawMessage
// so it stays explorable for benchmarking/debugging — see session-store.js.

describe('_historyResult — raw capture on truncation', () => {
    beforeEach(() => {
        window.activeChatId = 'c1';
        localStorage.setItem('fg_agent_max_tool_result', '100');
        localStorage.setItem('fg_agent_tool_result_truncation', 'true');
    });

    it('captures the untruncated original when truncation actually shortens the result', () => {
        const calls = [];
        window.sessionSaveRawMessage = (chatId, entry) => calls.push({ chatId, entry });
        const big = 'x'.repeat(500);
        window._historyResult('read_file', { path: 'f.txt', content: big }, false);
        expect(calls).toHaveLength(1);
        expect(calls[0].chatId).toBe('c1');
        expect(calls[0].entry.kind).toBe('tool_truncate');
        expect(calls[0].entry.name).toBe('read_file');
        expect(JSON.parse(calls[0].entry.content).content).toBe(big); // full, untruncated
    });

    it('does not capture when the result is small enough to pass through unchanged', () => {
        const calls = [];
        window.sessionSaveRawMessage = (chatId, entry) => calls.push({ chatId, entry });
        window._historyResult('read_file', { path: 'f.txt', content: 'tiny' }, false);
        expect(calls).toHaveLength(0);
    });
});
