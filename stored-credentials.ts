// stored-credentials.ts — FreeGent: the one list of saved credential values, for redaction.
//
// Every channel that shows or sends text which could echo a key (provider and MCP errors, the chat
// log, the developer log) redacts with storedCredentialValues(), so they all know the same keys:
//   - localStorage entries whose name is a credential (profile-keys.ts's rule, so a "…_tokens" budget
//     is not one);
//   - values inside structured settings: MCP server headers, keys saved on custom models, and the
//     password in a proxy or endpoint URL.
// The redaction itself (known values plus well-known key shapes) is secrets.ts.

import { isCredentialKey } from './profile-keys.js';

const STRUCTURED = ['fg_mcp_servers', 'fg_custom_models', 'fg_search_proxy', 'fg_openai_url'];

/** Credential values held inside one structured setting. */
function _structuredValues(name: string, raw: string | null): string[] {
    if (!raw) return [];
    const out: string[] = [];
    try {
        if (name === 'fg_mcp_servers') {
            for (const s of JSON.parse(raw) || []) for (const v of Object.values(s?.headers || {})) if (v) out.push(String(v));
        } else if (name === 'fg_custom_models') {
            for (const m of JSON.parse(raw) || []) for (const f of ['key', 'apiKey']) if (m?.[f]) out.push(String(m[f]));
        } else {
            const u = new URL(raw);
            if (u.password) {
                out.push(decodeURIComponent(u.password));
                if (u.username) out.push(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password));
            }
        }
    } catch {}
    return out;
}

/** Every saved credential value this page knows. */
export function storedCredentialValues(): string[] {
    const vals = new Set<string>();
    const add = (v: string | null | undefined) => { const t = String(v ?? '').replace(/^"|"$/g, '').trim(); if (t) vals.add(t); };
    let s: Storage | null = null;
    try { s = typeof localStorage !== 'undefined' ? localStorage : null; } catch {}
    if (!s) return [];
    try {
        for (let i = 0; i < s.length; i++) {
            const k = s.key(i) || '';
            if (!STRUCTURED.includes(k) && isCredentialKey(k)) add(s.getItem(k));
        }
        for (const n of STRUCTURED) for (const v of _structuredValues(n, s.getItem(n))) add(v);
    } catch {}
    return [...vals];
}
