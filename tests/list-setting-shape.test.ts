// codex R18-001: a list setting that parses to something other than a list stopped config.ts from loading, and profile Apply stored it.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const W: any = window;

describe('profile Apply', () => {
    beforeAll(async () => { await import('../profiles.ts'); });
    it('does not store a non-list value for a list setting, and keeps the other keys', () => {
        localStorage.clear(); vi.stubGlobal('alert', vi.fn());
        W.profileApply({ fg_active_skills: '{}', fg_builtin_rules: '["a"]', fg_temperature: '0.3' });
        expect(localStorage.getItem('fg_active_skills')).toBeNull();
        expect(localStorage.getItem('fg_builtin_rules')).toBe('["a"]');
        expect((globalThis as any).alert).toHaveBeenCalledWith(expect.stringContaining('fg_active_skills'));
    });
});
describe('config.ts reading list settings', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.ts'), 'utf8');
    it('asks for a list wherever it iterates or searches one', () => {
        expect(src).toMatch(/new Set\(_storedJson\(KEYS\.ACTIVE_SKILLS, \[\], true\)\)/);
        expect(src).toMatch(/new Set\(_storedJson\(KEYS\.DISABLED_ROLES, \[\], true\)\)/);
        expect(src).toMatch(/_storedJson\(KEYS\.DISABLED_TOOLS, null, true\)/);
        expect(src).toMatch(/_storedJson\(KEYS\.DISABLED_TOOLS_COWORK, null, true\)/);
    });
    it('loads with object-shaped list settings in storage (the bridge is installed)', async () => {
        vi.resetModules();
        localStorage.clear();
        localStorage.setItem('fg_active_skills', '{}'); localStorage.setItem('fg_disabled_tools', '{}'); localStorage.setItem('fg_disabled_roles', '5');
        await expect(import('../config.ts?shape')).resolves.toBeTruthy();
        localStorage.clear();
    });
});

describe('opencode §8: applying a profile cannot send a stored key to a new address', () => {
    beforeAll(async () => { await import('../profiles.ts'); });
    it('a changed endpoint origin removes the stored keys that belonged to the old one', () => {
        localStorage.clear(); vi.stubGlobal('alert', vi.fn());
        localStorage.setItem('fg_openai_url', 'https://api.example.com/v1'); localStorage.setItem('fg_openai_key', 'SECRET');
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'custom', model: 'a', key: 'K1' }, { provider: 'custom', model: 'b', key: 'K2', url: 'http://own/v1' }]));
        W.profileApply({ fg_openai_url: 'http://127.0.0.1:9999/v1' });
        expect(localStorage.getItem('fg_openai_key')).toBeNull();
        const models = JSON.parse(localStorage.getItem('fg_custom_models')!);
        expect(models[0].key).toBeUndefined();                  // used the global address
        expect(models[1].key).toBe('K2');                       // has its own address: unaffected
        expect((globalThis as any).alert).toHaveBeenCalledWith(expect.stringMatching(/removed/));
    });
    it('the same origin (another path) keeps the keys; a profile without the URL keeps them too', () => {
        localStorage.clear(); vi.stubGlobal('alert', vi.fn());
        localStorage.setItem('fg_openai_url', 'https://api.example.com/v1'); localStorage.setItem('fg_openai_key', 'SECRET');
        W.profileApply({ fg_openai_url: 'https://api.example.com/v2' });
        expect(localStorage.getItem('fg_openai_key')).toBe('SECRET');
        localStorage.setItem('fg_openai_key', 'SECRET');
        W.profileApply({ fg_temperature: '0.2' });             // a profile that names no address resets it to the default; that is not a destination its author chose
        expect(localStorage.getItem('fg_openai_key')).toBe('SECRET');
    });
});
