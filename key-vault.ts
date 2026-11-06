// key-vault.ts — FreeGent: optional passkey lock for saved credentials.
//
// Off by default: API keys, the Developer key, the GitHub token and MCP server entries (whose headers
// hold credentials) are plain localStorage entries. With the lock on, those entries are removed from
// localStorage and kept as one AES-GCM blob (KEY_VAULT_LS). Its key comes from a passkey (Touch ID,
// Windows Hello, a phone or a security key) through the WebAuthn PRF extension: the authenticator
// computes a secret from a stored salt only after user verification, and the page turns that secret
// into the AES key (HKDF-SHA-256). Nothing on disk can open the blob; the passkey is asked for when
// the page opens, and the decrypted values then live only in this page's memory until it is closed
// or locked again. (A typed passphrase was tried first and dropped: typing it on every load was not
// practical. A tap or a glance is.)
//
// Every read and write of those names goes through Storage.prototype.getItem/setItem/removeItem,
// which this module patches for localStorage only, so the many places that read a key keep working
// unchanged. It must evaluate before any module reads a key: config.ts imports it first.
//
// What it protects: keys at rest — another person at this browser profile, or a copy of it, cannot
// read them without the passkey while the page is locked or closed. What it does not: anything
// running in an unlocked page (DevTools, an injected script) reads the keys as before.
//
// Ordering (from the reviews of the passphrase version):
//   - Two generations: _vaultGen changes when the vault itself changes (turned on or off, reset, cleared,
//     replaced from another tab); _lockGen also changes on every lock and unlock. An unlock or a
//     background decrypt installs its values only if both are what they were when it started, so a
//     late decrypt can never undo Lock now, Forgot it or a cancelled prompt.
//   - A write while unlocked is one per-name change, saved with the key and vault it was made under
//     (Lock now does not drop it). Each save takes the 'fg-key-vault' Web Lock, re-reads the stored
//     blob, applies its change to the latest values and writes, so two tabs editing different keys do
//     not overwrite each other; it is dropped if the vault was reset or replaced meanwhile, so a reset
//     stays reset. flushKeyVault() waits for every save; keyVaultSaveState() reports a failed one.
//   - While locked, a write to a vaulted name holds for this page only and is discarded on unlock (the
//     stored value wins), so a key or MCP server entered while locked never overwrites the saved ones.

import { isCredentialKey } from './profile-keys.js';

export const KEY_VAULT_LS = 'fg_key_vault';
const VAULT_VERSION = 2;                       // 2: passkey (PRF). 1 was the dropped passphrase format.
const LOCK_NAME = 'fg-key-vault';
const HKDF_INFO = 'freegent key vault v2';

/** localStorage names whose values the lock encrypts. */
export function isVaultName(name: string): boolean {
    return /^fg_[a-z0-9]+_key$/.test(name) || name === 'fg_github_token' || name === 'fg_pass' || name === 'fg_mcp_servers';
}

interface VaultBlob { v: number; kind: 'passkey'; cred: string; prf: string; salt: string; iv: string; ct: string }
type Pending = { seq: number; value: string | null };
/** A passkey made by createVaultPasskey(), and its PRF output when the authenticator returned it at creation. */
export interface PasskeySetup { cred: Uint8Array<ArrayBuffer>; prfSalt: Uint8Array<ArrayBuffer>; prfOut: Uint8Array<ArrayBuffer> | null }

let _mem = new Map<string, string>();           // decrypted values (unlocked) or this page's own writes (locked)
const _pending = new Map<string, Pending>();    // writes made while unlocked whose save has not landed yet
let _cryptoKey: CryptoKey | null = null;        // non-extractable; set while unlocked
let _enabled = false;
let _damaged = false;                           // a vault entry exists but cannot be read
let _salt: string | null = null;                // identifies the current vault
let _vaultGen = 0, _lockGen = 0, _seq = 0, _credVersion = 0;
let _writeChain: Promise<void> = Promise.resolve();
let _saving = 0;
let _saveError: string | null = null;

