// key-vault.ts: the optional passkey lock for saved credentials. WebAuthn is mocked: the "authenticator"
// computes PRF as HMAC(secret, salt), so a different secret stands for a different passkey. Ordering cases
// are the repros from the codex / opencode / hermesagent reviews of the passphrase version.
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import {
    KEY_VAULT_LS, isVaultName, keyVaultEnabled, keyVaultUnlocked, keyVaultDamaged, createVaultPasskey, enableKeyVault,
    unlockKeyVault, lockKeyVault, disableKeyVault, resetKeyVault, flushKeyVault, credentialsVersion,
} from '../key-vault.ts';
import { storedCredentialValues } from '../stored-credentials.ts';

const GROQ = 'gsk_' + 'A'.repeat(40);
const ODD = 'opaque-moonmath-value-123';

// ── WebAuthn mock ─────────────────────────────────────────────────────────────
const wa = { secret: 'passkey-A', prfEnabled: true, prfAtCreate: true, cancel: false, hold: null as null | Promise<void>, gets: 0 };
const prf = (salt: ArrayBuffer | ArrayBufferView) => {
    const b = salt instanceof ArrayBuffer ? Buffer.from(salt) : Buffer.from(salt.buffer, salt.byteOffset, salt.byteLength);
    return new Uint8Array(createHmac('sha256', wa.secret).update(b).digest()).buffer;
};
beforeAll(() => {
    (globalThis as any).PublicKeyCredential = class {};
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
        create: async (o: any) => {
            if (wa.cancel) throw new DOMException('dismissed', 'NotAllowedError');
            const salt = o.publicKey.extensions.prf.eval.first;
            return { rawId: new Uint8Array([1, 2, 3, 4]).buffer, getClientExtensionResults: () => ({
                prf: { enabled: wa.prfEnabled, ...(wa.prfEnabled && wa.prfAtCreate ? { results: { first: prf(salt) } } : {}) } }) };
        },
        get: async (o: any) => {
            wa.gets++;
            if (wa.hold) await wa.hold;
            if (wa.cancel) throw new DOMException('dismissed', 'NotAllowedError');
            const salt = o.publicKey.extensions.prf.eval.first;
            return { getClientExtensionResults: () => ({ prf: { results: { first: prf(salt) } } }) };
        },
    } });
});
const lockOn = async () => enableKeyVault(await createVaultPasskey());

// Raw localStorage, past the vault's interception (what another person at the browser would see).
const rawNames = () => { const out: string[] = []; for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)!); return out; };
const rawVault = () => Storage.prototype.getItem.call(localStorage, KEY_VAULT_LS);
const otherTabWrote = () => window.dispatchEvent(new StorageEvent('storage', { key: KEY_VAULT_LS, storageArea: localStorage }));
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(async () => {
    Object.assign(wa, { secret: 'passkey-A', prfEnabled: true, prfAtCreate: true, cancel: false, hold: null, gets: 0 });
    await flushKeyVault(); resetKeyVault(); localStorage.clear();
});

