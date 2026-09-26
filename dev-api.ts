// dev-api.ts — FreeGent: the dev/preview server's /api/* endpoints and key handling (Node only).
//
// Loaded by vite.config.ts; never imported by browser code.
//
// Security model
// ──────────────
// - API keys loaded from ~/.config/freegent/credentials (or .env) never reach the browser. The page
//   receives placeholders ("__fgsk__fg_gemini_key__"); /api/proxy swaps in the real key only when
//   the request goes to that provider's own hosts over HTTPS (KEY_HOSTS). A page, preview or agent
//   can make the server *use* a key with its provider, but can't read it or send it elsewhere.
// - Every /api/* request needs the per-install token in X-FG-Token. On a localhost-bound server the
//   token is embedded in the page; on a LAN-bound server it's not — open the URL printed at
//   startup, which carries it once (#fg_token=…), and the page keeps it in localStorage.
// - /api/proxy refuses to reach the dev server itself (by address and port, after DNS, on every
//   redirect hop), so nothing can route a request back into /api/* through it.
// - /api/execute runs with credentials stripped from the environment (secret-env.ts). It still runs
//   as the user; see the approval defaults in config.ts.

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname, basename, normalize, relative, sep } from 'node:path';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scrubEnv } from './secret-env.js';

const execFileAsync = promisify(execFile);

// ── Keys ──────────────────────────────────────────────────────────────────────

// Environment variable → FreeGent settings key. The first variable found wins per settings key.
export const KEY_MAP: Array<[string, string]> = [
    ['GEMINI_API_KEY',        'fg_gemini_key'],
    ['GOOGLE_API_KEY',        'fg_gemini_key'],
    ['MISTRAL_API_KEY',       'fg_mistral_key'],
    ['GROQ_API_KEY',          'fg_groq_key'],
    ['CEREBRAS_API_KEY',      'fg_cerebras_key'],
    ['NVIDIA_API_KEY',        'fg_nvidia_key'],
    ['OPENROUTER_API_KEY',    'fg_openrouter_key'],
    ['OPENCODE_API_KEY',      'fg_opencode_key'],
    ['TOKENHARBOR_API_KEY',   'fg_tokenharbor_key'],
    ['KILO_API_KEY',          'fg_kilo_key'],
    ['VERCEL_API_KEY',        'fg_vercel_key'],
    ['NOUSPORTAL_API_KEY',    'fg_nous_key'],
    ['NOUS_API_KEY',          'fg_nous_key'],
    ['OPENAI_API_KEY',        'fg_openai_key'],
    ['TAVILY_API_KEY',        'fg_tavily_key'],
    ['HF_API_KEY',            'fg_hf_key'],
    ['HUGGINGFACE_API_KEY',   'fg_hf_key'],
    ['BRAVE_API_KEY',         'fg_brave_key'],
    ['GITHUB_TOKEN',          'fg_github_token'],
    ['STACKEXCHANGE_API_KEY', 'fg_stackexchange_key'],
];

// The one API host each server key may be sent to (exact match — no subdomains, so a key can't
// reach a user-content subdomain of a provider's domain). A placeholder aimed at any other host
// is refused, so a prompt-injected request can't carry a key to an attacker.
export const KEY_HOSTS: Record<string, string[]> = {
    fg_gemini_key:        ['generativelanguage.googleapis.com'],
    fg_mistral_key:       ['api.mistral.ai'],
    fg_groq_key:          ['api.groq.com'],
    fg_cerebras_key:      ['api.cerebras.ai'],
    fg_nvidia_key:        ['integrate.api.nvidia.com'],
    fg_openrouter_key:    ['openrouter.ai'],
    fg_opencode_key:      ['opencode.ai'],
    fg_tokenharbor_key:   ['tokenharbor.ai'],
    fg_kilo_key:          ['api.kilo.ai'],
    fg_vercel_key:        ['ai-gateway.vercel.sh'],
    fg_nous_key:          ['inference-api.nousresearch.com'],
    fg_openai_key:        ['api.openai.com'],
    fg_tavily_key:        ['api.tavily.com'],
    fg_hf_key:            ['router.huggingface.co'],
    fg_brave_key:         ['api.search.brave.com'],
    fg_github_token:      ['api.github.com'],
    fg_stackexchange_key: ['api.stackexchange.com'],
};

export const placeholderFor = (fgKey: string): string => `__fgsk__${fgKey}__`;
const _PLACEHOLDER_RE = /__fgsk__(fg_[a-z0-9_]+?)__/g;

// Settings key → value, from the environment (after loadDotenv).
export function serverKeys(env: Record<string, string | undefined> = process.env): Record<string, string> {
    const keys: Record<string, string> = {};
    for (const [envVar, fgKey] of KEY_MAP) {
        if (keys[fgKey]) continue;
        const val = env[envVar] ?? '';
        if (val) keys[fgKey] = val;
    }
    return keys;
}

// What the page learns about each server key: a short hash, never the value. The page uses the
// hash to delete copies of the key that older versions saved into localStorage.
export function serverKeyStatus(keys: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys))
        out[k] = createHash('sha256').update(v).digest('hex').slice(0, 16);
    return out;
}

function _hostAllowed(host: string, allowed: string[]): boolean {
    return allowed.includes(host);
}

// Per-IP token-failure throttle: blocks brute-force attempts on the X-FG-Token header.
const _tokenFailures = new Map<string, { count: number; resetAt: number }>();
const _TOKEN_FAIL_MAX = 30;
const _TOKEN_FAIL_WINDOW_MS = 60_000;
function _checkTokenThrottle(ip: string): boolean {
    const now = Date.now();
    const rec = _tokenFailures.get(ip);
    return !!(rec && now < rec.resetAt && rec.count >= _TOKEN_FAIL_MAX);
}
function _recordTokenFailure(ip: string): void {
    const now = Date.now();
    const rec = _tokenFailures.get(ip);
    if (!rec || now >= rec.resetAt) _tokenFailures.set(ip, { count: 1, resetAt: now + _TOKEN_FAIL_WINDOW_MS });
    else rec.count++;
}