let _origGet: ((k: string) => string | null) | null = null;
let _origSet: ((k: string, v: string) => void) | null = null;
let _origRemove: ((k: string) => void) | null = null;
const _ls = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const _rawGet = (k: string) => { const s = _ls(); return s ? (_origGet ?? s.getItem).call(s, k) : null; };
const _rawSet = (k: string, v: string) => { const s = _ls(); if (s) (_origSet ?? s.setItem).call(s, k, v); };
const _rawRemove = (k: string) => { const s = _ls(); if (s) (_origRemove ?? s.removeItem).call(s, k); };

function _subtle(): SubtleCrypto | null {
    return typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null;
}
function _webauthn(): CredentialsContainer | null {
    if (typeof navigator === 'undefined' || typeof (globalThis as any).PublicKeyCredential === 'undefined') return null;
    if ((globalThis as any).isSecureContext === false) return null;
    return navigator.credentials?.create && navigator.credentials?.get ? navigator.credentials : null;
}
/** A bare IPv4 or IPv6 address. A passkey belongs to a domain name (its relying party ID), so browsers
 *  refuse WebAuthn on an IP address even over HTTPS — e.g. `npm run dev:lan` opened as https://192.168.x.x. */
export function isIpHost(hostname: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[');
}
/** Why the lock cannot be used on this page, or null when it can. */
export function keyVaultUnavailableReason(): string | null {
    if (!_ls() || !_subtle() || (globalThis as any).isSecureContext === false) return 'needs HTTPS or localhost';
    const host = typeof location !== 'undefined' ? location.hostname : '';
    if (host && isIpHost(host)) return 'passkeys need a host name, not an IP address: open FreeGent as localhost or by name';
    if (!_webauthn()) return 'this browser has no passkeys';
    return null;
}
/** The lock needs WebAuthn and WebCrypto: HTTPS or localhost by name (not an IP address), with passkeys. */
export function keyVaultSupported(): boolean { return keyVaultUnavailableReason() === null; }
/** Whether this browser says its passkeys can do PRF: true, false, or null when it does not say
 *  (older browsers: only creating a passkey tells). */
export async function keyVaultPrfCapability(): Promise<boolean | null> {
    try {
        const caps = await (globalThis as any).PublicKeyCredential?.getClientCapabilities?.();
        return caps && typeof caps['extension:prf'] === 'boolean' ? caps['extension:prf'] : null;
    } catch { return null; }
}
export function keyVaultEnabled(): boolean { return _enabled; }
export function keyVaultUnlocked(): boolean { return _enabled && !!_cryptoKey; }
/** A saved vault exists but cannot be read (corrupt or from an unknown version): only Forgot it helps. */
export function keyVaultDamaged(): boolean { return _enabled && _damaged; }
export function keyVaultSaveState(): { saving: boolean; error: string | null } { return { saving: _saving > 0, error: _saveError }; }
/** Changes whenever a stored credential may have changed (for caches of storedCredentialValues). */
export function credentialsVersion(): number { return _credVersion; }

const _b64 = (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const _unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const _bytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> =>
    new Uint8Array(b instanceof ArrayBuffer ? b.slice(0) : (b.buffer as ArrayBuffer).slice(b.byteOffset, b.byteOffset + b.byteLength));

/** The stored vault: absent, damaged, or a blob whose fields decode and are in range. A v1
 *  (passphrase) blob reads as damaged: that format is gone, and only Forgot it clears it. */
function _readVault(): { blob: VaultBlob | null; present: boolean } {
    const raw = _rawGet(KEY_VAULT_LS);
    if (raw === null) return { blob: null, present: false };
    try {
        const j = JSON.parse(raw);
        const ok = j && j.v === VAULT_VERSION && j.kind === 'passkey'
            && [j.cred, j.prf, j.salt, j.iv, j.ct].every(x => typeof x === 'string')
            && _unb64(j.cred).length > 0 && _unb64(j.prf).length === 32 && _unb64(j.salt).length >= 16
            && _unb64(j.iv).length === 12 && _unb64(j.ct).length > 16;
        return { blob: ok ? j : null, present: true };
    } catch { return { blob: null, present: true }; }
}

/** AES key from a passkey's PRF output (32 bytes) and the vault's HKDF salt. */
async function _keyFromPrf(prfOut: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const subtle = _subtle()!;
    const base = await subtle.importKey('raw', prfOut, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO) }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** User-facing message for a WebAuthn failure. */
function _passkeyError(e: any): Error {
    const n = e?.name;
    if (n === 'NotAllowedError' || n === 'AbortError') return new Error('Cancelled');
    if (n === 'InvalidStateError') return new Error('This passkey cannot be used here.');
    if (n === 'SecurityError') return new Error('The browser refused passkeys on this address. They need HTTPS (with a certificate the browser trusts) or localhost, and a host name, not an IP address.');
    return new Error(e?.message ?? String(e));
}

/** Ask the passkey for its PRF output on `prfSalt` (user verification required). */
async function _prfFromPasskey(cred: Uint8Array<ArrayBuffer>, prfSalt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const wa = _webauthn();
    if (!wa) throw new Error(`The key lock cannot be used here: ${keyVaultUnavailableReason() ?? 'no passkeys'}.`);
    let a: any;
    try {
        a = await wa.get({ publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ type: 'public-key', id: cred }],
            userVerification: 'required',
            timeout: 120_000,
            extensions: { prf: { eval: { first: prfSalt } } } as any,
        } });
    } catch (e) { throw _passkeyError(e); }
    const first = a?.getClientExtensionResults?.()?.prf?.results?.first;
    if (!first) throw new Error('This passkey or browser does not support the PRF extension, so it cannot lock keys.');
    return _bytes(first);
}

