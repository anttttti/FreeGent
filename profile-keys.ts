// profile-keys.ts — which saved settings are credentials (never written to the profile file).
//
// Credentials only. The old pattern /key|token|secret|password/ also caught fg_agent_compact_tokens, so a compaction threshold set with /set
// vanished on exit (TUI report case 026); a token budget is a setting, a "…_token" is a credential.
const CREDENTIAL = /key|secret|password|passphrase|(?:^|_)token$/i;
export const isCredentialKey = (k: string): boolean => CREDENTIAL.test(k);

// fg_custom_models holds each model's API key beside its settings. Profiles are shared files and are
// documented as credential-free, so the keys are dropped from every profile and put back on apply.
// A value that is not a JSON list of models (truncated, another shape) is dropped, not passed on: it can still hold a key (codex R199).
// A URL that carries a credential: user info, or a query parameter named like a credential (?key=…, ?api_key=…, ?access_token=…), by the rule stored-credentials.ts uses (review of 75c664a).
export function urlCarriesCredential(v: unknown): boolean {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim())) return false;
    try { const u = new URL(v.trim()); return !!u.username || !!u.password || [...u.searchParams].some(([k, val]) => val && isCredentialKey(k)); } catch { return /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(v.trim()); }
}

export function stripModelKeys(json: string | null | undefined): string | null | undefined {
    if (json == null) return json;
    try {
        const arr = typeof json === 'string' ? JSON.parse(json) : null;
        if (!Array.isArray(arr)) return undefined;
        return JSON.stringify(arr.map((m: any) => {
            if (!m || typeof m !== 'object') return m;
            const { key: _k, apiKey: _a, ...rest } = m;
            for (const f of Object.keys(rest)) if (urlCarriesCredential((rest as any)[f])) delete (rest as any)[f];   // a model's own url with a credential in it
            return rest;
        }));
    } catch { return undefined; }
}

// One sanitizer for every way a profile is stored or written out: an imported file or a profile saved before keys were dropped can carry scalar keys
// (fg_openai_key, fg_tavily_key), which were stored as given and exported again (codex R140).
export function credentialFreeSettings(settings: Record<string, any>): Record<string, any> {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(settings ?? {})) {
        // fg_mcp_servers holds auth headers (never in profiles, storage-keys.ts); a URL with user:password@ in it (a search proxy, an endpoint) is a credential too (codex R1066, R1072-R1075).
        if (isCredentialKey(k) || k === 'fg_mcp_servers' || urlCarriesCredential(v)) continue;
        clean[k] = v;
    }
    if ('fg_custom_models' in clean) {
        const models = stripModelKeys(clean.fg_custom_models);
        if (models === undefined) delete clean.fg_custom_models; else clean.fg_custom_models = models;
    }
    return clean;
}

