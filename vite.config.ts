import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import * as esbuildLib from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, normalize, relative, sep } from 'node:path';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const execFileAsync = promisify(execFile);

// Set FG_HTTP=1 to serve plain HTTP even when --host is used (e.g. for
// iPad/Safari access where self-signed TLS is not accepted).  The trade-off
// is that getUserMedia (voice) requires HTTPS — see README for mkcert setup.
const FG_HTTP = process.env.FG_HTTP === '1';

// Port precedence: --port CLI flag → FG_PORT env → 5000. The CORS allowlist
// below is built from this value, so it must match how the server is actually
// launched (Vite doesn't expose the resolved port at config time).
function _resolvePort(): number {
    const idx = process.argv.indexOf('--port');
    const next = idx !== -1 ? process.argv[idx + 1] : undefined;
    const eqArg = process.argv.find(a => a.startsWith('--port='));
    const fromCli = next && !next.startsWith('-') ? parseInt(next, 10) : eqArg ? parseInt(eqArg.split('=')[1], 10) : NaN;
    const port = Number.isFinite(fromCli) ? fromCli : parseInt(process.env.FG_PORT ?? '5000', 10);
    return port;
}
const PORT = _resolvePort();

// Resolve bind address in priority order:
//   1. Vite's own --host [addr] CLI flag  (npm run dev -- --host)
//   2. FG_BIND env var                    (FG_BIND=0.0.0.0 npm run dev)
//   3. localhost default
function _resolveBind(): string {
    const idx = process.argv.indexOf('--host');
    if (idx !== -1) {
        const next = process.argv[idx + 1];
        // --host <addr>  →  use addr; bare --host  →  0.0.0.0
        return (next && !next.startsWith('-')) ? next : '0.0.0.0';
    }
    const eqArg = process.argv.find(a => a.startsWith('--host='));
    if (eqArg) return eqArg.split('=')[1];
    return process.env.FG_BIND ?? '127.0.0.1';
}
const BIND = _resolveBind();

// When binding to all interfaces, auto-detect LAN IPv4 addresses so the
// phone's browser can hit /api/* without CORS rejection. Covers both http
// and https schemes (basic-ssl serves https://<lan-ip>:<port>).
function _lanOrigins(port: number): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((i): i is NonNullable<typeof i> => !!i && !i.internal && i.family === 'IPv4')
        .flatMap(i => [`http://${i.address}:${port}`, `https://${i.address}:${port}`]);
}

const KEY_MAP: Array<[string, string]> = [
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
  ['NOUSPORTAL_API_KEY',  'fg_nous_key'],
  ['NOUS_API_KEY',        'fg_nous_key'],  // alias
  ['OPENAI_API_KEY',        'fg_openai_key'],
  ['TAVILY_API_KEY',        'fg_tavily_key'],
  ['HF_API_KEY',            'fg_hf_key'],
  ['HUGGINGFACE_API_KEY',   'fg_hf_key'],
  ['BRAVE_API_KEY',         'fg_brave_key'],
  ['GITHUB_TOKEN',          'fg_github_token'],
  ['STACKEXCHANGE_API_KEY', 'fg_stackexchange_key'],
];

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

function loadDotenv(): void {
  // Precedence (shell env always wins; .env files fill in gaps in order):
  //   1. <project>/.env    — project-local; gitignored; legacy/override path
  //   2. ~/.config/freegent/credentials — user-global; OUTSIDE any repo, cannot be committed
  // Keeping keys in the XDG location is the recommended approach: git add -A
  // can never reach it, so accidental commits are structurally impossible.
  _parseDotenvFile(join(process.cwd(), '.env'));
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  _parseDotenvFile(join(xdgConfig, 'freegent', 'credentials'));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
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

async function apiKeys(res: ServerResponse): Promise<void> {
  const keys: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [envVar, fgKey] of KEY_MAP) {
    if (seen.has(fgKey)) continue;
    const val = process.env[envVar] ?? '';
    if (val) { keys[fgKey] = val; seen.add(fgKey); }
  }
  jsonSend(res, keys);
}