async function _encrypt(key: CryptoKey, base: Omit<VaultBlob, 'iv' | 'ct'>, values: Map<string, string>): Promise<VaultBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const obj: Record<string, string> = {};
    for (const [k, v] of values) obj[k] = v;
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await _subtle()!.encrypt({ name: 'AES-GCM', iv }, key, data));
    return { v: base.v, kind: base.kind, cred: base.cred, prf: base.prf, salt: base.salt, iv: _b64(iv), ct: _b64(ct) };
}

async function _decrypt(key: CryptoKey, blob: VaultBlob): Promise<Map<string, string>> {
    const pt = await _subtle()!.decrypt({ name: 'AES-GCM', iv: _unb64(blob.iv) }, key, _unb64(blob.ct));
    const obj = JSON.parse(new TextDecoder().decode(pt)) || {};
    return new Map(Object.entries(obj).filter(([k, v]) => isVaultName(k) && typeof v === 'string') as [string, string][]);
}

/** Serialize whole-vault read-modify-write across this browser's tabs (no Web Locks: this tab only). */
function _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : null;
    return locks?.request ? locks.request(LOCK_NAME, fn) : fn();
}

/** Tell readers that cache localStorage values (config.ts ls(), the Settings form) what changed.
 *  An empty `names` list means "anything may have changed". */
function _announce(names: Iterable<string>, reason: 'unlock' | 'lock' | 'on' | 'off' | 'remote') {
    _credVersion++;
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new CustomEvent('fg-vault-change', { detail: { names: [...names], reason } })); } catch {}
}
function _saveStateChanged() {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new CustomEvent('fg-vault-save', { detail: keyVaultSaveState() })); } catch {}
}

/** Replace the decrypted values, keeping this page's not-yet-saved writes; returns the names whose value changed. */
function _install(values: Map<string, string>): string[] {
    for (const [k, p] of _pending) { if (p.value === null) values.delete(k); else values.set(k, p.value); }
    const changed: string[] = [];
    for (const k of new Set([..._mem.keys(), ...values.keys()])) if (_mem.get(k) !== values.get(k)) changed.push(k);
    _mem = values;
    return changed;
}

