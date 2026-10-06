// secrets.ts — FreeGent: the one text-redaction core. Pure (no DOM, no Node), so the page, the
// MCP client and tests share it.
//
// Two complementary mechanisms, both applied by redactText():
//   - verbatim values the caller knows are secret (stored API keys, MCP header values), in every
//     form they can appear in: as given, without a Bearer/Basic/Token prefix, URL-encoded;
//   - shapes of well-known credential formats, for secrets the caller does not know about
//     (a key the user pasted into the chat).
// Channels differ only in where their known values come from (convo-log.ts: localStorage keys and
// MCP headers; mcp.ts: the server's own headers). Environment scrubbing is by variable *name*, a
// different mechanism, and lives in secret-env.ts.

export const REDACTED = '[redacted]';
const MIN_SECRET_LEN = 8;   // shorter values would mangle ordinary text

// Built from parts so this file holds no secret-shaped literal (deploy.sh scans for those).
const SECRET_SHAPES: RegExp[] = [
    /\b(?:sk|gsk|xai|pplx|cfut|hf|nvapi|tvly)[-_][A-Za-z0-9_-]{16,}/g,   // OpenAI/Anthropic/OpenRouter/Groq/xAI/Perplexity/Cloudflare/HF/NVIDIA/Tavily
    /\bAIza[0-9A-Za-z_-]{30,}/g,                                          // Google
    /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                                      // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{30,}/g,                                    // GitHub fine-grained PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
    /\bAKIA[0-9A-Z]{16}\b/g,                                              // AWS access key id
    /\bBSA[A-Za-z0-9_-]{20,}/g,                                           // Brave Search
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,   // JWT (Kilo and others)
];
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi;

/** Every form a known secret value can take in text: as given, bare token, URL-encoded. */
export function secretForms(value: unknown): string[] {
    const val = String(value ?? '').trim();
    const out = new Set<string>();
    for (const s of [val, val.replace(/^(Bearer|Basic|Token)\s+/i, '')]) {
        if (s.length < MIN_SECRET_LEN) continue;
        out.add(s);
        out.add(encodeURIComponent(s));
    }
    return [...out];
}

/** Redact known values (every form, longest first) and then anything shaped like a credential. */
export function redactText(text: string, knownValues: Iterable<unknown> = []): string {
    if (!text) return text;
    const forms = new Set<string>();
    for (const v of knownValues) for (const f of secretForms(v)) forms.add(f);
    let out = text;
    for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(REDACTED);
    for (const re of SECRET_SHAPES) out = out.replace(re, REDACTED);
    return out.replace(BEARER_RE, (_m, g1) => g1 + REDACTED);
}
