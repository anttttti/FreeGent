// key-vault-ui.ts — FreeGent: the passkey prompt and the Settings → Credentials "Key lock" row for
// key-vault.ts. Every passkey request starts from a click (Safari refuses WebAuthn without a user
// gesture), so the page-open prompt is a dialog with an Unlock button, not an automatic request.
// While the passkey request is open the dialog cannot be closed: a dismissed prompt never unlocks
// afterwards.
//
// Every vault change, local or from another tab, arrives as the 'fg-vault-change' event; one handler
// refreshes everything that shows or uses keys, so the button flows do not each have to.
import {
    keyVaultSupported, keyVaultUnavailableReason, keyVaultPrfCapability, keyVaultEnabled, keyVaultUnlocked, keyVaultDamaged, keyVaultSaveState,
    createVaultPasskey, enableKeyVault, unlockKeyVault, lockKeyVault, disableKeyVault, resetKeyVault,
} from './key-vault.js';

interface PasskeyDialogOpts {
    title: string;
    text: string;
    actionLabel: string;
    cancelLabel: string;
    extra?: { label: string; onClick: () => boolean };            // true closes the dialog
    action: () => Promise<void>;                                  // runs from the button's click
}

/** Resolves true when `action` succeeded, false when the dialog was closed without it. */
function passkeyDialog(o: PasskeyDialogOpts): Promise<boolean> {
    return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.className = 'fg-pass-dialog';
        dlg.innerHTML = `
            <div class="fg-pass-form">
                <div class="fg-pass-title"></div>
                <p class="settings-hint fg-pass-text"></p>
                <div class="fg-pass-error" role="alert"></div>
                <div class="fg-pass-buttons">
                    ${o.extra ? '<button type="button" class="ws-action-btn fg-pass-extra"></button>' : ''}
                    <span style="flex:1"></span>
                    <button type="button" class="ws-action-btn fg-pass-cancel"></button>
                    <button type="button" class="ws-action-btn fg-pass-ok"></button>
                </div>
            </div>`;
        const q = <T extends Element>(sel: string) => dlg.querySelector(sel) as T;
        q('.fg-pass-title').textContent = o.title;
        q('.fg-pass-text').textContent = o.text;
        q('.fg-pass-ok').textContent = o.actionLabel;
        q('.fg-pass-cancel').textContent = o.cancelLabel;
        if (o.extra) q('.fg-pass-extra').textContent = o.extra.label;
        const err = q<HTMLElement>('.fg-pass-error');
        const ok = q<HTMLButtonElement>('.fg-pass-ok');
        const buttons = [...dlg.querySelectorAll('button')] as HTMLButtonElement[];
        let done = false, busy = false;
        const setBusy = (b: boolean) => { busy = b; for (const x of buttons) x.disabled = b; };
        const finish = (v: boolean) => {
            if (done || busy) return; done = true;
            try { dlg.close(); } catch {}
            dlg.remove();
            resolve(v);
        };
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); });   // Esc (ignored while busy)
        q('.fg-pass-cancel').addEventListener('click', () => finish(false));
        if (o.extra) q('.fg-pass-extra').addEventListener('click', () => { if (!busy && o.extra!.onClick()) finish(false); });
        ok.addEventListener('click', async () => {
            if (busy) return;
            err.textContent = 'Waiting for your passkey…';
            setBusy(true);
            let msg: string | null = null;
            try { await o.action(); } catch (x: any) { msg = x?.message ?? String(x); }
            setBusy(false);
            if (msg) { err.textContent = msg === 'Cancelled' ? 'The passkey request was cancelled. Try again.' : msg; ok.focus(); return; }
            finish(true);
        });
        document.body.appendChild(dlg);
        if (typeof (dlg as any).showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
        ok.focus();
    });
}

let _startup = false;
let _refreshQueued = false, _refreshFull = false;
/** Keys changed (unlocked, locked, lock turned on or off, another tab): refresh what shows or uses them.
 *  `full` is false for the unlock at page open, which goes on to fill all of this itself. */
function _keysChanged(full: boolean) {
    renderKeyLock();
    const w = window as any;
    try { w.refreshCloudSyncButton?.(); } catch {}
    if (!full) return;
    try { w.populateSettingsForm?.(); } catch {}
    try { w.renderMcpTab?.(); } catch {}
    try { w.renderModelCatalogTable?.(); w.renderMainModelList?.(); w.updateModelLabel?.(); w.updateActiveModelDisplay?.(); } catch {}
    try { w.loadCfWorkerKeys?.()?.catch?.(() => {}); } catch {}
}

function _confirmForget(): boolean {
    if (!confirm('Delete the locked keys and turn the key lock off? You will need to enter your API keys again. (The passkey itself stays in your password manager or device; you can delete it there.)')) return false;
    resetKeyVault();
    return true;
}