describe('key vault', () => {
    it('vaults API keys, the Developer key, the GitHub token and MCP servers, nothing else', () => {
        for (const n of ['fg_groq_key', 'fg_dev_key', 'fg_github_token', 'fg_mcp_servers', 'fg_pass']) expect(isVaultName(n)).toBe(true);
        for (const n of ['fg_agent_compact_tokens', 'fg_groq_model', 'fg_key_vault', 'fg_server_token']) expect(isVaultName(n)).toBe(false);
    });

    it('locking removes the plain copies; reads and writes go through the vault; only the same passkey opens it', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        localStorage.setItem('fg_groq_model', 'llama');
        await lockOn();
        expect(keyVaultEnabled()).toBe(true);
        expect(rawNames().sort()).toEqual(['fg_groq_model', KEY_VAULT_LS]);
        expect(rawVault()).not.toContain(GROQ);
        expect(localStorage.getItem('fg_groq_key')).toBe(GROQ);       // unlocked: served from memory

        localStorage.setItem('fg_moonmath_key', ODD);                    // written while unlocked: encrypted too
        await flushKeyVault();
        await unlockKeyVault();                                          // re-read from the stored blob
        expect(localStorage.getItem('fg_moonmath_key')).toBe(ODD);
        expect(rawNames()).not.toContain('fg_moonmath_key');

        lockKeyVault();
        expect(keyVaultUnlocked()).toBe(false);
        expect(localStorage.getItem('fg_groq_key')).toBeNull();
        wa.secret = 'passkey-B';
        await expect(unlockKeyVault()).rejects.toThrow('does not open');
        wa.secret = 'passkey-A'; wa.cancel = true;
        await expect(unlockKeyVault()).rejects.toThrow('Cancelled');
        wa.cancel = false;
        await unlockKeyVault();
        expect(localStorage.getItem('fg_groq_key')).toBe(GROQ);
    });

    it('a passkey without PRF is refused, and nothing is locked', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        wa.prfEnabled = false;
        await expect(createVaultPasskey()).rejects.toThrow(/PRF/);
        expect(keyVaultEnabled()).toBe(false);
        expect(rawNames()).toEqual(['fg_groq_key']);
    });

    it('an authenticator that gives its PRF output only on use is asked once more', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        wa.prfAtCreate = false;
        const setup = await createVaultPasskey();
        expect(setup.prfOut).toBeNull();
        await enableKeyVault(setup);
        expect(wa.gets).toBe(1);
        lockKeyVault();
        await unlockKeyVault();
        expect(localStorage.getItem('fg_groq_key')).toBe(GROQ);
    });

    it('a write while locked lasts for the page only: unlocking restores the saved value', async () => {
        localStorage.setItem('fg_mcp_servers', '[{"id":"a"}]');
        await lockOn();
        lockKeyVault();
        localStorage.setItem('fg_mcp_servers', '[]');
        expect(localStorage.getItem('fg_mcp_servers')).toBe('[]');
        await unlockKeyVault();
        expect(localStorage.getItem('fg_mcp_servers')).toBe('[{"id":"a"}]');
    });

    it('turning it off stores the keys in plain localStorage again', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        await disableKeyVault();
        expect(keyVaultEnabled()).toBe(false);
        expect(rawNames()).toEqual(['fg_groq_key']);
        expect(localStorage.getItem('fg_groq_key')).toBe(GROQ);
    });
});

describe('key vault ordering', () => {
    it('a key saved just before Lock now is kept', async () => {
        localStorage.setItem('fg_groq_key', 'old-value-12345');
        await lockOn();
        localStorage.setItem('fg_groq_key', 'new-value-12345');
        lockKeyVault();
        await unlockKeyVault();
        expect(localStorage.getItem('fg_groq_key')).toBe('new-value-12345');
    });

    it('a save in flight when Forgot it runs does not bring the vault back', async () => {
        await lockOn();
        localStorage.setItem('fg_groq_key', GROQ);
        resetKeyVault();
        await flushKeyVault();
        expect(rawVault()).toBeNull();
        expect(keyVaultEnabled()).toBe(false);
    });

    it('an unlock still waiting for the passkey when Lock now runs does not unlock afterwards', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        lockKeyVault();
        let release!: () => void; wa.hold = new Promise(r => { release = r; });
        const pending = unlockKeyVault();
        await tick();
        lockKeyVault();
        release();
        await expect(pending).rejects.toThrow('Cancelled');
        expect(keyVaultUnlocked()).toBe(false);
        expect(localStorage.getItem('fg_groq_key')).toBeNull();
    });

    it('a background decrypt after another tab saved does not undo Lock now', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        otherTabWrote();
        lockKeyVault();
        await new Promise(r => setTimeout(r, 50));
        expect(keyVaultUnlocked()).toBe(false);
        expect(localStorage.getItem('fg_groq_key')).toBeNull();
    });

    it('two tabs editing different keys keep both changes', async () => {
        localStorage.setItem('fg_groq_key', 'groq-old-12345');
        localStorage.setItem('fg_hf_key', 'hf-old-123456');
        await lockOn();
        // The other tab's save: the stored blob gains a new HF key, and its storage event is not delivered yet.
        localStorage.setItem('fg_hf_key', 'hf-new-123456'); await flushKeyVault();
        const otherTabsBlob = rawVault()!;
        localStorage.setItem('fg_hf_key', 'hf-old-123456'); await flushKeyVault();
        localStorage.setItem(KEY_VAULT_LS, otherTabsBlob);
        // This tab, still showing the old HF key, changes Groq.
        localStorage.setItem('fg_groq_key', 'groq-new-12345');
        await flushKeyVault();
        lockKeyVault();
        await unlockKeyVault();
        expect(localStorage.getItem('fg_groq_key')).toBe('groq-new-12345');
        expect(localStorage.getItem('fg_hf_key')).toBe('hf-new-123456');
    });

    it('another tab turning the lock on locks this page and tells the caches', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        const blob = rawVault()!;
        await disableKeyVault();
        const seen: any[] = [];
        const on = (e: any) => seen.push(e.detail);
        window.addEventListener('fg-vault-change', on);
        localStorage.setItem(KEY_VAULT_LS, blob);       // what the other tab stored
        Storage.prototype.removeItem.call(localStorage, 'fg_groq_key');
        otherTabWrote();
        window.removeEventListener('fg-vault-change', on);
        expect(keyVaultEnabled()).toBe(true);
        expect(keyVaultUnlocked()).toBe(false);
        expect(seen.length).toBe(1);
        await unlockKeyVault();
        expect(localStorage.getItem('fg_groq_key')).toBe(GROQ);
    });

    it('a damaged vault, or one from the dropped passphrase version, cannot be unlocked; Forgot it clears it', async () => {
        localStorage.setItem(KEY_VAULT_LS, '{"v":1,"iter":600000,"salt":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"AAAAAAAAAAAAAAAA","ct":"AAAAAAAAAAAAAAAAAAAAAAAAAAAA"}');
        otherTabWrote();
        expect(keyVaultEnabled()).toBe(true);
        expect(keyVaultDamaged()).toBe(true);
        await expect(unlockKeyVault()).rejects.toThrow(/damaged/);
        resetKeyVault();
        expect(keyVaultEnabled()).toBe(false);
        expect(rawVault()).toBeNull();
    });
});