async function apiExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let tmpDir: string | null = null;
  try {
    let body: any; try { body = JSON.parse(await readBody(req)); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON body' })); return; }
    const language: string = body.language ?? 'bash';
    const code: string = body.code ?? '';
    const files: Record<string, string> = body.files ?? {};

    tmpDir = await mkdtemp(join(tmpdir(), 'fg_'));
    for (const [relPath, content] of Object.entries(files)) {
      const safe = normalize(join(tmpDir, relPath));
      if (!safe.startsWith(tmpDir + sep)) continue;
      await mkdir(dirname(safe), { recursive: true });
      // Binary files are tagged '\x00BIN\x00<base64>' by the browser
      if (content.startsWith('\x00BIN\x00')) {
        await writeFile(safe, Buffer.from(content.slice(5), 'base64'));
      } else {
        await writeFile(safe, content, 'utf-8');
      }
    }

    let cmd: [string, string[]];
    if (language === 'bash') cmd = ['bash', ['-c', code]];
    else if (language === 'python' || language === 'python3') cmd = ['python3', ['-c', code]];
    else { jsonErr(res, 400, `Unsupported language: ${language}`); return; }

    let stdout = '', stderr = '', exitCode = 0;
    try {
      const r = await execFileAsync(cmd[0], cmd[1], {
        cwd: tmpDir, timeout: 60_000,
        env: { ...process.env, HOME: tmpDir },
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = r.stdout; stderr = r.stderr;
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT') {
        jsonSend(res, { stdout: '', stderr: 'Timeout (60s)', exit_code: 124 }); return;
      }
      stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
      exitCode = typeof err.code === 'number' ? err.code : 1;
    }

    const filesWritten: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(abs); continue; }
        const rel = relative(tmpDir!, abs);
        try {
          const rawBytes = await readFile(abs);
          // Detect binary content by checking for null bytes in the first 8KB
          const probe = rawBytes.subarray(0, 8192);
          const isBinary = probe.includes(0);
          if (isBinary) {
            const b64Tagged = '\x00BIN\x00' + rawBytes.toString('base64');
            // Include if file is new or was binary-tagged in input
            const prevTag = files[rel] ?? '';
            if (prevTag !== b64Tagged) filesWritten[rel] = b64Tagged;
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

// Git subcommands that only READ repository state. When the server is network-
// bound (BIND !== 127.0.0.1) multiple clients share one working tree, so we
// permit only these read-only commands to prevent one user's checkout/reset
// from corrupting the repo state seen by every other connected client.
// Localhost-only servers are single-user by definition; all commands are allowed.
const _GIT_READONLY = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'tag',
  'ls-files', 'ls-tree', 'cat-file', 'describe', 'rev-parse', 'rev-list',
  'blame', 'grep', 'shortlog', 'reflog', 'stash', 'worktree',
]);
// Stash and worktree have both read (list) and write (push/pop/add) sub-ops,
// so we inspect the second token too before allowing them.
const _GIT_READONLY_STASH_OPS  = new Set(['list', 'show']);
const _GIT_READONLY_WORKTREE_OPS = new Set(['list']);

async function apiGit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    let body: any; try { body = JSON.parse(await readBody(req)); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON body' })); return; }
    const args: unknown = body.args;
    if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
      jsonErr(res, 400, 'args must be a list of strings'); return;
    }

    // Network-mode guard: reject mutating git commands that would alter shared state.
    if (BIND !== '127.0.0.1') {
      const sub = args[0] ?? '';
      const sub2 = args[1] ?? 'list';  // default to 'list' for bare `git stash`
      const allowed = _GIT_READONLY.has(sub)
        && (sub !== 'stash'    || _GIT_READONLY_STASH_OPS.has(sub2))
        && (sub !== 'worktree' || _GIT_READONLY_WORKTREE_OPS.has(sub2));
      if (!allowed) {
        jsonErr(res, 403,
          `git ${sub}: mutating git commands are disabled when the server is ` +
          `network-bound (multiple clients share one working tree). ` +
          `Use a local sandbox or access via localhost.`);
        return;
      }
    }

    let stdout = '', stderr = '', returncode = 0;
    try {
      const r = await execFileAsync('git', args, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 });
      stdout = r.stdout; stderr = r.stderr;
    } catch (err: any) {
      stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
      returncode = typeof err.code === 'number' ? err.code : 1;
    }
    jsonSend(res, { stdout, stderr, returncode });
  } catch (err: any) {
    jsonErr(res, 500, String(err));
  }
}