export class ProxyRefusal extends Error {}

// Replace placeholders in the URL, header values and a string body with the real keys.
// Throws ProxyRefusal when a placeholder names a key that isn't loaded or isn't allowed for the
// target host. `used` reports whether any key was substituted.
export function substituteServerKeys(
    url: string, headers: Record<string, string>, body: string | undefined,
    keys: Record<string, string>,
): { url: string; headers: Record<string, string>; body: string | undefined; used: boolean } {
    let used = false;
    let host = '', protocol = '';
    try { ({ hostname: host, protocol } = new URL(url)); } catch { /* checked below if needed */ }
    const sub = (s: string): string => s.replace(_PLACEHOLDER_RE, (_m, fgKey: string) => {
        const val = keys[fgKey];
        if (!val) throw new ProxyRefusal(`no server key for ${fgKey}`);
        if (protocol !== 'https:' || !_hostAllowed(host, KEY_HOSTS[fgKey] ?? []))
            throw new ProxyRefusal(`server key ${fgKey} can't be sent to ${host || url}`);
        used = true;
        return val;
    });
    // The URL is checked on its own first: its host decides where every other value may go.
    const outUrl = sub(url);
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) outHeaders[k] = typeof v === 'string' ? sub(v) : v;
    const outBody = typeof body === 'string' ? sub(body) : body;
    return { url: outUrl, headers: outHeaders, body: outBody, used };
}

// ── Token ─────────────────────────────────────────────────────────────────────

// Stable across restarts (so a phone's saved URL keeps working); FG_TOKEN overrides.
export function loadOrCreateToken(file: string): string {
    if (process.env.FG_TOKEN) return process.env.FG_TOKEN;
    try {
        const t = readFileSync(file, 'utf-8').trim();
        if (/^[A-Za-z0-9_-]{32,}$/.test(t)) return t;
    } catch { /* create below */ }
    const token = randomBytes(24).toString('base64url');
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, token + '\n', { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch { /* read-only config dir: keep the token in memory for this run */ }
    return token;
}

function _tokenOk(given: string | undefined, token: string): boolean {
    if (!given) return false;
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

// ── Dotenv ────────────────────────────────────────────────────────────────────

function _parseDotenvFile(envPath: string): void {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const idx = t.indexOf('=');
        const key = t.slice(0, idx).trim();
        let val = t.slice(idx + 1).trim();
        if (val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'"))
            val = val.slice(1, -1);
        if (key && !(key in process.env)) process.env[key] = val;
    }
}

export function configDir(): string {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'freegent');
}

// Precedence: shell env, then <project>/.env, then ~/.config/freegent/credentials.
export function loadDotenv(): void {
    _parseDotenvFile(join(process.cwd(), '.env'));
    _parseDotenvFile(join(configDir(), 'credentials'));
}

// ── Self-target detection ─────────────────────────────────────────────────────

function _ownAddresses(): Set<string> {
    const out = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
    for (const list of Object.values(networkInterfaces()))
        for (const i of list ?? []) out.add(i.address.toLowerCase().replace(/%.*$/, ''));
    return out;
}

function _isOwnAddress(addr: string, own: Set<string>): boolean {
    let a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
        a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    } else if (a.startsWith('::ffff:')) a = a.slice(7);
    if (/^127\./.test(a)) return true;
    return own.has(a);
}

// True when rawUrl would reach this server: one of its addresses (after DNS resolution) on its
// port. Other ports on this machine stay reachable — that's where local LLM servers live.
export async function isSelfTarget(rawUrl: string, serverPort: number): Promise<boolean> {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return true; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    if (port !== serverPort) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    let addrs: string[];
    if (isIP(host)) addrs = [host];
    else {
        try { addrs = (await lookup(host, { all: true })).map(a => a.address); }
        catch { return false; }   // unresolvable: the fetch fails anyway
    }
    const own = _ownAddresses();
    return addrs.some(a => _isOwnAddress(a, own));
}

// ── Address policy ────────────────────────────────────────────────────────────

// 'linklocal' (169.254/16, fe80::/10 — cloud metadata lives here) is never reachable through the
// proxy. 'private' covers loopback, RFC 1918, CGNAT, unique-local, multicast and unspecified.
export type AddressClass = 'public' | 'private' | 'linklocal';

function _v4(a: string): number[] | null {
    const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    return m ? m.slice(1).map(Number) : null;
}

export function classifyAddress(addr: string): AddressClass {
    let a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
        a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    } else if (a.startsWith('::ffff:')) a = a.slice(7);
    const v4 = _v4(a);
    if (v4) {
        const [x, y] = v4;
        if (x === 169 && y === 254) return 'linklocal';
        if (x === 0 || x === 10 || x === 127 || x >= 224) return 'private';
        if (x === 172 && y >= 16 && y <= 31) return 'private';
        if (x === 192 && y === 168) return 'private';
        if (x === 100 && y >= 64 && y <= 127) return 'private';
        if (x === 198 && (y === 18 || y === 19)) return 'private';
        return 'public';
    }
    // Normalize fully-expanded IPv6 to detect loopback/unspecified without :: shorthand.
    if (!a.includes('::') && a.split(':').length === 8) {
        const segs = a.split(':').map(p => parseInt(p || '0', 16));
        if (segs.every(n => n === 0)) a = '::';
        else if (segs.slice(0, 7).every(n => n === 0) && segs[7] === 1) a = '::1';
    }
    if (a === '::' || a === '::1') return 'private';
    if (/^fe[89ab]/.test(a)) return 'linklocal';
    if (/^f[cd]/.test(a) || /^ff/.test(a)) return 'private';
    return 'public';
}

