// _isBarePseudoCall (llm-loops.ts): a no-tool-call reply that is only a pseudo tool call has no
// answer in it, so the pseudo_tool_call nudge must retry instead of returning it as the turn's
// final text (glm5.3-flash ended a turn with `read_file("game.js")`, 2026-09-29).
import { describe, it, expect, beforeAll } from 'vitest';

let M: any;
beforeAll(async () => { M = await import('../llm-loops.ts'); });

describe('_isBarePseudoCall', () => {
    it('only a call: bare', () => {
        expect(M._isBarePseudoCall('read_file("game.js")')).toBe(true);
        expect(M._isBarePseudoCall('Reading it now.\nread_file(path="game.js")')).toBe(true);
        expect(M._isBarePseudoCall('```bash\nls -la\n```')).toBe(true);
        expect(M._isBarePseudoCall('{"name": "read_file", "arguments": {"path": "game.js"}}')).toBe(true);
        expect(M._isBarePseudoCall('{"tool":"read_file","path":"fg-tasks/ledger.md"}')).toBe(true);
        expect(M._isBarePseudoCall('<invoke name="read_file"><parameter name="path">game.js</parameter></invoke>')).toBe(true);
    });

    it('a call beside a real answer: not bare', () => {
        expect(M._isBarePseudoCall('The jump bug came from onGround never being reset after landing; I fixed it in the update loop.\nread_file("game.js")')).toBe(false);
    });
});

describe('the ReAct "action" envelope is a pseudo-call', () => {
    const env = '{"action": "execute_code", "action_input": {"code": "python3 -m pytest", "language": "bash"}}';
    it('is a bare pseudo-call', () => {
        expect(M._isBarePseudoCall(env)).toBe(true);
    });
    it('a COMPLETED line after it does not pass the pseudo_tool_call check (scikit-learn-13439, v0.70)', async () => {
        const { validateOutput } = await import('../step-validator.ts');
        const hit = await validateOutput(`${env}\nCOMPLETED`, M._STEP_CHECKS, { phase: 'pre-state', llm: null });
        expect(hit?.name).toBe('pseudo_tool_call');
        expect(hit?.toolName).toBe('execute_code');
    });
    it('a ReAct final answer is not a tool call', async () => {
        const { validateOutput } = await import('../step-validator.ts');
        const hit = await validateOutput('{"action": "Final Answer", "action_input": "The bug is in line 4."}\nCOMPLETED', M._STEP_CHECKS, { phase: 'pre-state', llm: null });
        expect(hit?.name).not.toBe('pseudo_tool_call');
    });
});
