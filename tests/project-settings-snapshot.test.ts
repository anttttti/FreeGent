// codex report 8, cases 298-303: Clear / import restored the settings it had snapshotted over newer edits.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let apply: (snap: any) => void;
beforeAll(async () => { apply = (await import('../workspace.ts'))._applySettingsSnapshot; });
beforeEach(() => localStorage.clear());

describe('_applySettingsSnapshot', () => {
    it('restores a key the operation emptied or removed', () => {
        localStorage.setItem('fg_groq_key', '');
        apply({ fg_groq_key: 'k1', fg_gone: 'v' });
        expect(localStorage.getItem('fg_groq_key')).toBe('k1');
        expect(localStorage.getItem('fg_gone')).toBe('v');
    });
    it('keeps a value the user changed while the operation ran', () => {
        localStorage.setItem('fg_turn_sound', '0');
        localStorage.setItem('fg_temperature', '0.2');
        localStorage.setItem('fg_profiles', '[{"name":"new"}]');
        apply({ fg_turn_sound: '1', fg_temperature: '0.7', fg_profiles: '[]' });
        expect(localStorage.getItem('fg_turn_sound')).toBe('0');
        expect(localStorage.getItem('fg_temperature')).toBe('0.2');
        expect(localStorage.getItem('fg_profiles')).toBe('[{"name":"new"}]');
    });
    it('leaves keys created after the snapshot alone', () => {
        localStorage.setItem('fg_new', 'x');
        apply({});
        expect(localStorage.getItem('fg_new')).toBe('x');
    });
});
