import { describe, it, expect, beforeEach, vi } from 'vitest';

// MoonMath shipped as provider 'zro' for a few hours on 2026-11-01; config.ts carries saved settings over on load.
describe('zro → moonmath settings migration', () => {
    beforeEach(() => { localStorage.clear(); });

    it('moves the key and rewrites saved model specs once', async () => {
        localStorage.setItem('fg_zro_key', 'synthetic-old-key');
        localStorage.setItem('fg_main_models', JSON.stringify(['zro|glm-5.3-flash', 'kilo|reflection/beam-free']));
        localStorage.setItem('fg_worker_model', 'zro|deepseek-v4.1-flash');
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'zro', model: 'new-flash', label: 'New' }]));
        vi.resetModules();
        await import('../config.ts');
        expect(localStorage.getItem('fg_zro_key')).toBeNull();
        expect(localStorage.getItem('fg_moonmath_key')).toBe('synthetic-old-key');
        expect(JSON.parse(localStorage.getItem('fg_main_models')!)).toEqual(['moonmath|glm-5.3-flash', 'kilo|reflection/beam-free']);
        expect(localStorage.getItem('fg_worker_model')).toBe('moonmath|deepseek-v4.1-flash');
        expect(JSON.parse(localStorage.getItem('fg_custom_models')!)[0].provider).toBe('moonmath');
    });

    it('keeps a key already saved under the new name', async () => {
        localStorage.setItem('fg_zro_key', 'old');
        localStorage.setItem('fg_moonmath_key', 'new');
        vi.resetModules();
        await import('../config.ts');
        expect(localStorage.getItem('fg_moonmath_key')).toBe('new');
        expect(localStorage.getItem('fg_zro_key')).toBeNull();
    });
});
