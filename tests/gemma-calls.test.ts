// Gemma-4 native tool-call syntax left in the reply text (v0.58 fixes §2). vLLM did not extract
// it, no parser format matched, and the reply ended the turn: ~20 replies per run v0.55–v0.58,
// in SWE each followed by a blind 100-step continuation. Fixtures are real replies from the logs.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory, historyOf } from './history-helpers.ts';

const W = window as any;
beforeAll(async () => {
    await import('../model-caps.ts');
    await import('../llm-loops.ts');
    await import('../step-validator.ts');
});

const Q = '<|"|>';
const calls = (text: string) => W.parseFnTagCalls(text).tool_calls.map((c: any) => [c.function.name, JSON.parse(c.function.arguments)]);

describe('parseFnTagCalls Format K (Gemma native)', () => {
    it('execute_code with string args (v0.58 flask-5063)', () => {
        const t = `call:execute_code{code:${Q}python3 -c "import werkzeug; print(werkzeug.__name__)"${Q},language:${Q}bash${Q}}<tool_call|>`;
        expect(calls(t)).toEqual([['execute_code', { code: 'python3 -c "import werkzeug; print(werkzeug.__name__)"', language: 'bash' }]]);
        expect(W.parseFnTagCalls(t).cleaned.trim()).toBe('');
    });
    it('with the <|tool_call> opener, text before it kept', () => {
        const t = `Let me look.\n<|tool_call>call:execute_code{code:${Q}ls -a /workspace${Q},language:${Q}bash${Q}}<tool_call|>`;
        const r = W.parseFnTagCalls(t);
        expect(calls(t)).toEqual([['execute_code', { code: 'ls -a /workspace', language: 'bash' }]]);
        expect(r.cleaned.trim()).toBe('Let me look.');
    });
    it('fetch_url whose URL contains braces and quotes (v0.57 AutomationBench)', () => {
        const url = 'http://fg-gw:41125/execute?method=POST&params={"tool":"google_drive_find_multiple_files","args":{"file_types":["spreadsheet"],"max_results":5}}';
        expect(calls(`call:fetch_url{url:${Q}${url}${Q}}<tool_call|>`)).toEqual([['fetch_url', { url }]]);
    });
    it('a string missing its closing delimiter ends at the next key (v0.58 AutomationBench)', () => {
        const t = `call:fetch_url{body:${Q}{"tool": "salesforce_query", "params": {"object_type": "Opportunity"}},method:${Q}POST${Q},url:${Q}http://fg-gw:41158/execute${Q}}<tool_call|>`;
        expect(calls(t)).toEqual([['fetch_url', { body: '{"tool": "salesforce_query", "params": {"object_type": "Opportunity"}}', method: 'POST', url: 'http://fg-gw:41158/execute' }]]);
    });
    it('bare numbers, booleans, arrays and nested objects', () => {
        expect(calls(`call:read_file{path:${Q}a.py${Q},start_line:10,end_line:20}`)).toEqual([['read_file', { path: 'a.py', start_line: 10, end_line: 20 }]]);
        expect(calls(`call:run_workers{agents:[{id:${Q}w1${Q},task:${Q}t${Q}}],synthesize:false}`))
            .toEqual([['run_workers', { agents: [{ id: 'w1', task: 't' }], synthesize: false }]]);
    });
    it('ignores unknown names and prose that mentions call:', () => {
        expect(calls(`call:nope{x:${Q}1${Q}}`)).toEqual([]);
        expect(calls('The call:site is fine.')).toEqual([]);
    });
});

describe('runTurn: unparseable native call markup is retried, not the answer', () => {
    beforeEach(() => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['list_files']);
    });
    // Real replies: v0.58 requests-1142 / sympy-14531, and flask-4992 (a call whose head was cut off).
    // completion_tokens as in production: the harness default (20) would trip the separate
    // short-reply truncation retry for the 19-character one before the loop sees it.
    it.each([
        ['thought<tool_call|>', 5],
        [`…python3 tests/test_config_toml_standalone_v2.py${Q},language:${Q}bash${Q}}<tool_call|>`, 40],
    ])('%s gets a retry and the turn goes on', async (reply, tokens) => {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'Do the task.' });
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([
            { content: reply, usage: { prompt_tokens: 50, completion_tokens: tokens } },
            { content: 'The answer is 7.\nCOMPLETED' },
        ], { onRequest: b => bodies.push(b) });
        const text = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        expect(text).toContain('The answer is 7.');
        expect(text).not.toContain('<tool_call|>');
        const second = JSON.stringify(bodies[1]?.messages ?? []);
        expect(second).toContain('tool call written as text');
        expect(second).not.toContain('<tool_call|>');
    });
});