describe('the page-open prompt', () => {
    it('Unlock runs from the click, and the dialog cannot be closed while the passkey request is open', async () => {
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        lockKeyVault();
        const { unlockKeysAtStartup } = await import('../key-vault-ui.ts');
        let release!: () => void; wa.hold = new Promise(r => { release = r; });
        const done = unlockKeysAtStartup();
        const dlg = document.querySelector('.fg-pass-dialog')!;
        expect(wa.gets).toBe(0);                                         // nothing asked before the click
        (dlg.querySelector('.fg-pass-ok') as HTMLButtonElement).click();
        await tick();
        expect(wa.gets).toBe(1);
        const cancel = dlg.querySelector('.fg-pass-cancel') as HTMLButtonElement;
        expect(cancel.disabled).toBe(true);
        cancel.click();
        dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
        expect(document.querySelector('.fg-pass-dialog')).not.toBeNull();   // still open while busy
        release();
        await done;
        expect(keyVaultUnlocked()).toBe(true);
        expect(document.querySelector('.fg-pass-dialog')).toBeNull();
    });
});

describe('credentials while locked', () => {
    it('the credential list includes the vault values (not enumerable in localStorage) and MCP headers', async () => {
        localStorage.setItem('fg_moonmath_key', ODD);
        localStorage.setItem('fg_mcp_servers', JSON.stringify([{ id: 'a', headers: { 'X-Api-Key': 'opaque-mcp-credential' } }]));
        await lockOn();
        const vals = storedCredentialValues();
        expect(vals).toContain(ODD);
        expect(vals).toContain('opaque-mcp-credential');
        expect(vals.some(v => v.includes('"ct"'))).toBe(false);          // never the encrypted blob
    });

    it('its version changes when a credential is written', () => {
        const v = credentialsVersion();
        localStorage.setItem('fg_groq_model', 'x');
        expect(credentialsVersion()).toBe(v);
        localStorage.setItem('fg_groq_key', GROQ);
        expect(credentialsVersion()).toBeGreaterThan(v);
    });
});

describe('config.ts after an unlock', () => {
    it('cached key getters follow the lock', async () => {
        const { ls } = await import('../config.ts');
        localStorage.setItem('fg_groq_key', GROQ);
        await lockOn();
        expect(ls('fg_groq_key')).toBe(GROQ);
        lockKeyVault();
        expect(ls('fg_groq_key')).toBe('');
        await unlockKeyVault();
        expect(ls('fg_groq_key')).toBe(GROQ);
    });

    it('credential migrations that were locked out at load run on unlock', async () => {
        await import('../config.ts');
        localStorage.setItem('fg_zro_key', ODD);           // the provider's old name, saved by an older build
        await lockOn();
        lockKeyVault();
        await unlockKeyVault();
        await tick();
        expect(localStorage.getItem('fg_moonmath_key')).toBe(ODD);
        expect(localStorage.getItem('fg_zro_key')).toBeNull();
    });
});

describe('where the lock can be used', () => {
    it('an IP address is refused up front (passkeys belong to a domain name), a host name is not', async () => {
        const { isIpHost } = await import('../key-vault.ts');
        for (const h of ['192.168.1.20', '10.0.0.5', '127.0.0.1', '::1', '[fe80::1]']) expect(isIpHost(h)).toBe(true);
        for (const h of ['localhost', 'freegent.ai', 'mybox.local', 'host-192.example']) expect(isIpHost(h)).toBe(false);
    });
});
