/**
 * Model routing tests — resolveWorkerModelSpec tier logic.
 * Uses window globals loaded by setup.js (no ES module imports).
 */

const W = window;

describe('resolveWorkerModelSpec — tier routing', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('returns explicit override regardless of role', () => {
        const result = W.resolveWorkerModelSpec('groq|openai/gpt-oss-120b', { tier: 'orchestrator' });
        expect(result).toBe('groq|openai/gpt-oss-120b');
    });

    it('returns first active model when no spec and no role', () => {
        // Use a kilo noKey:true model so specHasKey passes without an API key.
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|nvidia/nemotron-3-ultra-550b-a55b:free']));
        const result = W.resolveWorkerModelSpec(null, null);
        expect(result).toBe('kilo|nvidia/nemotron-3-ultra-550b-a55b:free');
    });

    it('returns first active model for execution tier (no special routing)', () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|nvidia/nemotron-3-ultra-550b-a55b:free']));
        const result = W.resolveWorkerModelSpec(null, { tier: 'execution' });
        expect(result).toBe('kilo|nvidia/nemotron-3-ultra-550b-a55b:free');
    });

    it('orchestrator tier returns main model spec when role routing is active', () => {
        // Use a kilo noKey:true model so specHasKey passes without an API key.
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|nvidia/nemotron-3-ultra-550b-a55b:free']));
        localStorage.setItem('fg_agent_role_model_routing', 'true');
        const result = W.resolveWorkerModelSpec(null, { tier: 'orchestrator' });
        expect(result).toBe('kilo|nvidia/nemotron-3-ultra-550b-a55b:free');
    });
});

describe('FREE_MODEL_BLACKLIST', () => {
    beforeEach(() => { localStorage.clear(); });
    const BAD = 'openrouter|thinkingmachines/inkling:free';

    it('is enforced for custom models too, not just the built-in catalog', () => {
        expect(W.isBlacklistedModel(BAD)).toBe(true);
        localStorage.setItem('fg_custom_models', JSON.stringify([
            { provider: 'openrouter', model: 'thinkingmachines/inkling:free', label: 'Inkling' },
        ]));
        expect(W.getAllModels().some(m => `${m.provider}|${m.model}` === BAD)).toBe(false);
    });

    it('prunes blacklisted specs from a saved main model list', () => {
        const good = 'kilo|nvidia/nemotron-3-ultra-550b-a55b:free';
        localStorage.setItem('fg_main_models', JSON.stringify([BAD, good]));
        expect(W.getMainModelList()).toEqual([good]);
    });
});
