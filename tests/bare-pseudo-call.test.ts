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
