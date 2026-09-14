// Replay harness for runTurn integration tests.
//
// Usage:
//   window.fetch = makeReplayFetch([
//     { content: 'Step 1.\nCONTINUING' },
//     { tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
//     { content: 'Done.\nCOMPLETED' },
//   ]);
//   const result = await window.runTurn(FAKE_EP, window.NULL_RENDER_ADAPTER);
//
// Fake fetch serves scripted OAI JSON responses in sequence to LLM endpoint calls.
// Non-LLM fetches (search, tool network calls) get an empty-ok response.

import { vi } from 'vitest';

export interface ScriptedStep {
    content?: string | null;
    tool_calls?: Array<{
        id:       string;
        type?:    string;
        function: { name: string; arguments: string };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// A fake endpoint that routes through the OAI path without a local proxy.
// Pass this as the first argument to runTurn.
export const FAKE_EP = {
    provider: 'openrouter',
    url:      'https://openrouter.ai/api/v1/chat/completions',
    key:      'test-key',
    model:    'test-model',
};

export interface ReplayFetchOptions {
    /** Called with the parsed request body for each LLM call — useful for Phase 3 payload assertions. */
    onRequest?: (body: any) => void;
}

// Returns a vitest fetch mock that serves `steps` as OAI JSON responses in order.
// Each LLM call consumes the next step; extra calls beyond the list return COMPLETED.
export function makeReplayFetch(steps: ScriptedStep[], opts: ReplayFetchOptions = {}): ReturnType<typeof vi.fn> {
    let idx = 0;
    return vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const isLLM = u.includes('/chat/completions') || u.includes('generativelanguage.googleapis');
        if (!isLLM) {
            // Non-LLM fetch (proxy, search, api/keys, etc.) — return harmless empty ok
            return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) };
        }
        // Parse and forward the request body for inspection.
        if (opts.onRequest && init?.body) {
            try { opts.onRequest(JSON.parse(init.body as string)); } catch {}
        }
        const step = steps[idx++] ?? { content: 'COMPLETED' };
        const msg: any = { role: 'assistant', content: step.content ?? null };
        if (step.tool_calls?.length) msg.tool_calls = step.tool_calls;
        return {
            ok:      true,
            headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
            json:    async () => ({
                choices: [{ message: msg }],
                usage:   {
                    prompt_tokens:     step.usage?.prompt_tokens     ?? 50,
                    completion_tokens: step.usage?.completion_tokens ?? 20,
                },
            }),
        };
    });
}

// Returns raw messages captured for a chat from localStorage (via chatKey.raw).
export function getRawCaptures(chatId: string): any[] {
    try { return JSON.parse(localStorage.getItem(`fg_chat_${chatId}_raw`) || '[]'); } catch { return []; }
}
