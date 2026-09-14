// tests/fg-app-storage.test.ts — unit tests for fg-app-storage.ts
//
// Uses fake-indexeddb (already a FW dependency) so no real browser needed.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    AppStorage,
    TypedStore,
    MIGRATION_FLAG_KEY,
    migrateLocalStorageToIDB,
} from '../fg-app-storage.js';

// ── TypedStore ────────────────────────────────────────────────────────────────

describe('TypedStore (via AppStorage)', () => {
    let storage: AppStorage;

    beforeEach(async () => {
        // Each test gets a fresh DB name to avoid cross-test pollution
        storage = await AppStorage.open(`test-${Math.random().toString(36).slice(2)}`);
    });

    it('returns undefined for missing key', async () => {
        const v = await storage.settings.get('missing');
        expect(v).toBeUndefined();
    });

    it('round-trips set → get', async () => {
        await storage.providerKeys.set('openai', 'sk-abc123');
        const v = await storage.providerKeys.get('openai');
        expect(v).toBe('sk-abc123');
    });

    it('overwrites existing value on set', async () => {
        await storage.providerKeys.set('openai', 'sk-old');
        await storage.providerKeys.set('openai', 'sk-new');
        expect(await storage.providerKeys.get('openai')).toBe('sk-new');
    });

    it('deletes a key', async () => {
        await storage.providerKeys.set('groq', 'gsk-1');
        await storage.providerKeys.delete('groq');
        expect(await storage.providerKeys.get('groq')).toBeUndefined();
    });

    it('lists all entries', async () => {
        await storage.sessions.set('sess-1', { text: 'hello' });
        await storage.sessions.set('sess-2', { text: 'world' });
        const all = await storage.sessions.list();
        expect(all).toHaveLength(2);
        expect(all.map(e => e.key).sort()).toEqual(['sess-1', 'sess-2']);
    });

    it('clears all entries', async () => {
        await storage.sessions.set('sess-1', {});
        await storage.sessions.set('sess-2', {});
        await storage.sessions.clear();
        expect(await storage.sessions.list()).toHaveLength(0);
    });

    it('four stores are independent', async () => {
        await storage.settings.set('theme', { theme: 'dark' });
        await storage.providerKeys.set('theme', 'not-a-key'); // same key name, different store
        expect((await storage.settings.get('theme'))?.theme).toBe('dark');
        expect(await storage.providerKeys.get('theme')).toBe('not-a-key');
    });
});

// ── AppStorage.open ───────────────────────────────────────────────────────────

describe('AppStorage.open', () => {
    it('creates all four stores on first open', async () => {
        const s = await AppStorage.open(`fg-fresh-${Math.random().toString(36).slice(2)}`);
        // All four stores should be accessible (no errors on set/get)
        await expect(s.settings.set('k', {})).resolves.not.toThrow();
        await expect(s.providerKeys.set('k', 'v')).resolves.not.toThrow();
        await expect(s.sessions.set('k', {})).resolves.not.toThrow();
        await expect(s.customProviders.set('k', {})).resolves.not.toThrow();
    });

    it('reopening same DB name accesses same data', async () => {
        const name = `fg-reopen-${Math.random().toString(36).slice(2)}`;
        const s1 = await AppStorage.open(name);
        await s1.providerKeys.set('openai', 'sk-persistent');
        s1.close();
        const s2 = await AppStorage.open(name);
        expect(await s2.providerKeys.get('openai')).toBe('sk-persistent');
    });
});

// ── migrateLocalStorageToIDB ──────────────────────────────────────────────────

describe('migrateLocalStorageToIDB', () => {
    beforeEach(() => {
        // Reset migration flag and relevant LS keys before each test
        localStorage.removeItem(MIGRATION_FLAG_KEY);
        localStorage.removeItem('oai-key');
        localStorage.removeItem('groq-key');
        localStorage.removeItem('fg-session-abc');
    });

    it('migrates provider key from localStorage to providerKeys store', async () => {
        localStorage.setItem('oai-key', 'sk-migrated');
        const s = await AppStorage.open(`fg-mig-${Math.random().toString(36).slice(2)}`);
        await migrateLocalStorageToIDB(s);
        expect(await s.providerKeys.get('oai-key')).toBe('sk-migrated');
    });

    it('migrates session from localStorage to sessions store', async () => {
        const session = { messages: ['hello'], model: 'gpt-4o' };
        localStorage.setItem('fg-session-abc', JSON.stringify(session));
        const s = await AppStorage.open(`fg-mig-${Math.random().toString(36).slice(2)}`);
        await migrateLocalStorageToIDB(s);
        expect(await s.sessions.get('fg-session-abc')).toEqual(session);
    });

    it('sets migration flag after migration', async () => {
        const s = await AppStorage.open(`fg-mig-${Math.random().toString(36).slice(2)}`);
        await migrateLocalStorageToIDB(s);
        expect(localStorage.getItem(MIGRATION_FLAG_KEY)).toBe('1');
    });

    it('is idempotent — does not migrate twice', async () => {
        localStorage.setItem('oai-key', 'sk-original');
        const s = await AppStorage.open(`fg-mig-${Math.random().toString(36).slice(2)}`);
        await migrateLocalStorageToIDB(s);

        // Simulate key being updated in localStorage after migration
        localStorage.setItem('oai-key', 'sk-updated');
        await migrateLocalStorageToIDB(s); // second call should be no-op

        // IDB still has the original value
        expect(await s.providerKeys.get('oai-key')).toBe('sk-original');
    });
});
