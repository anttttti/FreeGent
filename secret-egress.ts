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

const _SECRET_KEY_RE = /key|token|secret|pass(?:word|wd)?|pwd|auth|credential|private|session|cookie|signature|dsn|_url\b|^url$/i;
const _looksRandom = (v: string) => v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v) && !/\s/.test(v);

/** The secret-looking values in a credential file's text: values of secret-named keys (6+ characters), long random-looking values,
 *  the password of a URL with credentials, netrc passwords, and the base64 lines of a key block. */
export function secretValues(text: string): string[] {
    const out = new Set<string>();
    const add = (v: string | undefined) => { const t = String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim(); if (t.length >= 6) out.add(t); };
    for (const line of String(text ?? '').split(/\r?\n/)) {
        if (/^\s*#/.test(line)) continue;
        if (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim())) { add(line); continue; }   // PEM body
        for (const m of line.matchAll(/:\/\/[^\s:/@]+:([^\s@/]+)@/g)) add(m[1]);  // scheme://user:PASSWORD@host
        for (const m of line.matchAll(/\bpassword\s+(\S+)/gi)) add(m[1]);           // netrc
        // KEY=value first (an .npmrc key holds ':' itself: //registry/:_authToken=…), then key: value.
        const kv = /^\s*(?:export\s+)?([^=\s][^=]*?)\s*=\s*(.+?)\s*$/.exec(line) ?? /^\s*([^:\s][^:]*?)\s*:\s*(.+?)\s*$/.exec(line);
        if (!kv) continue;
        const [, key, value] = kv;
        const v = value.replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '').trim();
        if (/^(?:true|false|null|none|yes|no|\d+)$/i.test(v)) continue;
        if ((_SECRET_KEY_RE.test(key) && v.length >= 6) || _looksRandom(v)) add(v);
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
