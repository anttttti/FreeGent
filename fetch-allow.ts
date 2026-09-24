// fetch-allow.ts — FreeGent: origin allowlist for fetch_url (fg-run --fetch-allow).
//
// When an allowlist is set, fetch_url may only reach the listed origins; everything else is
// refused before any request is made, and the side paths that fetch other hosts (CORS proxy,
// GitHub rewrites, redirects) are disabled in tools.ts.
//
// This is request policy, not containment: execute_code can still open any connection the
// process's network allows. Runs that must stay local need network isolation around the
// process (e.g. the benchmark runners' internal Docker network) — this allowlist only gives
// fetch_url a clear, immediate refusal instead of a connection error.
//
// No allowlist (the default) → fetch_url behaves exactly as before.

let _allowed: Set<string> | null = null;

// Parse a comma-separated list of origins. Throws on any malformed entry.
export function parseFetchAllow(spec: string): string[] {
    const origins: string[] = [];
    for (const raw of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        let u: URL;
        try { u = new URL(raw); }
        catch { throw new Error(`--fetch-allow: not a URL: ${raw}`); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            throw new Error(`--fetch-allow: only http(s) origins are allowed: ${raw}`);
        if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
            throw new Error(`--fetch-allow: entry must be a bare origin (scheme://host[:port]): ${raw}`);
        origins.push(u.origin);
    }
    if (!origins.length) throw new Error('--fetch-allow: no origins given');
    return origins;
}

export function setFetchAllow(origins: string[] | null): void {
    _allowed = origins ? new Set(origins) : null;
}

export function isFetchAllowActive(): boolean {
    return _allowed !== null;
}

// Returns an error message when url is not allowed, or null when the request may proceed.
export function checkFetchAllowed(url: string): string | null {
    if (!_allowed) return null;
    let origin: string;
    try { origin = new URL(url).origin; }
    catch { return `fetch_url: invalid URL: ${url}`; }
    if (_allowed.has(origin)) return null;
    return `fetch_url: ${origin} is outside this sandbox. Only ${[..._allowed].join(', ')} can be reached.`;
}
