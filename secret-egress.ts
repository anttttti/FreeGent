// secret-egress.ts — values read from credential files must not leave through a network tool unless the user asked for that file.
// Codex Review898 (P1): listings leave dot-files out, but read_file (or `cat .env` in execute_code) reads them, and a fetch_url GET can then
// carry the contents to any public host; with intent validation in its default mode nothing looked at either step. Hiding the file at the
// read boundary would leave the shell route open, so the check is at the way out: the values seen in credential files this session are
// remembered, and a fetch_url / web_search that contains one is refused unless the request names the file (as for the injection-phrase and
// destructive-git checks, the person's own request is what authorises it).

// Files that hold credentials by name. Templates (.env.example, .sample, .template, .dist) hold placeholders and are left out.
const _CRED_FILE_RE = /(?:^|[/\\])(?:\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?|\.npmrc|\.pypirc|[._]netrc|\.git-credentials|\.pgpass|\.htpasswd|\.aws[/\\](?:credentials|config)|\.docker[/\\]config\.json|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\\s]+\.(?:pem|key|p12|pfx))$/i;
export function isCredentialPath(path: string): boolean { return _CRED_FILE_RE.test(String(path ?? '').trim()); }

/** Credential files named in program text (`cat .env`, `open('config/.npmrc')`). */
export function credentialFilesIn(code: string): string[] {
    return [...String(code ?? '').matchAll(/[\w./~\\-]+/g)].map(m => m[0]).filter(isCredentialPath);
}

// Words of a key name (`KEYCLOAK_REALM`, `authToken`) that make its value a secret; `auth`, `session`, `private` alone only name a purpose.
const _STRONG_KEY_WORDS = new Set(['key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pass', 'pwd', 'passphrase', 'credential', 'credentials', 'signature', 'cookie', 'dsn', 'webhook', 'apikey']);
const _strongKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some(w => _STRONG_KEY_WORDS.has(w));
// A value that names a place or a choice, not a credential: under a key that only names a purpose (AUTH_PROVIDER=github, SESSION_DRIVER=database) a lower-case word; under any key a plain
// URL without user info or query, or a lower-case host name (NEXTAUTH_URL, TOKEN_ENDPOINT). Real secrets keep a digit or mixed case, or sit under a strong key (review 2026-11-11 F02).
const _isPlace = (v: string, key: string) => /^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(v) || (!_strongKey(key) && (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(v) || /^[a-z]+$/.test(v)));
const _SECRET_KEY_RE = /key|token|secret|pass(?:word|wd)?|pwd|auth|credential|private|session|cookie|signature|dsn|webhook/i;   // not `_url`: a base URL is configuration, its password (userinfo) is taken apart below (exploration E03)
const _random = (v: string) => v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v) && !/\s/.test(v);
// A plain http(s) URL (no user info, no query) is a place, not a secret: judge its path segments (a webhook path has a random one), not its host name.
const _looksRandom = (v: string) => {
    const u = /^https?:\/\/([^\s/?#@]*)((?:\/[^\s?#]*)?)$/i.exec(v);
    return u ? u[2].split('/').some(_random) : !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(v) && _random(v);   // nor is a lower-case host name
};

/** The secret-looking values in a credential file's text: values of secret-named keys (6+ characters), long random-looking values,
 *  the password of a URL with credentials, netrc passwords, and the base64 lines of a key block. */
export function secretValues(text: string): string[] {
    const out = new Set<string>();
    const add = (v: string | undefined) => { const t = String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim(); if (t.length >= 6) out.add(t); };
    // A JSON document (credentials.json, an auth file) is read as JSON: the line reader below attached quotes, commas and braces to a compact or pretty value, so the clean
    // value the model later sent did not match (codex R100-03). Values under secret-named keys and long random-looking strings are collected, at any depth.
    try {
        const root = JSON.parse(String(text ?? ''));
        const walk = (node: unknown, key: string, depth: number) => {
            if (depth > 8) return;
            if (typeof node === 'string') { if ((_SECRET_KEY_RE.test(key) && node.length >= 6 && !_isPlace(node, key)) || _looksRandom(node)) add(node); }
            else if (Array.isArray(node)) for (const x of node) walk(x, key, depth + 1);
            else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
        };
        if (root && typeof root === 'object') { walk(root, '', 0); return [...out]; }   // the line reader would add the same values with the JSON punctuation attached
    } catch { /* not JSON: the line reader */ }
    for (const line of String(text ?? '').split(/\r?\n/)) {
        if (/^\s*#/.test(line)) continue;
        if (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim())) { add(line); continue; }   // PEM body
        for (const m of line.matchAll(/:\/\/[^\s:/@]*:([^\s@/]+)@/g)) add(m[1]);  // scheme://user:PASSWORD@host
        for (const m of line.matchAll(/\bpassword\s+(\S+)/gi)) add(m[1]);           // netrc
        // KEY=value first (an .npmrc key holds ':' itself: //registry/:_authToken=…), then key: value.
        const kv = /^\s*(?:export\s+)?([^=\s][^=]*?)\s*=\s*(.+?)\s*$/.exec(line) ?? /^\s*([^:\s][^:]*?)\s*:\s*(.+?)\s*$/.exec(line);
        if (!kv) continue;
        const [, key, value] = kv;
        const v = value.replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '').trim();
        if (/^(?:true|false|null|none|yes|no|\d+)$/i.test(v)) continue;
        if ((_SECRET_KEY_RE.test(key) && v.length >= 6 && !_isPlace(v, key)) || _looksRandom(v)) add(v);
    }
    return [...out];
}

const _seen = new Map<string, string>();   // secret value -> the credential file it came from
const _SEEN_MAX = 2000;

/** Remember the secret values of `text`, read from `file`. */
export function noteSecrets(file: string, text: string): void {
    for (const v of secretValues(text)) { if (_seen.size >= _SEEN_MAX) return; if (!_seen.has(v)) _seen.set(v, file); }
}
export function resetSecrets(): void { _seen.clear(); }

const _b64 = (s: string) => { try { return btoa(String.fromCharCode(...new TextEncoder().encode(s))); } catch { return ''; } };
const _named = (file: string, request: string) => {
    const base = String(file).split(/[/\\]/).pop() ?? '';
    const r = request.toLowerCase();
    return !!base && (r.includes(base.toLowerCase()) || (/^\.env\b/i.test(base) && /(?:^|[^\w])\.env\b/i.test(request)));
};

/** Why `outgoing` (a URL, headers and body as text) must not be sent, or null: it contains a value read from a credential file
 *  that the request does not name. Plain, URL-encoded and base64 forms are looked for. */
export function secretEgressReason(tool: string, outgoing: string, request: string): string | null {
    if (!_seen.size) return null;
    const text = String(outgoing ?? '');
    let decoded = text; try { decoded = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep the raw text */ }
    for (const [v, file] of _seen) {
        if (!(text.includes(v) || decoded.includes(v) || text.includes(encodeURIComponent(v)) || (v.length >= 8 && text.includes(_b64(v)))))
            continue;
        if (_named(file, String(request ?? ''))) continue;
        return `${tool} would send a value read from ${file} (a credential file) to the network, and the request does not ask for that file. Nothing was sent. Leave the credential out of the request; only the user can ask for it to be used here, by naming the file`;
    }
    return null;
}
