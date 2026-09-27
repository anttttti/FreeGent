// narration_only (llm-loops.ts _isNarrationOnly): three-band check on a no-tool-call message.
// Intent regex → narration (no model call); result markers → answer (no model call);
// both or neither → a yes/no model call decides.
import { describe, it, expect, beforeAll, vi } from 'vitest';

let M: any;
beforeAll(async () => { M = await import('../llm-loops.ts'); });

const judge = (answer: string) => vi.fn(async () => answer);

describe('_isNarrationOnly', () => {
    it('fail band: announces the next action — narration, no model call', async () => {
        const llm = judge('NO');
        expect(await M._isNarrationOnly('Let me check the player.update function to see how it handles jumping:', llm)).toBe(true);
        expect(await M._isNarrationOnly('The board renders. Next, I will add collision:', llm)).toBe(true);
        expect(llm).not.toHaveBeenCalled();
    });

    it('pass band: reports a result — not narration, no model call', async () => {
        const llm = judge('YES');
        expect(await M._isNarrationOnly('Fixed the jump: onGround was never reset after landing.', llm)).toBe(false);
        expect(await M._isNarrationOnly('Changes:\n- game.js: reset onGround\n- index.html: focus canvas', llm)).toBe(false);
        expect(await M._isNarrationOnly('The game is ready. Let me know if you want changes.', llm)).toBe(false);
        expect(llm).not.toHaveBeenCalled();
    });

    it('neither band: the model decides', async () => {
        const text = 'Checking the input handler next.';
        const yes = judge('YES'); expect(await M._isNarrationOnly(text, yes)).toBe(true);  expect(yes).toHaveBeenCalledTimes(1);
        const no  = judge('NO');  expect(await M._isNarrationOnly(text, no)).toBe(false);
        expect(String((yes.mock.calls[0] as any[])[0])).toMatch(/matched NEITHER/);
    });

    it('both band: a result followed by an intent sentence goes to the model', async () => {
        const llm = judge('NO');
        expect(await M._isNarrationOnly('Fixed the jump — onGround was never reset. I will leave the physics constants as they are.', llm)).toBe(false);
        expect(llm).toHaveBeenCalledTimes(1);
        expect(String((llm.mock.calls[0] as any[])[0])).toMatch(/matched BOTH/);
    });

    it('without a model, ambiguous text is not treated as narration (fail-open)', async () => {
        expect(await M._isNarrationOnly('Checking the input handler next.', null)).toBe(false);
    });
});
