// Integration tests for runTurn — the main agent loop state machine.
// Uses the replay harness to feed scripted model responses through the real loop code
// without hitting an actual LLM endpoint, turning past incident patterns into regressions.
//
// Coverage: single-step completion, multi-step continuation, tool-call round-trip,
// response capture to sessionSaveRawMessage.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP, getRawCaptures } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS, chatKey } from '../storage-keys.ts';

const W = window as any;

beforeAll(async () => {
    // llm-loops.ts puts runTurn, callOAI, _runToolCalls etc. on window.
    await import('../llm-loops.ts');
    // chat-state.ts for getChatList, newChat, activeChatId bridge
    await import('../chat-state.ts');
    // render-adapter.ts is imported directly; NULL_RENDER_ADAPTER available above.
    await import('../render-adapter.ts');
    // step-validator.ts bridges validateOutput so _validateStepOutput can call it.
    await import('../step-validator.ts');
});

function setupChat() {
    // Create a fresh chat and push a starter user message so the loop has history to send.
    W.newChat?.();
    const chatId = W.activeChatId ?? 'test_chat';
    if (!W.activeChatId) {
        localStorage.setItem(KEYS.ACTIVE_CHAT, chatId);
        W.activeChatId = chatId;
    }
    W.setOpenaiHistory?.([{ role: 'user', content: 'Do the task.' }]);
    // Skip the tool classifier: it calls callLLMComplete which would consume a scripted
    // replay step. Setting a non-null _toolFilter tells runTurn to skip classification.
    W._sessionToolFilter = new Set(['list_files', 'web_search', 'execute_code']);
    return chatId;
}

