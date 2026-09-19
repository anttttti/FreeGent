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
        // Use a kilo noKey:true model so specHasKey passes without an API key.
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|thinkingmachines/inkling:free']));
        const result = W.resolveWorkerModelSpec(null, null);
        expect(result).toBe('kilo|thinkingmachines/inkling:free');
    });

    it('returns first active model for execution tier (no special routing)', () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|thinkingmachines/inkling:free']));
        const result = W.resolveWorkerModelSpec(null, { tier: 'execution' });
        expect(result).toBe('kilo|thinkingmachines/inkling:free');
    });

    it('orchestrator tier returns main model spec when role routing is active', () => {
        // Use a kilo noKey:true model so specHasKey passes without an API key.
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|thinkingmachines/inkling:free']));
        localStorage.setItem('fg_agent_role_model_routing', 'true');
        const result = W.resolveWorkerModelSpec(null, { tier: 'orchestrator' });
        expect(result).toBe('kilo|thinkingmachines/inkling:free');
    });
});