/** Forget this page's view of the vault (keys, pending writes); `vault` also marks the vault itself as changed. */
function _drop(vault: boolean) {
    _lockGen++;
    if (vault) _vaultGen++;
    _cryptoKey = null;
    _mem = new Map();
    _pending.clear();
}

/** Save one change made while unlocked. Captures the key and vault it was made under. */
function _persist(name: string, value: string | null): void {
    const key = _cryptoKey!, gen = _vaultGen, salt = _salt, seq = ++_seq;
    _pending.set(name, { seq, value });
    _saving++; _saveStateChanged();
    _writeChain = _writeChain.then(() => _withLock(async () => {
        const live = () => gen === _vaultGen && _readVault().blob?.salt === salt;
        if (!live()) return;                       // reset, turned off or replaced since: the change goes with it
        const blob = _readVault().blob!;
        let latest: Map<string, string>;
        try { latest = await _decrypt(key, blob); }
        catch { throw new Error('the saved keys were locked with another passkey in another tab'); }
        if (value === null) latest.delete(name); else latest.set(name, value);
        const next = await _encrypt(key, blob, latest);
        if (!live()) return;                       // checked again right before the (synchronous) write
        _rawSet(KEY_VAULT_LS, JSON.stringify(next));
        if (_pending.get(name)?.seq === seq) _pending.delete(name);
        // Still unlocked with the same key: pick up what other tabs saved meanwhile.
        if (_cryptoKey === key && gen === _vaultGen) { const changed = _install(latest); if (changed.length) _announce(changed, 'remote'); }
    })).then(() => { if (_pending.size === 0) _saveError = null; }, (e: any) => {   // another name's failed save stays reported until it is saved
        _saveError = String(e?.message ?? e);
        console.warn('[key-vault] could not save the encrypted keys:', _saveError);
    }).finally(() => { _saving--; _saveStateChanged(); });
}

/** Resolves when every save started so far has landed (or failed: see keyVaultSaveState). */
export function flushKeyVault(): Promise<void> { return _writeChain; }

/** Step 1 of turning the lock on: create a passkey (needs a click: browsers require a user gesture).
 *  Most authenticators return the PRF output right away; otherwise enableKeyVault asks for it. */
export async function createVaultPasskey(): Promise<PasskeySetup> {
    if (!keyVaultSupported()) throw new Error(`The key lock cannot be used here: ${keyVaultUnavailableReason() ?? 'no passkeys'}.`);
    if (_enabled) throw new Error('The key lock is already on.');
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    let c: any;
    try {
        c = await _webauthn()!.create({ publicKey: {
            rp: { name: 'FreeGent' },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'FreeGent API keys', displayName: 'FreeGent API keys' },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            timeout: 120_000,
            extensions: { prf: { eval: { first: prfSalt } } } as any,
        } });
    } catch (e) { throw _passkeyError(e); }
    const ext = c?.getClientExtensionResults?.()?.prf;
    if (!c?.rawId || ext?.enabled === false) throw new Error('This passkey or browser does not support the PRF extension, so it cannot lock keys. Try another browser, or a phone or security key as the passkey.');
    return { cred: _bytes(c.rawId), prfSalt, prfOut: ext?.results?.first ? _bytes(ext.results.first) : null };
}

/** Step 2: encrypt the saved credentials with the passkey and remove their plain copies. When the passkey
 *  did not return its PRF output at creation, this asks for it (call from a click). */
export async function enableKeyVault(setup: PasskeySetup): Promise<void> {
    if (!keyVaultSupported()) throw new Error(`The key lock cannot be used here: ${keyVaultUnavailableReason() ?? 'no passkeys'}.`);
    if (_enabled) throw new Error('The key lock is already on.');
    const gen = _vaultGen;
    const prfOut = setup.prfOut ?? await _prfFromPasskey(setup.cred, setup.prfSalt);
    await _withLock(async () => {
        const s = _ls()!;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await _keyFromPrf(prfOut, salt);
        const values = new Map<string, string>();
        for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k && isVaultName(k)) { const v = _rawGet(k); if (v !== null) values.set(k, v); }
        }
        const blob = await _encrypt(key, { v: VAULT_VERSION, kind: 'passkey', cred: _b64(setup.cred), prf: _b64(setup.prfSalt), salt: _b64(salt) }, values);
        if (gen !== _vaultGen || _rawGet(KEY_VAULT_LS) !== null) throw new Error('The key lock was changed in another tab. Reload and try again.');
        _rawSet(KEY_VAULT_LS, JSON.stringify(blob));   // the encrypted copy first, then the plain ones go
        for (const k of values.keys()) _rawRemove(k);
        _drop(true);
        _enabled = true; _damaged = false; _salt = blob.salt;
        _mem = values;
        _cryptoKey = key;
    });
    _announce([], 'on');
}