beforeEach(() => {
    localStorage.clear();
    W.fetch?.mockReset?.();
    // workers.ts sets mainAgentRole = director at module load time (persistent default).
    // Reset to null so tests that don't configure a role don't accidentally hit the
    // director-exclusion in missing_state_line.re_fail.
    W.mainAgentRole = null;
    // Configure a fast non-Google endpoint so runTurn uses the OAI path.
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

// ── Single-step completion ─────────────────────────────────────────────────────

describe('runTurn — single-step COMPLETED', () => {
    it('returns the response text stripped of the terminal token', async () => {
        setupChat();
        W.fetch = makeReplayFetch([{ content: 'The answer is 42.\n\nCOMPLETED' }]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toContain('The answer is 42.');
        expect(result).not.toContain('COMPLETED');
    });

    it('makes exactly one LLM fetch call', async () => {
        setupChat();
        const mock = makeReplayFetch([{ content: 'Done.\nCOMPLETED' }]);
        W.fetch = mock;
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const llmCalls = mock.mock.calls.filter(([u]: [string]) =>
            String(u).includes('/chat/completions'));
        expect(llmCalls).toHaveLength(1);
    });

    it('handles DONE synonym', async () => {
        setupChat();
        W.fetch = makeReplayFetch([{ content: 'All done.\n\n**DONE**' }]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toContain('All done.');
    });
});

// ── Multi-step continuation via tool call ─────────────────────────────────────

describe('runTurn — tool call then COMPLETED', () => {
    it('runs a second step after a tool call', async () => {
        setupChat();
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Analysis complete.\nCOMPLETED' },
        ]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toContain('Analysis complete.');
    });

    it('makes two LLM fetch calls when a tool call precedes completion', async () => {
        setupChat();
        const mock = makeReplayFetch([
            { tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Step 2.\nCOMPLETED' },
        ]);
        W.fetch = mock;
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const llmCalls = mock.mock.calls.filter(([u]: [string]) =>
            String(u).includes('/chat/completions'));
        expect(llmCalls).toHaveLength(2);
    });
});

// ── Tool-call round-trip ───────────────────────────────────────────────────────

describe('runTurn — tool call then completion', () => {
    it('executes list_files and feeds result back before completing', async () => {
        setupChat();
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Files listed.\nCOMPLETED' },
        ]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toContain('Files listed.');
    });

    it('pushes a tool-result message into history after execution', async () => {
        setupChat();
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const h = W.openaiHistory ?? [];
        const toolResult = h.find((m: any) => m.role === 'tool' || (m.role === 'user' && m.content?.includes?.('list_files')));
        expect(toolResult).toBeTruthy();
    });
});

// ── Response capture ───────────────────────────────────────────────────────────

describe('runTurn — sessionSaveRawMessage capture', () => {
    it('writes a response capture entry to localStorage after success', async () => {
        const chatId = setupChat();
        W.fetch = makeReplayFetch([{ content: 'Answer.\nCOMPLETED' }]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const captures = getRawCaptures(chatId);
        const responseEntry = captures.find((e: any) => e.kind === 'response');
        expect(responseEntry).toBeTruthy();
        expect(responseEntry.name).toContain('openrouter');
    });

    it('captures tool_calls in the response entry when present', async () => {
        const chatId = setupChat();
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc3', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const captures = getRawCaptures(chatId);
        const withTools = captures.find((e: any) => e.kind === 'response' && e.tool_calls?.length);
        expect(withTools).toBeTruthy();
        expect(withTools.tool_calls[0].function.name).toBe('list_files');
    });

    it('captures both steps in a two-step turn', async () => {
        const chatId = setupChat();
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc4', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const captures = getRawCaptures(chatId);
        const responses = captures.filter((e: any) => e.kind === 'response');
        expect(responses).toHaveLength(2);
    });
});

// ── Planning-text stall ────────────────────────────────────────────────────────

describe('runTurn — planning-text stall', () => {
    it('nudges instead of returning "Let me fix..." as the final answer (fg-chat 2026-07-17 Nemotron stall)', async () => {
        // Nemotron 550B emits a multi-line reasoning/analysis text that ends with
        // "Let me fix the HTML file." — no tool calls, no state token.
        // The dedicated _looksLikePlan detector was reverted with the rest of the v0.20/v0.21
        // enforcement changes (31db758). Coverage now comes from the general post-state check:
        // missing_state_line fires on any non-terminal text reply. In interactive mode the
        // FIRST text reply is deliberately exempt (ps._textSteps > 1) so a follow-up question
        // can reach the user; in autonomous mode there is no user, so workflowMode removes the
        // exemption — which is the condition benchmarks run under and where this matters.
        setupChat();
        W.setWorkflowMode?.(true);
        const planningText = "The file has issues. The `const` variables are reassigned in event listeners — that won't work.\n\nLet me fix the HTML file.";
        const mock = makeReplayFetch([
            { content: planningText },
            { content: 'Fixed the file.\nCOMPLETED' },
        ]);
        W.fetch = mock;
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        // The planning text must NOT be the final result.
        expect(result).not.toBe(planningText);
        expect(result).toContain('Fixed the file.');
        // Two LLM calls: planning text → nudge → real answer.
        const llmCalls = mock.mock.calls.filter(([u]: [string]) =>
            String(u).includes('/chat/completions'));
        expect(llmCalls).toHaveLength(2);
        W.setWorkflowMode?.(false);   // do not leak autonomous mode into sibling tests
    });
});

// ── Empty reasoning-only response ──────────────────────────────────────────────

describe('runTurn — empty reasoning-only response', () => {
    it('retries instead of ending the turn empty (fg-chat 2026-07-17 "(no text response)")', async () => {
        // A response with completion tokens spent but no visible text (reasoning-only
        // output) used to fall through every check at step 0 — no retry, no nudge —
        // and end the turn as "", finalized as "(no text response)", leaving a null
        // assistant message in history.
        setupChat();
        // Two-model list so the retry's fallback switch is instant (a single-model
        // list has no fallback and the retry backs off with a real 8s sleep). Specs
        // must exist in MODEL_CATALOG — getMainModelList prunes unknown entries.
        // Use models from _DEFAULT_MAIN_MODELS (opencode provider) which are always valid.
        localStorage.setItem(KEYS.MAIN_MODELS,
            JSON.stringify(['opencode|big-pickle', 'opencode|nemotron-3-ultra-free']));
        const mock = makeReplayFetch([
            { content: '', usage: { completion_tokens: 90 } },
            { content: 'Here is the fix.\nCOMPLETED' },
        ]);
        W.fetch = mock;
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toContain('Here is the fix.');
        const llmCalls = mock.mock.calls.filter(([u]: [string]) =>
            String(u).includes('/chat/completions'));
        expect(llmCalls).toHaveLength(2);
        // The empty assistant message was popped, not left to pollute later turns.
        const nullAssistants = (W.openaiHistory ?? []).filter(
            (m: any) => m.role === 'assistant' && !m.content && !m.tool_calls?.length);
        expect(nullAssistants).toHaveLength(0);
    });
});