/** At page open: with the lock on, offer the passkey before anything uses a key. */
export async function unlockKeysAtStartup(): Promise<void> {
    if (!keyVaultEnabled() || keyVaultUnlocked()) return;
    if (keyVaultDamaged()) { console.warn('[key-vault] the saved key lock is damaged or from an older version: use Forgot it in Settings → Credentials.'); return; }
    if (!keyVaultSupported()) {
        console.warn(`[key-vault] the saved keys are locked, and this page cannot use passkeys (${keyVaultUnavailableReason()}). Open FreeGent where you locked them, or use Forgot it in Settings → Credentials to start over.`);
        return;
    }
    _startup = true;
    try {
        await passkeyDialog({
            title: 'Unlock your API keys',
            text: 'Your saved API keys are locked with a passkey. Without it, FreeGent runs without your keys (guest access and local models still work) until you unlock them in Settings → Credentials.',
            actionLabel: '🔑 Unlock with passkey',
            cancelLabel: 'Continue without keys',
            action: unlockKeyVault,
        });
    } finally { _startup = false; }
    renderKeyLock();
}

// Whether this browser's passkeys can do PRF, asked once ahead of time: awaiting it inside the click
// could cost the user gesture that the passkey request needs (Safari).
let _prfCap: boolean | null = null;
if (typeof window !== 'undefined') keyVaultPrfCapability().then(v => { _prfCap = v; renderKeyLock(); }, () => {});

async function _turnOn() {
    if (_prfCap === false) {
        alert('This browser\'s passkeys cannot lock keys (no PRF support). Try a current Chrome, Edge or Safari, or use a phone or security key as the passkey.');
        return;
    }
    let setup;
    try { setup = await createVaultPasskey(); }   // straight from the click: browsers require the gesture
    catch (e: any) { if (e?.message !== 'Cancelled') alert(e?.message ?? String(e)); return; }
    if (setup.prfOut) {
        try { await enableKeyVault(setup); } catch (e: any) { alert(e?.message ?? String(e)); }
        return;
    }
    // The authenticator did not return its secret at creation: one more passkey request, from a fresh click.
    await passkeyDialog({
        title: 'Finish locking your keys',
        text: 'The passkey was created. Confirm it once more to lock your saved keys with it.',
        actionLabel: '🔑 Confirm with passkey',
        cancelLabel: 'Cancel',
        action: () => enableKeyVault(setup),
    });
}

async function _unlock() {
    try { await unlockKeyVault(); }   // straight from the click
    catch (e: any) { if (e?.message !== 'Cancelled') alert(e?.message ?? String(e)); }
}

async function _turnOff() {
    if (!confirm('Turn the key lock off? Your keys are stored unencrypted in this browser again.')) return;
    try { await disableKeyVault(); } catch (e: any) { alert(e?.message ?? String(e)); }
}

/** Settings → Credentials: the Key lock status and its buttons. */
export function renderKeyLock(): void {
    const box = typeof document !== 'undefined' ? document.getElementById('key-lock') : null;
    if (!box) return;
    box.textContent = '';
    const btn = (label: string, title: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = 'ws-action-btn'; b.type = 'button'; b.textContent = label; b.title = title;
        b.addEventListener('click', fn);
        box.appendChild(b);
    };
    const note = (text: string) => {
        const s = document.createElement('span');
        s.className = 'settings-hint'; s.style.margin = '0'; s.textContent = text;
        box.appendChild(s);
    };
    const line = document.createElement('span');
    line.className = 'settings-hint'; line.style.margin = '0';
    const label = document.createElement('b');
    label.textContent = 'Key lock: ';
    line.appendChild(label);
    box.appendChild(line);
    const say = (t: string) => line.appendChild(document.createTextNode(t));
    const forget = () => btn('Forgot it…', 'Delete the locked keys and turn the key lock off', () => { _confirmForget(); });
    if (!keyVaultEnabled()) {
        say('Off — keys are stored unencrypted in this browser.');
        if (keyVaultSupported() && _prfCap === false) note('(this browser\'s passkeys cannot lock keys: no PRF support)');
        else if (keyVaultSupported()) btn('🔑 Lock with a passkey…', 'Encrypt the saved keys with a passkey (Touch ID, Windows Hello, phone or security key); FreeGent asks for it when it opens', _turnOn);
        else note(`(not available here: ${keyVaultUnavailableReason()})`);
    } else if (keyVaultDamaged()) {
        say('On, but the saved lock is damaged or from an older version and cannot be opened.');
        forget();
    } else if (keyVaultUnlocked()) {
        say('On, unlocked for this page.');
        btn('Lock now', 'Forget the decrypted keys until you unlock again', () => lockKeyVault());
        btn('Turn off', 'Store the keys unencrypted again', _turnOff);
    } else {
        say('On, locked — your saved keys are not in use. Keys entered now last for this page only.');
        if (keyVaultSupported()) btn('🔑 Unlock…', 'Unlock with your passkey', _unlock);
        else note(`(cannot unlock here: ${keyVaultUnavailableReason()})`);
        forget();
    }
    const st = keyVaultSaveState();
    if (st.saving) note('Saving…');
    else if (st.error) note(`Could not save the locked keys: ${st.error}`);
}

if (typeof window !== 'undefined') {
    Object.assign(window, { unlockKeysAtStartup, renderKeyLock });
    window.addEventListener('fg-vault-change', () => {
        // A save that only confirmed this page's own write announces nothing; other changes refresh once per task.
        if (!_startup) _refreshFull = true;
        if (_refreshQueued) return;
        _refreshQueued = true;
        setTimeout(() => { const full = _refreshFull; _refreshQueued = _refreshFull = false; _keysChanged(full); }, 0);
    });
    window.addEventListener('fg-vault-save', () => renderKeyLock());
}
