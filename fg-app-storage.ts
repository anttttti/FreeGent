// fg-app-storage.ts — Four-store IndexedDB schema for FreeGent.
//
// Replaces FW's ad-hoc localStorage layout with a typed, versioned IDB schema.
// Async, no 5 MB limit, schema-versioned via onupgradeneeded.
//
// Four stores, each owning its key space:
//   settings        — theme, language, promptMode, UI preferences
//   providerKeys    — API keys (prepared for Service Worker key injection)
//   sessions        — full chat history with metadata (highest-value migration target)
//   customProviders — user-defined LLM endpoints (OpenRouter custom routes, etc.)
//
// Usage:
//   const storage = await AppStorage.open('fg');
//   const key = await storage.providerKeys.get('openai');
//   await storage.sessions.set(sessionId, sessionData);
//
// Migration (Phase 5, incremental):
//   1. Open AppStorage alongside existing localStorage.
//   2. On first load (isMigrated() === false): migrate localStorage → IDB, then mark done.
//   3. Gradually move new writes to this module; old reads stay on localStorage until
//      callers are migrated. Remove localStorage reads once all callers are done.
//
// Phase 5 target — see agentharness_migration_v2.md Phase 5, §E four-store schema.

export const CURRENT_SCHEMA_VERSION = 1;
export const MIGRATION_FLAG_KEY = 'fg:idb-migrated-v1';

// ── Store key spaces ──────────────────────────────────────────────────────────

export const STORE_SETTINGS          = 'settings';
export const STORE_PROVIDER_KEYS     = 'providerKeys';
export const STORE_SESSIONS          = 'sessions';
export const STORE_CUSTOM_PROVIDERS  = 'customProviders';

// ── TypedStore ────────────────────────────────────────────────────────────────

/**
 * Typed async key-value store backed by a single IDB object store.
 * All methods are async; failures reject (caller handles).
 */
export class TypedStore<T> {
    constructor(
        private readonly db:        IDBDatabase,
        private readonly storeName: string,
    ) {}

    async get(key: string): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const tx  = this.db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(key);
            req.onsuccess = () => resolve(req.result as T | undefined);
            req.onerror   = () => reject(req.error);
        });
    }

    async set(key: string, value: T): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx  = this.db.transaction(this.storeName, 'readwrite');
            const req = tx.objectStore(this.storeName).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    async delete(key: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx  = this.db.transaction(this.storeName, 'readwrite');
            const req = tx.objectStore(this.storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    async list(): Promise<Array<{ key: string; value: T }>> {
        return new Promise((resolve, reject) => {
            const tx      = this.db.transaction(this.storeName, 'readonly');
            const store   = tx.objectStore(this.storeName);
            const result: Array<{ key: string; value: T }> = [];
            const keys: string[]    = [];
            const values: T[]       = [];
            let   keysLoaded = false;
            let   valsLoaded = false;

            const kReq = store.getAllKeys();
            const vReq = store.getAll();

            kReq.onsuccess = () => { keys.push(...kReq.result as string[]); keysLoaded = true; if (valsLoaded) done(); };
            vReq.onsuccess = () => { values.push(...vReq.result as T[]);    valsLoaded = true; if (keysLoaded) done(); };
            kReq.onerror = () => reject(kReq.error);
            vReq.onerror = () => reject(vReq.error);

            function done() {
                for (let i = 0; i < keys.length; i++) {
                    result.push({ key: keys[i], value: values[i] });
                }
                resolve(result);
            }
        });
    }

    async clear(): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx  = this.db.transaction(this.storeName, 'readwrite');
            const req = tx.objectStore(this.storeName).clear();
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }
}

// ── AppStorage ────────────────────────────────────────────────────────────────

/** Well-known key space for settings store. */
export interface FWSettings {
    theme?:       'light' | 'dark' | 'system';
    promptMode?:  'minimal' | 'standard' | 'extended';
    language?:    string;
    [key: string]: unknown;
}

/**
 * Container for FreeGent's four typed IDB stores.
 * Open with `await AppStorage.open(dbName)`.
 */
export class AppStorage {
    readonly settings:        TypedStore<FWSettings>;
    readonly providerKeys:    TypedStore<string>;
    readonly sessions:        TypedStore<unknown>;
    readonly customProviders: TypedStore<unknown>;

    private constructor(private readonly db: IDBDatabase) {
        this.settings        = new TypedStore<FWSettings>(db, STORE_SETTINGS);
        this.providerKeys    = new TypedStore<string>(db, STORE_PROVIDER_KEYS);
        this.sessions        = new TypedStore<unknown>(db, STORE_SESSIONS);
        this.customProviders = new TypedStore<unknown>(db, STORE_CUSTOM_PROVIDERS);
    }

    /**
     * Open (or create / upgrade) the FW IndexedDB database.
     *
     * @param dbName - Name of the IDB database. Default: 'fg'.
     * @param version - Schema version. Default: CURRENT_SCHEMA_VERSION.
     */
    static async open(dbName = 'fg', version = CURRENT_SCHEMA_VERSION): Promise<AppStorage> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, version);

            req.onupgradeneeded = (evt) => {
                const db         = req.result;
                const oldVersion = evt.oldVersion;

                // Version 1: create all four stores
                if (oldVersion < 1) {
                    db.createObjectStore(STORE_SETTINGS);
                    db.createObjectStore(STORE_PROVIDER_KEYS);
                    db.createObjectStore(STORE_SESSIONS);
                    db.createObjectStore(STORE_CUSTOM_PROVIDERS);
                }

                // Future version bumps: add migrations here.
                // if (oldVersion < 2) { ... }
            };

            req.onsuccess = () => resolve(new AppStorage(req.result));
            req.onerror   = () => reject(req.error);
            req.onblocked = () => reject(new Error(`IDB upgrade blocked for "${dbName}" — close other tabs.`));
        });
    }

    /** Close the underlying IDB connection. */
    close(): void {
        this.db.close();
    }
}

// ── localStorage migration helpers ────────────────────────────────────────────
//
// Called from init.ts on first load to migrate existing data to IDB.
// One-time: once the migration flag is set, these are no-ops.

/**
 * Well-known localStorage key prefixes that belong in each store.
 * Extend as FW modules are migrated.
 */
const _SESSION_LS_KEYS = /^(fg-session-|sessions-|sessionHistory)/;
const _KEY_LS_KEYS = /^(oai-key|anthropic-key|gemini-key|mistral-key|groq-key|cerebras-key|openrouter-key|nvidia-key|opencode-key|tokenharbor-key)/;

/**
 * Migrate existing localStorage entries into AppStorage.
 * Call from init.ts if `localStorage.getItem(MIGRATION_FLAG_KEY)` is null.
 *
 * Does not delete localStorage entries — callers must remove them once all
 * reads have been moved to `storage.*`.
 */
export async function migrateLocalStorageToIDB(storage: AppStorage): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;

    // Migrate sessions
    for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (!lsKey) continue;

        if (_SESSION_LS_KEYS.test(lsKey)) {
            const val = localStorage.getItem(lsKey);
            if (val !== null) {
                try {
                    await storage.sessions.set(lsKey, JSON.parse(val));
                } catch {
                    await storage.sessions.set(lsKey, val);
                }
            }
        } else if (_KEY_LS_KEYS.test(lsKey)) {
            const val = localStorage.getItem(lsKey);
            if (val !== null) {
                await storage.providerKeys.set(lsKey, val);
            }
        }
    }

    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
}
