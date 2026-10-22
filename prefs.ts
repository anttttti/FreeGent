// Preference writes with change notification. Settings used to be written key by key from many places and read once into
// in-memory copies (rule and skill sets, the model button, the open Settings form); nothing told those copies when a key
// changed in this tab (profile Apply) or another one, so a stale copy was later written back over the newer value
// (codex report 8, cases 243-253). A writer that goes through setPref/patchPrefs, and a copy that subscribes with
// onPrefChange, stay in step; another tab's writes arrive through the same listeners.
export type PrefOrigin = 'local' | 'remote';
export type PrefListener = (keys: string[], origin: PrefOrigin) => void;
type Match = string | RegExp | ((key: string) => boolean);

const _subs: Array<{ match: Match; fn: PrefListener }> = [];
// Every key this module has written or been asked to watch: when another tab clears ALL storage, the keys are gone from it and cannot be listed,
// but the copies in memory still hold their values (codex R16-001).
const _known = new Set<string>();

const _matches = (m: Match, k: string): boolean =>
    typeof m === 'string' ? (m.endsWith('*') ? k.startsWith(m.slice(0, -1)) : k === m) : m instanceof RegExp ? m.test(k) : m(k);

function _notify(keys: string[], origin: PrefOrigin): void {
    if (!keys.length) return;
    for (const s of [..._subs]) {
        const hit = keys.filter(k => _matches(s.match, k));
        if (!hit.length) continue;
        try { s.fn(hit, origin); } catch (e) { console.warn('[prefs] listener failed:', (e as any)?.message); }
    }
}

/** Calls `fn` with the matching keys after they changed. `match`: a key, a `prefix*`, a RegExp or a predicate.
 *  Returns an unsubscribe function. */
export function onPrefChange(match: Match, fn: PrefListener): () => void {
    const s = { match, fn };
    if (typeof match === 'string' && !match.endsWith('*')) _known.add(match);
    _subs.push(s);
    return () => { const i = _subs.indexOf(s); if (i >= 0) _subs.splice(i, 1); };
}

/** Writes (or, for null, removes) one preference and tells the listeners. Returns false when storage refused the write. */
export function setPref(key: string, value: string | number | boolean | null): boolean {
    return patchPrefs({ [key]: value });
}

/** Writes several preferences, then notifies once. Keys whose value does not change are not announced. */
export function patchPrefs(map: Record<string, string | number | boolean | null>): boolean {
    const changed: string[] = [];
    let ok = true;
    for (const [k, v] of Object.entries(map)) {
        try {
            _known.add(k);
            const before = localStorage.getItem(k);
            if (v === null) { if (before !== null) { localStorage.removeItem(k); changed.push(k); } }
            else { const s = String(v); if (before !== s) { localStorage.setItem(k, s); changed.push(k); } }
        } catch { ok = false; }
    }
    _notify(changed, 'local');
    return ok;
}

// Another tab's writes: `key` is null when it cleared storage.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e: StorageEvent) => {
        if (e.storageArea && e.storageArea !== localStorage) return;
        if (e.key == null) {
            const keys = new Set<string>(_known);
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) keys.add(k); } } catch {}
            _notify([...keys], 'remote');
        } else _notify([e.key], 'remote');
    });
}