/** Unlock with the passkey (call from a click). Throws 'Cancelled' when the passkey prompt was dismissed,
 *  or when the vault was locked, reset or replaced while it was open. */
export async function unlockKeyVault(): Promise<void> {
    const vg = _vaultGen, lg = _lockGen;
    if (!_enabled) throw new Error('The key lock is not on.');
    if (!keyVaultSupported()) throw new Error(`The key lock cannot be used here: ${keyVaultUnavailableReason() ?? 'no passkeys'}.`);
    await _writeChain;                             // read what this page's own saves wrote
    const { blob } = _readVault();
    if (!blob) throw new Error('The saved key lock is damaged or from an older version. Use Forgot it to delete it and enter your keys again.');
    const prfOut = await _prfFromPasskey(_unb64(blob.cred), _unb64(blob.prf));
    const key = await _keyFromPrf(prfOut, _unb64(blob.salt));
    let values: Map<string, string>;
    try { values = await _decrypt(key, blob); }
    catch { throw new Error('This passkey does not open the saved keys.'); }
    if (vg !== _vaultGen || lg !== _lockGen || _readVault().blob?.salt !== blob.salt) throw new Error('Cancelled');
    _lockGen++;
    _pending.clear();
    _mem = new Map();
    const changed = _install(values);
    _salt = blob.salt;
    _cryptoKey = key;
    _announce(changed, 'unlock');
}

/** Forget the decrypted values in this page; the encrypted copy stays. Saves already started still land. */
export function lockKeyVault(): void {
    if (!_enabled) return;
    const names = [..._mem.keys()];
    _drop(false);
    _announce(names, 'lock');
}

/** Turn the lock off: store the credentials as plain localStorage entries again. Needs an unlocked vault. */
export async function disableKeyVault(): Promise<void> {
    if (!_enabled) return;
    if (!_cryptoKey) throw new Error('Unlock the keys first.');
    await _writeChain;
    const key = _cryptoKey, lg = _lockGen;
    await _withLock(async () => {
        const { blob } = _readVault();
        if (!blob || lg !== _lockGen || _cryptoKey !== key) throw new Error('The key lock changed meanwhile. Try again.');
        const values = await _decrypt(key, blob);  // the latest saved values, other tabs' writes included
        // A Lock now or reset during the decrypt must not be undone by writing the keys back as plain text.
        if (lg !== _lockGen || _cryptoKey !== key || _readVault().blob?.salt !== blob.salt) throw new Error('The key lock changed meanwhile. Try again.');
        for (const [k, p] of _pending) { if (p.value === null) values.delete(k); else values.set(k, p.value); }   // and ours still in flight
        for (const [k, v] of values) _rawSet(k, v);
        _rawRemove(KEY_VAULT_LS);
        _drop(true);
        _enabled = false; _damaged = false; _salt = null;
    });
    _announce([], 'off');
}

/** Lost passkey (or a damaged vault): delete the encrypted credentials and turn the lock off.
 *  Needs no passkey. A save still in flight sees the new generation and is dropped. */
export function resetKeyVault(): void {
    const wasOn = _enabled || _rawGet(KEY_VAULT_LS) !== null;
    _drop(true);
    _rawRemove(KEY_VAULT_LS);
    _enabled = false; _damaged = false; _salt = null;
    if (wasOn) _announce([], 'off');
}