async function apiProxyGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const qs = req.url?.split('?')[1] ?? '';
  const targetUrl = new URLSearchParams(qs).get('url') ?? '';
  if (!targetUrl) { jsonErr(res, 400, 'Missing url parameter'); return; }
  try {
    const upstream = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const contentType = upstream.headers.get('Content-Type') ?? 'text/plain';
    const data = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(data);
  } catch (err: any) {
    jsonErr(res, 502, `Proxy error: ${err}`);
  }
}

async function apiProxyPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let headersSent = false;
  try {
    let body: any; try { body = JSON.parse(await readBody(req)); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON body' })); return; }
    const targetUrl: string = body.url ?? '';
    const method: string = (body.method ?? 'POST').toUpperCase();
    const reqHeaders: Record<string, string> = body.headers ?? {};
    const reqBody: string | undefined = body.body;

    const upstream = await fetch(targetUrl, {
      method, headers: reqHeaders,
      body: reqBody != null ? (typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)) : undefined,
    });

    const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
    res.writeHead(upstream.status, { 'Content-Type': contentType });
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
        try {
          res.write(`data: ${JSON.stringify({ error: { message: `Stream error: ${streamErr}` } })}\n\n`);
        } catch { /* client disconnected */ }
      }
    }
    res.end();
  } catch (err: any) {
    if (!headersSent) {
      try { jsonErr(res, 502, `Proxy error: ${err}`); } catch { /* client disconnected */ }
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: `Proxy error: ${err}` } })}\n\n`);
        res.end();
      } catch { /* client disconnected */ }
    }
  }
}


export default defineConfig(() => {
  loadDotenv();

  const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `https://localhost:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    // Bind to all interfaces → auto-allow every local LAN IP (enables phone access)
    ...(BIND === '0.0.0.0' ? _lanOrigins(PORT) : []),
    // FG_ALLOWED_ORIGINS=http://192.168.1.50:5000,http://... for explicit overrides
    ...(process.env.FG_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  ]);

  async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = req.url ?? '';
    const method = (req.method ?? 'GET').toUpperCase();

    // When the server is network-bound (multiple devices can connect), suppress the
    // Vite HMR client entirely. Vite's `hmr: false` config option does not actually
    // disable the WebSocket server in Vite 8 — the WS channel stays open and all
    // connected browsers share it as a broadcast bus. We replace /@vite/client with
    // an empty JS module so the browser never opens the WebSocket, achieving true
    // request-response isolation between clients.
    // Localhost is single-user by definition; HMR is preserved there.
    if (BIND !== '127.0.0.1' && url.startsWith('/@vite/client')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      // Suppress the real Vite HMR client on LAN (multi-client) mode to prevent
      // cross-client error broadcasts over the shared WebSocket bus.
      // IMPORTANT: must still export every named symbol the real client exports so
      // that Vite-transformed modules that do `import { injectQuery } from '/@vite/client'`
      // don't throw a LinkError. The real client exports:
      //   createHotContext, injectQuery, updateStyle, removeStyle, ErrorOverlay
      res.end([
        '// FreeGent: Vite HMR client suppressed (multi-client LAN mode).',
        '// All named exports are stubs — no WebSocket is opened.',
        'export function createHotContext(){ return { accept(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} }; }',
        'export function injectQuery(url, q){ return url+(url.includes("?")?"&":"?")+q; }',
        'export function updateStyle(){}',
        'export function removeStyle(){}',
        'export class ErrorOverlay{ constructor(){} close(){} }',
      ].join('\n'));
      return;
    }

    if (url.startsWith('/api/')) {
      const origin = req.headers.origin ?? '';
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins.has(origin) ? origin : `http://localhost:${PORT}`);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
        res.end(); return;
      }
      if (origin && !allowedOrigins.has(origin)) {
        jsonErr(res, 403, 'Cross-origin request rejected'); return;
      }
    }

    try {
      if (url === '/api/keys' && method === 'GET')                    return await apiKeys(res);
      if (url.startsWith('/api/proxy') && method === 'GET')           return await apiProxyGet(req, res);
      if (url === '/api/execute' && method === 'POST')                return await apiExecute(req, res);
      if (url === '/api/git' && method === 'POST')                    return await apiGit(req, res);
      if (url === '/api/proxy' && method === 'POST')                  return await apiProxyPost(req, res);
      if (url.startsWith('/.well-known/')) { res.writeHead(204); res.end(); return; }
    } catch (err: any) {
      if (!res.headersSent) jsonErr(res, 500, String(err));
      return;
    }

    next();
  }

  const apiPlugin = {
    name: 'fg-api',
    // Registers the /api/* middleware for `vite dev`.
    configureServer(server: any) {
      server.middlewares.use(apiMiddleware);
    },
    // Vite calls a separate hook for `vite preview` (production) — without this,
    // /api/* requests fall through to the SPA and silently return index.html.
    configurePreviewServer(server: any) {
      server.middlewares.use(apiMiddleware);
    },
  };

  // Embed API keys directly in the served HTML as a <script id="fg-server-keys"> tag.
  // This makes the keys available synchronously — no fetch('/api/keys') round-trip needed.
  // Vite 8 dev mode uses esbuild only for TypeScript type-stripping, not for syntax
  // downleveling (esbuild.target in the main config has no effect on dev transforms).
  // This plugin re-runs esbuild with target:'safari12' after Vite's built-in transform
  // so that optional chaining (?.), nullish coalescing (??), and logical-assignment
  // operators (??=) are transpiled for iOS 12 / Safari 12 (iPad Air 1 etc.).
  const safari12Plugin: Plugin = {
    name: 'fg-safari12-compat',
    enforce: 'post',
    apply: 'serve',
    async transform(code, id) {
      // Skip virtual modules, node_modules, and non-JS/TS files.
      if (id.startsWith('\0') || id.includes('node_modules') || !/\.[jt]sx?($|\?)/.test(id)) {
        return null;
      }
      // es2019 target: ?. and ?? are ES2020, ??=/&&=/||= are ES2021 — all get
      // downleveled by esbuild. Destructuring, async/await, for-of, class, etc.
      // are ES2019 or earlier and are left alone (Safari 12 supports them all).
      // safari13/safari12 targets trigger a broken destructuring-lowering path
      // in esbuild 0.28 for standard ES6 patterns that Safari 12 supports natively.
      //
      // IMPORTANT: errors must NEVER propagate out of this handler. Vite broadcasts
      // unhandled plugin errors to ALL connected WebSocket clients (every open browser
      // tab/device), so a transform failure on one device would show an error overlay
      // on every other device connected to the same dev server. Catch and fall back to
      // the original code instead; iOS 12 may fail on that one file but other clients
      // are never disturbed.
      const _basename = id.split('/').pop()?.replace(/\?.*$/, '') ?? id;
      // Skip files that use import.meta.url — esbuild with loader:'js' replaces
      // import.meta with {} (undefined .url), breaking new Worker(new URL(..., import.meta.url)).
      if (code.includes('import.meta.url')) return null;
      try {
        const result = await esbuildLib.transform(code, {
          target: 'es2019',
          loader: 'js',
          sourcemap: 'inline',
          sourcefile: id,
        });
        return { code: result.code, map: null };
      } catch (e) {
        // Log to server console and serve untransformed — never throw.
        const _msg = (e instanceof Error) ? e.message : String(e);
        console.warn('[fg-safari12-compat] esbuild failed on', _basename, ':', _msg);
        return { code, map: null };
      }
    },
  };

  // Critical for mobile browsers that accept the page-navigation SSL warning but refuse
  // subsequent programmatic fetch() calls to a self-signed-cert origin (basicSsl is
  // only valid for localhost, not for LAN IP addresses — desktop browsers only).
  // The browser-side loadServerKeys() still fetches /api/keys as a fallback for hot-
  // reloaded keys; the DOM tag wins because it's read first and fetch() merges on top.
  const keyInjectPlugin = {
    name: 'fg-key-inject',
    transformIndexHtml(): Array<{ tag: string; attrs: Record<string, string>; children: string; injectTo: string }> {
      const keys: Record<string, string> = {};
      const seen = new Set<string>();
      for (const [envVar, fgKey] of KEY_MAP) {
        if (seen.has(fgKey)) continue;
        const val = process.env[envVar] ?? '';
        if (val) { keys[fgKey] = val; seen.add(fgKey); }
      }
      return [{
        tag: 'script',
        attrs: { id: 'fg-server-keys', type: 'application/json' },
        children: JSON.stringify(keys),
        injectTo: 'head',
      }];
    },
  };

  // TLS policy:
  //   localhost only          →  plain HTTP (no cert warning)
  //   --host, FG_HTTP=1       →  plain HTTP (Safari/mobile-safe; voice needs HTTPS)
  //   --host, FG_CERT+FG_KEY  →  proper HTTPS with user-supplied cert (mkcert recommended)
  //   --host, no FG_HTTP      →  self-signed HTTPS via basicSsl (desktop browsers only;
  //                              mobile fetch() refuses the localhost-only cert for LAN IPs)
  //
  // mkcert quick-start for mobile HTTPS:
  //   brew install mkcert && mkcert -install          # add local CA to system/browser trust
  //   mkcert 192.168.x.x localhost 127.0.0.1 ::1     # cert valid for your LAN IP
  //   FG_CERT=192.168.x.x+3.pem FG_KEY=192.168.x.x+3-key.pem npm run dev:lan
  //   # On iOS: share the rootCA.pem via AirDrop → install in Settings → trust in Settings
  const useSsl = BIND !== '127.0.0.1' && !FG_HTTP;
  const FG_CERT = process.env.FG_CERT;
  const FG_KEY  = process.env.FG_KEY;
  const useCustomCert = useSsl && !!FG_CERT && !!FG_KEY;

  // GitHub Pages deploys under /FreeGent/; the dev server runs at root.
  // VITE_BASE_URL is injected by the Actions workflow; local dev leaves it unset.
  const base = process.env.VITE_BASE_URL ?? '/';

  return {
    base,
    plugins: [apiPlugin, keyInjectPlugin, safari12Plugin, ...(useSsl && !useCustomCert ? [basicSsl()] : [])],
    server: {
      port: PORT,
      host: BIND,
      ...(useCustomCert ? {
        https: {
          cert: readFileSync(FG_CERT!),
          key: readFileSync(FG_KEY!),
        },
      } : {}),
      watch: {
        ignored: ['**/tmp/**', '**/logs/**', '**/research/**', '**/bench/**'],
      },
      // HMR isolation policy:
      //   localhost-only (BIND=127.0.0.1): single-user, developer machine — keep HMR
      //     for hot-reload, but disable the error overlay so accidental plugin errors
      //     don't pop up as intrusive banners.
      //   network-bound (--host / BIND=0.0.0.0): multiple devices may be connected.
      //     Vite's HMR channel is a single WebSocket broadcast bus — every message
      //     (update, full-reload, error) goes to ALL connected clients simultaneously.
      //     Disabling HMR removes this shared channel entirely; each client interacts
      //     with the server only via ordinary HTTP request/response, so one user's
      //     session cannot affect another's. Hot-reload is unavailable in this mode,
      //     but the developer can still open localhost in their own browser (which
      //     benefits from browser cache) and manually reload after edits.
      hmr: BIND === '127.0.0.1' ? { overlay: false } : false,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        // COOP/COEP only work on secure origins (HTTPS or localhost).
        // On plain-HTTP LAN (FG_HTTP=1) browsers log a warning and ignore them,
        // so we only send them when we know the origin is trustworthy.
        ...((BIND === '127.0.0.1' || !FG_HTTP) ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        } : {}),
      },
    },
    // Dev-mode syntax downleveling for Safari 12 is handled by the safari12Plugin above
    // (Vite 8 dev server ignores esbuild.target for transforms; plugin enforce:'post' wins).
    // build.target covers production bundles.
    esbuild: {
      target: 'safari12',
    },
    build: {
      target: 'safari12',
    },
    optimizeDeps: {
      entries: ['index.html'],
      // esbuildOptions removed: Vite 8 uses Rolldown for dep pre-bundling and
      // no longer reads this field.  Safari 12 syntax downleveling (?. / ??) for
      // all served modules — including pre-bundled deps — is handled by the
      // fg-safari12-compat plugin above (enforce:'post' transform hook).
    },
  };
});
