// fetch-blacklist.ts — FreeGent: timed per-domain blacklist for sites that block fetch_url
//
// When fetch_url returns a bot-blocking HTTP error (403/429/503) or a network-level
// refusal for a plain GET request, the site's hostname is added here with a 1-week
// expiry.  Any subsequent failure resets the timer to another full week.  A successful
// fetch removes the entry.  Search tools (Tavily, Brave, Wikipedia, …) annotate result
// URLs whose hostname is blacklisted with " [UNAVAILABLE]" so the model knows to skip
// them without wasting a fetch attempt.
//
// Storage: localStorage key 'fg_fetch_blacklist' — a JSON object mapping hostname
// strings to expiry Unix timestamps (ms).  Entries older than 1 week are pruned on
// every read so the store never grows unboundedly.
//
// The module exposes two functions used by tools.ts and a helper used by search-providers.ts.

const BLACKLIST_KEY      = 'fg_fetch_blacklist';
const BLACKLIST_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 1 week
const UNAVAILABLE_SUFFIX = ' [UNAVAILABLE]';

// ── Internal helpers ──────────────────────────────────────────────────────────

function _hostname(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function _load(): Record<string, number> {
    try {
        const raw = localStorage.getItem(BLACKLIST_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return parsed as Record<string, number>;
    } catch {
        return {};
    }
}

function _save(data: Record<string, number>): void {
    try {
        localStorage.setItem(BLACKLIST_KEY, JSON.stringify(data));
    } catch {}
}

/** Remove expired entries and return the live map. */
function _prune(): Record<string, number> {
    const now  = Date.now();
    const data = _load();
    let dirty  = false;
    for (const host of Object.keys(data)) {
        if (data[host] < now) { delete data[host]; dirty = true; }
    }
    if (dirty) _save(data);
    return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call after a fetch_url failure on a plain GET page request.
 * Adds (or refreshes) the hostname blacklist entry to now + 1 week.
 */
export function blacklistAdd(url: string): void {
    const host = _hostname(url);
    if (!host) return;
    const data = _load();
    data[host] = Date.now() + BLACKLIST_TTL_MS;
    _save(data);
    console.warn(`[fetch-blacklist] added ${host} (expires in 7 days)`);
}

/**
 * Call after a successful fetch_url response.
 * Removes the hostname from the blacklist so the site can be tried again freely.
 */
export function blacklistRemove(url: string): void {
    const host = _hostname(url);
    if (!host) return;
    const data = _load();
    if (host in data) {
        delete data[host];
        _save(data);
        console.info(`[fetch-blacklist] removed ${host} (fetch succeeded)`);
    }
}

/**
 * Returns true if the hostname of `url` is currently blacklisted.
 */
export function blacklistHas(url: string): boolean {
    const host = _hostname(url);
    if (!host) return false;
    const data = _prune();
    return host in data;
}

/**
 * Annotate a URL string: append UNAVAILABLE_SUFFIX when the host is blacklisted.
 * Safe to call on already-annotated strings (idempotent).
 */
export function annotateUrl(url: string): string {
    if (!url || url.endsWith(UNAVAILABLE_SUFFIX)) return url;
    return blacklistHas(url) ? url + UNAVAILABLE_SUFFIX : url;
}

/**
 * Strip the [UNAVAILABLE] suffix to recover the raw URL before fetching.
 */
export function stripUnavailable(url: string): string {
    return url.endsWith(UNAVAILABLE_SUFFIX)
        ? url.slice(0, -UNAVAILABLE_SUFFIX.length).trim()
        : url;
}

// Window bridge so tools.ts / search-providers.ts can reach these without
// a static import (they are loaded as globals via Object.assign(window, …)).
Object.assign(window, { blacklistAdd, blacklistRemove, blacklistHas, annotateUrl, stripUnavailable });
