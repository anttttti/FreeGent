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
        const result = W.resolveWorkerModelSpec('mistral|mistral-large', { tier: 'orchestrator' });
        expect(result).toBe('mistral|mistral-large');
    });

    it('returns first active model when no spec and no role', () => {
        // Use a model from _DEFAULT_MAIN_MODELS so getMainModelList() passes _validSpec.
        localStorage.setItem('fg_main_models', JSON.stringify(['opencode|big-pickle']));
        const result = W.resolveWorkerModelSpec(null, null);
        expect(result).toBe('opencode|big-pickle');
    });

    it('returns first active model for execution tier (no special routing)', () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['opencode|big-pickle']));
        const result = W.resolveWorkerModelSpec(null, { tier: 'execution' });
        expect(result).toBe('opencode|big-pickle');
    });

    it('orchestrator tier returns main model spec when role routing is active', () => {
        // Set a known main model so the result is predictable.
        localStorage.setItem('fg_main_models', JSON.stringify(['opencode|nemotron-3-ultra-free']));
        localStorage.setItem('fg_agent_role_model_routing', 'true');
        const result = W.resolveWorkerModelSpec(null, { tier: 'orchestrator' });
        expect(result).toBe('opencode|nemotron-3-ultra-free');
    });
});