// The GET proxy serves URLs that the agent chooses (fetch_url, preview relays), so it may only
// reach public addresses. The check runs in the connect-time DNS lookup — the address actually
// dialled — so a hostname can't pass the check and then resolve somewhere else (DNS rebinding).
function _publicOnlyLookup(serverPort: number, targetPort: number) {
    return (hostname: string, options: any, cb: (...a: any[]) => void) => {
        lookupCb(hostname, { all: true, family: options?.family ?? 0, hints: options?.hints }, (err, addrs: LookupAddress[]) => {
            if (err) return cb(err);
            const own = _ownAddresses();
            const bad = addrs.find(x => classifyAddress(x.address) !== 'public'
                || (targetPort === serverPort && _isOwnAddress(x.address, own)));
            if (bad) return cb(new ProxyRefusal(`${hostname} resolves to a non-public address (${bad.address})`));
            if (options?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
        });
    };
}

export interface PublicGetResult { status: number; headers: IncomingHttpHeaders; body: Buffer }

export async function publicGet(
    url: string, headers: Record<string, string>, serverPort: number, keyUsed: boolean,
    { maxBytes = 50 * 1024 * 1024, timeoutMs = 30_000 } = {},
): Promise<PublicGetResult> {
    let cur = new URL(url);
    for (let hop = 0; hop <= 5; hop++) {
        if (cur.protocol !== 'http:' && cur.protocol !== 'https:') throw new ProxyRefusal(`only http(s) URLs can be fetched`);
        const port = cur.port ? parseInt(cur.port, 10) : (cur.protocol === 'https:' ? 443 : 80);
        const host = cur.hostname.replace(/^\[|\]$/g, '');
        // IP literals never go through lookup(): check them here.
        if (isIP(host) && (classifyAddress(host) !== 'public' || (port === serverPort && _isOwnAddress(host, _ownAddresses()))))
            throw new ProxyRefusal(`${host} is not a public address`);
        const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            const req = (cur.protocol === 'https:' ? httpsRequest : httpRequest)(cur, {
                method: 'GET',
                headers: { ...headers, 'accept-encoding': 'identity' },
                lookup: _publicOnlyLookup(serverPort, port) as any,
                timeout: timeoutMs,
            }, resolve);
            req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs / 1000} s`)));
            req.on('error', reject);
            req.end();
        });
        const status = res.statusCode ?? 502;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc) {
            res.resume();
            const next = new URL(loc, cur);
            if (keyUsed && next.host !== cur.host)
                throw new ProxyRefusal('redirect to another host refused: the request carries a server key');
            cur = next;
            continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of res) {
            size += c.length;
            if (size > maxBytes) { res.destroy(); throw new ProxyRefusal(`response larger than ${maxBytes / 1024 / 1024} MB`); }
            chunks.push(c);
        }
        return { status, headers: res.headers, body: Buffer.concat(chunks) };
    }
    throw new ProxyRefusal('too many redirects');
}

// Link-local addresses (cloud metadata) are refused for every proxy request, including the POST
// path used for your configured LLM endpoints (which may be on this machine or your LAN).
async function _refuseLinkLocal(rawUrl: string): Promise<void> {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
    let addrs: string[];
    if (isIP(host)) addrs = [host];
    else { try { addrs = (await lookup(host, { all: true })).map(a => a.address); } catch { return; } }
    if (addrs.some(a => classifyAddress(a) === 'linklocal')) throw new ProxyRefusal(`${host} is a link-local address`);
}

// fetch that follows redirects itself, checking every hop. With a server key in the request it
// refuses to follow a redirect to a different host (the key would travel with the headers).
export async function guardedFetch(
    url: string, init: RequestInit & { method: string }, serverPort: number,
    keyUsed: boolean, fetchImpl: typeof fetch = fetch,
): Promise<Response> {
    let cur = url, req = { ...init };
    for (let hop = 0; hop <= 5; hop++) {
        if (await isSelfTarget(cur, serverPort)) throw new ProxyRefusal('requests to the FreeGent dev server itself are not allowed');
        await _refuseLinkLocal(cur);
        const resp = await fetchImpl(cur, { ...req, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
        const loc = resp.headers.get('location');
        if (!loc) return resp;
        const next = new URL(loc, cur).toString();
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        if (keyUsed && new URL(next).host !== new URL(cur).host)
            throw new ProxyRefusal('redirect to another host refused: the request carries a server key');
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && req.method !== 'GET' && req.method !== 'HEAD'))
            req = { ...req, method: 'GET', body: undefined };
        cur = next;
    }
    throw new ProxyRefusal('too many redirects');
}

// ── Exec isolation ────────────────────────────────────────────────────────────

// /api/execute runs agent code on this machine. With bubblewrap (Linux) each command runs in its
// own mount namespace where the home directory — the credentials file, SSH keys, browser data,
// other projects — doesn't exist: only system directories (read-only), the command's temp
// directory (writable) and the toolchains on PATH (read-only). Network access stays.
//   FG_EXEC_ISOLATION=auto (default: bubblewrap when it works here) | bwrap | none
//   FG_EXEC_BIND=/path/a,/path/b   extra read-only paths to expose
export type ExecIsolation = 'bwrap' | 'none';

const _SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt', '/snap'];
// /etc is excluded from the wide bind to avoid exposing /etc/shadow, /etc/sudoers, etc.
// Only the paths actually needed by toolchains are bound below.
const _ETC_EXPOSE = [
    '/etc/ssl', '/etc/ca-certificates.conf', '/etc/ca-certificates', // HTTPS certificates
    '/etc/alternatives',                                  // update-alternatives symlinks
    '/etc/localtime', '/etc/timezone',                   // timezone
    '/etc/hosts',                                         // hostname resolution (resolv.conf handled separately)
    '/etc/nsswitch.conf',                                 // name service switch
    '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/ld.so.cache', // dynamic linker
    '/etc/os-release', '/etc/lsb-release', '/etc/debian_version', // OS info
    '/etc/group', '/etc/passwd',                         // world-readable user/group info
    '/etc/hostname',                                      // system hostname
    '/etc/locale.gen', '/etc/default/locale', '/etc/environment', // locale
    '/etc/gitconfig',                                     // git system config
    '/etc/pip.conf', '/etc/pip',                         // pip config
    '/etc/wgetrc', '/etc/curlrc',                        // wget/curl config
    '/etc/java-21-openjdk', '/etc/java-17-openjdk', '/etc/java-11-openjdk', // JVM config
    '/etc/terminfo',                                      // terminal info
    '/etc/mime.types',                                    // MIME type mappings
];
// Under $HOME, these hold secrets or personal data, so they're never exposed as a toolchain.
const _HOME_PRIVATE = ['.config', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.netrc', '.mozilla', '.password-store'];

// Read-only paths that make the user's toolchains work: for each PATH entry under $HOME, the
// install prefix (…/anaconda3 for …/anaconda3/bin) — except $HOME itself, ~/.local (only its
// bin/ and lib/) and the private directories above.
export function toolchainBinds(pathVar: string, home: string): string[] {
    const out = new Set<string>();
    for (const raw of pathVar.split(':').filter(Boolean)) {
        let p: string;
        try { p = realpathSync(raw); } catch { continue; }
        if (!p.startsWith(home + sep)) continue;
        const top = p.slice(home.length + 1).split(sep)[0];
        if (_HOME_PRIVATE.includes(top)) continue;
        if (top === '.local') { out.add(join(home, '.local', 'bin')); out.add(join(home, '.local', 'lib')); continue; }
        const prefix = basename(p) === 'bin' ? dirname(p) : p;
        if (prefix === home) { out.add(p); continue; }
        out.add(prefix);
    }
    for (const extra of (process.env.FG_EXEC_BIND ?? '').split(',').map(x => x.trim()).filter(Boolean)) out.add(extra);
    return [...out];
}

export function bwrapArgs(workDir: string, pathVar: string, home: string): string[] {
    const args = ['--die-with-parent', '--unshare-all', '--share-net', '--new-session'];
    for (const d of _SYSTEM_DIRS) args.push('--ro-bind-try', d, d);
    for (const d of _ETC_EXPOSE) args.push('--ro-bind-try', d, d);
    // /etc/resolv.conf is often a symlink into /run (systemd-resolved): expose its target's
    // directory, or DNS fails inside the sandbox.
    try {
        const resolv = realpathSync('/etc/resolv.conf');
        args.push('--ro-bind-try', resolv, '/etc/resolv.conf');
        if (!resolv.startsWith('/etc/')) args.push('--ro-bind-try', dirname(resolv), dirname(resolv));
    } catch { /* no resolv.conf */ }
    for (const d of toolchainBinds(pathVar, home)) args.push('--ro-bind-try', d, d);
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', workDir, workDir, '--chdir', workDir);
    return args;
}

let _isolation: ExecIsolation | null = null;
export function execIsolation(): ExecIsolation {
    if (_isolation) return _isolation;
    const want = (process.env.FG_EXEC_ISOLATION ?? 'auto').toLowerCase();
    if (want === 'none') return (_isolation = 'none');
    // Probe with the real argument list: bwrap must exist and user namespaces must be allowed.
    const probeDir = tmpdir();
    const ok = process.platform === 'linux'
        && spawnSync('bwrap', [...bwrapArgs(probeDir, process.env.PATH ?? '', homedir()), '--', 'true'], { timeout: 5000 }).status === 0;
    if (!ok && want === 'bwrap') throw new Error('FG_EXEC_ISOLATION=bwrap, but bubblewrap does not work here');
    return (_isolation = ok ? 'bwrap' : 'none');
}

// ── Git argument filter ───────────────────────────────────────────────────────

// Git can be made to run programs, write arbitrary files, or read files outside the repository
// through options. run_git exists to run git on this project, so these are refused; everything
// else — including mutating commands on a localhost server — is allowed. (With bubblewrap,
// /api/git also runs isolated: see apiGit.)
//   Global options (before the subcommand): config/helper overrides, and anything that points
//   git at a different repository or working tree. Separate-value and attached forms both count.
const _GIT_GLOBAL_REFUSED = /^(-c|--config-env|--exec-path|-C|--git-dir|--work-tree)/;
//   Subcommands that run programs or rewrite config.
const _GIT_EXEC_SUBCMDS = new Set(['difftool', 'mergetool', 'filter-branch', 'filter-repo', 'daemon',
    'instaweb', 'upload-pack', 'receive-pack', 'shell', 'credential', 'config', 'fsmonitor--daemon']);
//   Per-subcommand options that name a program to run, set config, or install hook templates.
const _GIT_SUB_EXEC: Record<string, RegExp> = {
    clone:       /^(-u|--upload-pack|-c|--config|--template)(=|$)|^-c./,
    init:        /^--template(=|$)/,
    fetch:       /^--upload-pack(=|$)/,
    pull:        /^--upload-pack(=|$)/,
    'ls-remote': /^--upload-pack(=|$)/,
    archive:     /^(--exec|--remote)(=|$)/,
    push:        /^(--receive-pack|--exec)(=|$)/,
    grep:        /^(-O|--open-files-in-pager)/,
    rebase:      /^(-x|--exec)(=|$)/,
};
//   Anywhere: writing output to a path, or reading paths outside the repository.
const _GIT_ANY_REFUSED = /^(--output|--no-index)(=|$)/;

export function gitArgsRefusal(args: string[]): string | null {
    let i = 0;
    for (; i < args.length && args[i].startsWith('-'); i++)
        if (_GIT_GLOBAL_REFUSED.test(args[i])) return `git option ${args[i].split('=')[0]} is not available through run_git`;
    const sub = args[i] ?? '';
    const rest = args.slice(i + 1);
    if (_GIT_EXEC_SUBCMDS.has(sub)) return `git ${sub} is not available through run_git`;
    if (sub === 'submodule' && rest.includes('foreach')) return 'git submodule foreach is not available through run_git';
    if (sub === 'bisect' && rest.includes('run')) return 'git bisect run is not available through run_git';
    const re = _GIT_SUB_EXEC[sub];
    const bad = rest.find(a => (re && re.test(a)) || _GIT_ANY_REFUSED.test(a));
    if (bad) return `git ${sub} ${bad.split('=')[0]} is not available through run_git`;
    return null;
}

// Commit identity for isolated git (~/.gitconfig isn't visible inside the sandbox): read once from
// your git config and passed as environment variables.
let _gitIdentity: Record<string, string> | null = null;
function _gitIdentityEnv(cwd: string): Record<string, string> {
    if (_gitIdentity) return _gitIdentity;
    const get = (k: string) => spawnSync('git', ['config', '--get', k], { cwd, encoding: 'utf-8' }).stdout?.trim() ?? '';
    const name = get('user.name'), email = get('user.email');
    _gitIdentity = {};
    if (name)  { _gitIdentity.GIT_AUTHOR_NAME = name;   _gitIdentity.GIT_COMMITTER_NAME = name; }
    if (email) { _gitIdentity.GIT_AUTHOR_EMAIL = email; _gitIdentity.GIT_COMMITTER_EMAIL = email; }
    return _gitIdentity;
}

// Subcommands that only read repository state (network-bound servers share one working tree).
const _GIT_READONLY = new Set([
    'status', 'diff', 'log', 'show', 'branch', 'remote', 'tag',
    'ls-files', 'ls-tree', 'cat-file', 'describe', 'rev-parse', 'rev-list',
    'blame', 'grep', 'shortlog', 'reflog', 'stash', 'worktree',
]);
const _GIT_READONLY_STASH_OPS    = new Set(['list', 'show']);
const _GIT_READONLY_WORKTREE_OPS = new Set(['list']);
// 'remote' is in _GIT_READONLY because querying remotes is safe, but mutating
// subcommands write .git/config — exactly the file _refuseGitMetadata protects.
const _GIT_READONLY_REMOTE_OPS   = new Set(['-v', '--verbose', 'show', 'get-url']);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export class BodyTooLarge extends Error {}

// Request bodies are capped (execute_code sends the workspace, each file ≤ 1 MB): a client can't
// exhaust the server's memory by streaming an endless body.
const MAX_BODY_BYTES = 64 * 1024 * 1024;
function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > max) { req.resume(); reject(new BodyTooLarge()); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > max) { req.destroy(); reject(new BodyTooLarge()); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function jsonSend(res: ServerResponse, data: unknown, status = 200): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function jsonErr(res: ServerResponse, status: number, message: string): void {
    jsonSend(res, { error: message }, status);
}

// Same shape as the CF Worker's proxy errors: X-FG-Proxy-Error tells them apart from upstream responses.
function proxyErr(res: ServerResponse, status: number, message: string): void {
    res.setHeader('X-FG-Proxy-Error', '1');
    jsonErr(res, status, message);
}

// Upstream response headers that must not be copied: framing (Node's fetch has already decoded
// the body), cookies, and CORS/HSTS policy that belongs to the upstream origin.
const _SKIP_RESP_HEADERS = new Set([
    'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
    'set-cookie', 'set-cookie2', 'strict-transport-security', 'alt-svc',
]);

function _copyRespHeaders(upstream: Response, res: ServerResponse): void {
    upstream.headers.forEach((v, k) => {
        if (_SKIP_RESP_HEADERS.has(k) || k.startsWith('access-control-')) return;
        res.setHeader(k, v);
    });
}

// Headers a GET proxy caller may set via ?h=<base64 JSON> (same whitelist as the CF Worker).
const _SAFE_GET_HEADERS = new Set(['accept', 'accept-language', 'cache-control', 'referer', 'x-requested-with', 'content-type']);

// ── The API ───────────────────────────────────────────────────────────────────

export interface DevApiOptions {
    bind: string;
    port: number;
    allowedOrigins: Set<string>;
    token: string;
    keys: Record<string, string>;
    fetchImpl?: typeof fetch;
}

export function createDevApi(opts: DevApiOptions) {
    const { bind, port, allowedOrigins, token, keys } = opts;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const lan = bind !== '127.0.0.1';

    async function apiExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let tmpDir: string | null = null;
        try {
            let body: any; try { body = JSON.parse(await readBody(req)); }
            catch (e) { jsonErr(res, e instanceof BodyTooLarge ? 413 : 400, e instanceof BodyTooLarge ? 'request body too large' : 'invalid JSON body'); return; }
            const language: string = body.language ?? 'bash';
            const code: string = body.code ?? '';
            const files: Record<string, string> = body.files ?? {};

            let cmd: [string, string[]];
            if (language === 'bash') cmd = ['bash', ['-c', code]];
            else if (language === 'python' || language === 'python3') cmd = ['python3', ['-c', code]];
            else { jsonErr(res, 400, `Unsupported language: ${language}`); return; }

            tmpDir = await mkdtemp(join(tmpdir(), 'fg_'));
            for (const [relPath, content] of Object.entries(files)) {
                const safe = normalize(join(tmpDir, relPath));
                if (!safe.startsWith(tmpDir + sep)) continue;
                await mkdir(dirname(safe), { recursive: true });
                // Binary files are tagged '\x00BIN\x00<base64>' by the browser
                if (content.startsWith('\x00BIN\x00')) await writeFile(safe, Buffer.from(content.slice(5), 'base64'));
                else await writeFile(safe, content, 'utf-8');
            }

            let stdout = '', stderr = '', exitCode = 0;
            try {
                const env = { ...scrubEnv(process.env), HOME: tmpDir };
                const [bin, binArgs] = execIsolation() === 'bwrap'
                    ? ['bwrap', [...bwrapArgs(tmpDir, env.PATH ?? '', homedir()), '--', cmd[0], ...cmd[1]]]
                    : cmd;
                const r = await execFileAsync(bin, binArgs, {
                    cwd: tmpDir, timeout: 60_000, env,
                    maxBuffer: 10 * 1024 * 1024,
                });
                stdout = r.stdout; stderr = r.stderr;
            } catch (err: any) {
                if (err.code === 'ETIMEDOUT') { jsonSend(res, { stdout: '', stderr: 'Timeout (60s)', exit_code: 124 }); return; }
                stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
                exitCode = typeof err.code === 'number' ? err.code : 1;
            }

            const filesWritten: Record<string, string> = {};
            const walk = async (dir: string): Promise<void> => {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    const abs = join(dir, entry.name);
                    if (entry.isDirectory()) { await walk(abs); continue; }
                    // Skip symlinks: agent code inside the sandbox can create a dangling symlink
                    // to any host path (e.g. ~/.config/freegent/credentials), and readFile would
                    // follow it outside the sandbox namespace. O_NOFOLLOW is a second line of
                    // defence against a TOCTOU race between isSymbolicLink and the open.
                    if (entry.isSymbolicLink()) continue;
                    const rel = relative(tmpDir!, abs);
                    try {
                        const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
                        const rawBytes = await fh.readFile().finally(() => fh.close());
                        // Detect binary content by checking for null bytes in the first 8KB
                        if (rawBytes.subarray(0, 8192).includes(0)) {
                            const b64Tagged = '\x00BIN\x00' + rawBytes.toString('base64');
                            if ((files[rel] ?? '') !== b64Tagged) filesWritten[rel] = b64Tagged;
                        } else {
                            const content = rawBytes.toString('utf-8');
                            if (files[rel] !== content && ('\x00BIN\x00' + Buffer.from(content).toString('base64')) !== files[rel])
                                filesWritten[rel] = content;
                        }
                    } catch { /* unreadable */ }
                }
            };
            await walk(tmpDir);
            jsonSend(res, { stdout, stderr, exit_code: exitCode, files_written: filesWritten });
        } catch (err: any) {
            jsonErr(res, 500, String(err));
        } finally {
            if (tmpDir) rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async function apiGit(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let body: any; try { body = JSON.parse(await readBody(req)); }
        catch (e) { jsonErr(res, e instanceof BodyTooLarge ? 413 : 400, e instanceof BodyTooLarge ? 'request body too large' : 'invalid JSON body'); return; }
        const args: unknown = body.args;
        if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
            jsonErr(res, 400, 'args must be a list of strings'); return;
        }
        const refusal = gitArgsRefusal(args);
        if (refusal) { jsonErr(res, 403, refusal); return; }
        // Network-bound: clients share one working tree, so only read-only subcommands.
        if (lan) {
            const sub = args[0] ?? '';
            const sub2 = args[1] ?? 'list';  // bare `git stash` lists
            const allowed = _GIT_READONLY.has(sub)
                && (sub !== 'stash'    || _GIT_READONLY_STASH_OPS.has(sub2))
                && (sub !== 'worktree' || _GIT_READONLY_WORKTREE_OPS.has(sub2))
                && (sub !== 'remote'   || _GIT_READONLY_REMOTE_OPS.has(sub2));
            if (!allowed) {
                jsonErr(res, 403, `git ${sub}: mutating git commands are disabled when the server is network-bound ` +
                    `(multiple clients share one working tree). Use a local sandbox or access via localhost.`);
                return;
            }
        }
        // With bubblewrap, git sees only the system directories and this repository (read-write):
        // hooks and repo config it runs can't reach your home directory. Remote operations that
        // need your SSH keys or credential helper won't work from here — push from your shell.
        const repo = process.cwd();
        const env = { ...scrubEnv(process.env), ..._gitIdentityEnv(repo) };
        const [bin, binArgs] = execIsolation() === 'bwrap'
            ? ['bwrap', [...bwrapArgs(repo, env.PATH ?? '', homedir()), '--setenv', 'HOME', '/tmp', '--', 'git', ...args]]
            : ['git', args];
        let stdout = '', stderr = '', returncode = 0;
        try {
            const r = await execFileAsync(bin, binArgs, { cwd: repo, maxBuffer: 10 * 1024 * 1024, env });
            stdout = r.stdout; stderr = r.stderr;
        } catch (err: any) {
            stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
            returncode = typeof err.code === 'number' ? err.code : 1;
        }
        jsonSend(res, { stdout, stderr, returncode });
    }

    async function apiProxyGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const target = params.get('url') ?? '';
        if (!target) { proxyErr(res, 400, 'Missing url parameter'); return; }
        const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' };
        const h = params.get('h');
        if (h) {
            try {
                for (const [k, v] of Object.entries(JSON.parse(Buffer.from(h, 'base64').toString('utf-8'))))
                    if (_SAFE_GET_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length < 512) headers[k] = v;
            } catch { /* ignore malformed ?h= */ }
        }
        try {
            const s = substituteServerKeys(target, headers, undefined, keys);
            const up = await publicGet(s.url, s.headers, port, s.used);
            for (const [k, v] of Object.entries(up.headers)) {
                // publicGet passes bytes through undecoded, so Content-Encoding (if the upstream
                // ignored the identity request) must travel with them.
                if (k === 'content-encoding' && v) { res.setHeader(k, v as any); continue; }
                if (v === undefined || _SKIP_RESP_HEADERS.has(k) || k.startsWith('access-control-')) continue;
                res.setHeader(k, v as any);
            }
            res.setHeader('Content-Type', (up.headers['content-type'] as string) ?? 'text/plain');
            res.setHeader('Content-Length', up.body.length);
            res.writeHead(up.status);
            res.end(up.body);
        } catch (err: any) {
            if (err instanceof ProxyRefusal) proxyErr(res, 403, err.message);
            else proxyErr(res, 502, `Proxy error: ${err?.message ?? err}`);
        }
    }

    async function apiProxyPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let headersSent = false;
        try {
            let body: any; try { body = JSON.parse(await readBody(req)); }
            catch (e) { proxyErr(res, e instanceof BodyTooLarge ? 413 : 400, e instanceof BodyTooLarge ? 'request body too large' : 'invalid JSON body'); return; }
            const target: string = body.url ?? '';
            if (!target) { proxyErr(res, 400, 'Missing url field in body'); return; }
            const method: string = (body.method ?? 'POST').toUpperCase();
            const rawHeaders: Record<string, string> = body.headers ?? {};
            // bodyB64: binary bodies (e.g. multipart audio uploads) relayed by the page's fetch wrapper.
            const strBody: string | undefined = body.body != null
                ? (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)) : undefined;
            const s = substituteServerKeys(target, rawHeaders, strBody, keys);
            const reqBody = typeof body.bodyB64 === 'string' ? Buffer.from(body.bodyB64, 'base64') : s.body;

            const upstream = await guardedFetch(s.url, { method, headers: s.headers, body: reqBody as any }, port, s.used, fetchImpl);
            _copyRespHeaders(upstream, res);
            res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/octet-stream');
            res.writeHead(upstream.status);
            res.flushHeaders();
            headersSent = true;

            if (upstream.body) {
                const reader = upstream.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                } catch (streamErr: any) {
                    try { res.write(`data: ${JSON.stringify({ error: { message: `Stream error: ${streamErr}` } })}\n\n`); }
                    catch { /* client disconnected */ }
                }
            }
            res.end();
        } catch (err: any) {
            if (!headersSent) {
                try {
                    if (err instanceof ProxyRefusal) proxyErr(res, 403, err.message);
                    else proxyErr(res, 502, `Proxy error: ${err}`);
                } catch { /* client disconnected */ }
            } else {
                try {
                    res.write(`data: ${JSON.stringify({ error: { message: `Proxy error: ${err}` } })}\n\n`);
                    res.end();
                } catch { /* client disconnected */ }
            }
        }
    }

    // Connect-style middleware for /api/*. Anything else is passed on.
    async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) { next(); return; }
        const method = (req.method ?? 'GET').toUpperCase();
        const origin = req.headers.origin ?? '';
        if (allowedOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-FG-Token');
        res.setHeader('Access-Control-Expose-Headers', 'X-FG-Proxy-Error');
        if (method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
            res.end(); return;
        }
        if (origin && !allowedOrigins.has(origin)) { jsonErr(res, 403, 'Cross-origin request rejected'); return; }
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        if (_checkTokenThrottle(clientIp)) { jsonErr(res, 429, 'Too many failed token attempts'); return; }
        const given = req.headers['x-fg-token'];
        if (!_tokenOk(Array.isArray(given) ? given[0] : given, token)) {
            _recordTokenFailure(clientIp);
            jsonErr(res, 401, lan
                ? 'Missing or wrong FreeGent token. Open the URL printed by the dev server (it includes #fg_token=…).'
                : 'Missing or wrong FreeGent token. Reload the page.');
            return;
        }
        _tokenFailures.delete(clientIp); // clear failure count on successful auth
        const path = url.split('?')[0];
        // /api/execute and /api/git run shell commands on this machine — only the local browser
        // needs them. /api/proxy is needed by LAN devices for fetch_url (CORS bypass) and LLM calls.
        const isLoopback = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(clientIp ?? '');
        if (!isLoopback && (path === '/api/execute' || path === '/api/git')) {
            jsonErr(res, 403, 'This endpoint is only accessible from the local machine');
            return;
        }
        try {
            if (path === '/api/proxy'   && method === 'GET')  return await apiProxyGet(req, res);
            if (path === '/api/proxy'   && method === 'POST') return await apiProxyPost(req, res);
            if (path === '/api/execute' && method === 'POST') return await apiExecute(req, res);
            if (path === '/api/git'     && method === 'POST') return await apiGit(req, res);
            jsonErr(res, 404, `No such endpoint: ${method} ${path}`);
        } catch (err: any) {
            if (!res.headersSent) jsonErr(res, 500, String(err));
        }
    }

    return { middleware };
}

// ── Page script ───────────────────────────────────────────────────────────────

// Inline script injected at the top of <head> by the dev/preview server. It runs before any
// module and wraps window.fetch:
//   - same-origin /api/* requests get the X-FG-Token header;
//   - a request carrying a server-key placeholder is sent through /api/proxy, which swaps in the
//     key (only for that key's provider hosts).
// ES5 only: it must parse on every browser the app supports (see the polyfill note in index.html).
export function buildClientScript(token: string | null, keyStatus: Record<string, string>, info: { execIsolated: boolean } = { execIsolated: false }): string {
    const cfg = JSON.stringify({ token, keys: keyStatus, info }).replace(/</g, '\\u003c');
    return `(function(){
var cfg=${cfg};
window.__FG_SERVER_KEYS=cfg.keys;
window.__FG_SERVER_INFO=cfg.info;
var token=cfg.token||'';
try{
  var m=/[#&]fg_token=([A-Za-z0-9_-]+)/.exec(location.hash)||/[?&]fg_token=([A-Za-z0-9_-]+)/.exec(location.search);
  if(m){token=m[1];localStorage.setItem('fg_server_token',token);
    var q=location.search.replace(/([?&])fg_token=[^&]*&?/,'$1').replace(/[?&]$/,'');
    var hs=location.hash.replace(/([#&])fg_token=[^&]*&?/,'$1').replace(/[#&]$/,'');
    history.replaceState(null,'',location.pathname+q+hs);}
  else if(!token){token=localStorage.getItem('fg_server_token')||'';}
}catch(e){}
var PH=/__fgsk__fg_[a-z0-9_]+?__/;
var orig=window.fetch.bind(window);
function hdrs(h){var o={};if(!h)return o;
  if(typeof Headers!=='undefined'&&h instanceof Headers){h.forEach(function(v,k){o[k]=v;});}
  else if(Array.isArray(h)){for(var i=0;i<h.length;i++)o[h[i][0]]=h[i][1];}
  else{for(var k in h)if(Object.prototype.hasOwnProperty.call(h,k))o[k]=h[k];}
  return o;}
function b64(buf){var b=new Uint8Array(buf),s='',n=0x8000;
  for(var i=0;i<b.length;i+=n)s+=String.fromCharCode.apply(null,b.subarray(i,i+n));return btoa(s);}
function hasPH(u,h,body){if(PH.test(u))return true;
  for(var k in h)if(PH.test(String(h[k])))return true;
  return typeof body==='string'&&PH.test(body);}
window.fetch=function(input,init){
  try{
    var isReq=typeof Request!=='undefined'&&input instanceof Request;
    var u=new URL(isReq?input.url:String(input),location.href);
    init=init||{};
    if(u.origin===location.origin&&u.pathname.indexOf('/api/')===0){
      if(isReq){var r=new Request(input,init);if(token)r.headers.set('X-FG-Token',token);return orig(r);}
      var h0=hdrs(init.headers);if(token)h0['X-FG-Token']=token;
      return orig(input,Object.assign({},init,{headers:h0}));}
    if(isReq)return orig(input,init);
    var h=hdrs(init.headers),body=init.body;
    if(!hasPH(u.href,h,body))return orig(input,init);
    var send=function(p){var ph={'Content-Type':'application/json'};if(token)ph['X-FG-Token']=token;
      return orig(location.origin+'/api/proxy',{method:'POST',headers:ph,body:JSON.stringify(p),signal:init.signal});};
    var p={url:u.href,method:(init.method||'GET').toUpperCase(),headers:h};
    if(body==null||typeof body==='string'){if(body!=null)p.body=body;return send(p);}
    var rb=new Response(body),ct=rb.headers.get('content-type');
    return rb.arrayBuffer().then(function(buf){p.bodyB64=b64(buf);
      var has=false;for(var k in h)if(k.toLowerCase()==='content-type')has=true;
      if(ct&&!has)p.headers['Content-Type']=ct;return send(p);});
  }catch(e){return orig(input,init);}
};
})();`;
}

// Insert the page script right after <head> (used by the preview server, where Vite's
// transformIndexHtml doesn't run).
export function injectClientScript(html: string, script: string): string {
    const tag = `<script>${script}</script>`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
}

// URLs to open from other devices when the server is LAN-bound.
export function lanUrls(port: number, https: boolean): string[] {
    const proto = https ? 'https' : 'http';
    const ips = Object.values(networkInterfaces()).flat()
        .filter((i): i is NonNullable<typeof i> => !!i && !i.internal && i.family === 'IPv4')
        .map(i => i.address);
    return [`${proto}://localhost:${port}/`, ...ips.map(ip => `${proto}://${ip}:${port}/`)];
}

// ── Exec sandbox bundle ───────────────────────────────────────────────────────

// Bundle exec-sandbox/entry.ts (and the WASM shell it loads) into one classic script for the
// sandbox frame: served by the dev/preview server and emitted into dist/ by vite.config.ts.
//   - shiro/fg-filesystem's ../workspace import → exec-sandbox/workspace-rpc.ts (the page's workspace)
//   - localStorage/sessionStorage → in-memory objects, indexedDB → a stand-in that fails softly
//     (opaque origins can't use either)
//   - the Pyodide worker source is inlined; the frame starts it from a blob URL
export async function buildExecSandbox(root: string): Promise<string> {
    const esbuild = await import('esbuild');
    const workerTs = await readFile(join(root, 'pyodide-worker.ts'), 'utf-8');
    const worker = await esbuild.transform(workerTs, { loader: 'ts', target: 'es2020' });
    const workspaceShim = join(root, 'exec-sandbox', 'workspace-rpc.ts');
    const result = await esbuild.build({
        entryPoints: [join(root, 'exec-sandbox', 'entry.ts')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        write: false,
        logLevel: 'silent',
        define: {
            __PYODIDE_WORKER_SRC__: JSON.stringify(worker.code),
            'localStorage': 'globalThis.__fgMemStorage',
            'window.localStorage': 'globalThis.__fgMemStorage',
            'globalThis.localStorage': 'globalThis.__fgMemStorage',
            'sessionStorage': 'globalThis.__fgMemSession',
            'window.sessionStorage': 'globalThis.__fgMemSession',
            'indexedDB': 'globalThis.__fgNoIndexedDB',
            'window.indexedDB': 'globalThis.__fgNoIndexedDB',
        },
        plugins: [{
            name: 'fg-workspace-rpc',
            setup(b) {
                b.onResolve({ filter: /^\.\.\/workspace$/ }, args =>
                    args.importer.endsWith(join('shiro', 'fg-filesystem.ts')) ? { path: workspaceShim } : undefined);
            },
        }],
    });
    return result.outputFiles[0].text;
}