/** Values held by the vault (for redaction: they are not enumerable through localStorage). */
export function keyVaultValues(): string[] { return [..._mem.values()].filter(Boolean); }

// ── Storage interception ────────────────────────────────────────────────────
{
    const s = _ls();
    const proto = typeof Storage !== 'undefined' ? Storage.prototype : (s ? Object.getPrototypeOf(s) : null);
    if (s && proto?.getItem && !(proto as any).__fgVault) {
        _origGet = proto.getItem; _origSet = proto.setItem; _origRemove = proto.removeItem;
        const origClear = proto.clear;
        const STRUCTURED = ['fg_custom_models', 'fg_search_proxy', 'fg_openai_url'];
        const touches = (name: string) => isVaultName(name) || isCredentialKey(name) || STRUCTURED.includes(name);
        proto.getItem = function (k: string) {
            if (_enabled && this === _ls() && isVaultName(String(k))) return _mem.get(String(k)) ?? null;
            return _origGet!.call(this, k);
        };
        proto.setItem = function (k: string, v: string) {
            const name = String(k);
            if (this === _ls() && touches(name)) _credVersion++;
            if (_enabled && this === _ls() && isVaultName(name)) { _mem.set(name, String(v)); if (_cryptoKey) _persist(name, String(v)); return; }
            return _origSet!.call(this, k, v);
        };
        proto.removeItem = function (k: string) {
            const name = String(k);
            if (this === _ls() && touches(name)) _credVersion++;
            if (_enabled && this === _ls() && isVaultName(name)) { _mem.delete(name); if (_cryptoKey) _persist(name, null); return; }
            return _origRemove!.call(this, k);
        };
        // clear() wipes the encrypted copy with everything else: the lock is off afterwards.
        proto.clear = function () {
            if (this === _ls()) _credVersion++;
            if (this === _ls() && (_enabled || _rawGet(KEY_VAULT_LS) !== null)) {
                _drop(true); _enabled = false; _damaged = false; _salt = null;
                const r = origClear.call(this);
                _announce([], 'off');
                return r;
            }
            return origClear.call(this);
        };
        (proto as any).__fgVault = true;
        const v = _readVault();
        _enabled = v.present; _damaged = v.present && !v.blob; _salt = v.blob?.salt ?? null;

        // Another tab changed the vault: follow it being turned on, off, reset or replaced, or reload our copy.
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', (e: StorageEvent) => {
                if (e.storageArea && e.storageArea !== s) return;
                // A credential saved, removed or cleared in another tab bypasses this tab's setItem: the caches keyed on the version
                // (dev-log's redaction list) must see it too (codex DR-09).
                if (e.key === null || touches(e.key)) _credVersion++;
                if (e.key !== null && e.key !== KEY_VAULT_LS) return;
                const { blob, present } = _readVault();
                if (!present) {
                    if (_enabled) { _drop(true); _enabled = false; _damaged = false; _salt = null; _announce([], 'off'); }
                    return;
                }
                if (!_enabled || !blob || blob.salt !== _salt) {
                    // Turned on elsewhere, damaged, or replaced (reset and locked again with another passkey): locked here.
                    const names = [..._mem.keys()];
                    _drop(true);
                    _enabled = true; _damaged = !blob; _salt = blob?.salt ?? null;
                    _announce(names, 'remote');
                    return;
                }
                if (!_cryptoKey) return;
                const key = _cryptoKey, vg = _vaultGen, lg = _lockGen;
                _decrypt(key, blob).then(values => {
                    if (vg !== _vaultGen || lg !== _lockGen || _cryptoKey !== key) return;   // locked or replaced meanwhile
                    const changed = _install(values);
                    if (changed.length) _announce(changed, 'remote');
                }).catch(() => { if (vg === _vaultGen && lg === _lockGen) lockKeyVault(); });   // not our key any more
            });
            // A save still running when the page closes would be lost: let the browser ask.
            window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
                if (_saving > 0) { e.preventDefault(); (e as any).returnValue = ''; }
            });
        }
    }
}
