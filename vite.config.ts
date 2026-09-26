import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import * as esbuildLib from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  loadDotenv, configDir, serverKeys, serverKeyStatus, loadOrCreateToken,
  createDevApi, buildClientScript, injectClientScript, lanUrls, buildExecSandbox, execIsolation,
} from './dev-api.js';

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

  // Keys stay in this process; the page only gets placeholders (see dev-api.ts).
  const keys = serverKeys();
  const token = loadOrCreateToken(join(configDir(), 'server-token'));
  const devApi = createDevApi({ bind: BIND, port: PORT, allowedOrigins, token, keys });
  // The token is embedded in the page HTML so any browser that loads the page can use the API
  // without a token URL. /api/execute and /api/git are loopback-only regardless, so a LAN device
  // with the token can only reach /api/proxy — an acceptable exposure on a trusted LAN.
  const isolation = execIsolation();
  const clientScript = buildClientScript(token, serverKeyStatus(keys),
    { execIsolated: isolation === 'bwrap' });

  function hmrStubAndWellKnown(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = req.url ?? '';
    // When the server is network-bound (multiple devices can connect), suppress the
    // Vite HMR client entirely. Vite's `hmr: false` config option does not actually
    // disable the WebSocket server in Vite 8 — the WS channel stays open and all
    // connected browsers share it as a broadcast bus. We replace /@vite/client with
    // an empty JS module so the browser never opens the WebSocket, achieving true
    // request-response isolation between clients.
    // Localhost is single-user by definition; HMR is preserved there.
    if (BIND !== '127.0.0.1' && url.startsWith('/@vite/client')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
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
    if (url.startsWith('/.well-known/')) { res.writeHead(204); res.end(); return; }
    next();
  }

  function printLanUrls(server: any, https: boolean) {
    if (BIND === '127.0.0.1') return;
    server.httpServer?.once('listening', () => setTimeout(() => {
      console.log('\n  FreeGent: open one of these URLs on each device:');
      for (const u of lanUrls(PORT, https)) console.log(`    ${u}`);
      console.log('');
    }, 50));
  }

  const apiPlugin = {
    name: 'fg-api',
    // Registers the /api/* middleware for `vite dev`.
    configureServer(server: any) {
      console.log(isolation === 'bwrap'
        ? '  FreeGent: local code execution is isolated with bubblewrap (no access to your home directory).'
        : '  FreeGent: local code execution is NOT isolated (bubblewrap unavailable): commands run as you and can read your files; the agent asks before each one.');
      server.middlewares.use(hmrStubAndWellKnown);
      server.middlewares.use(devApi.middleware);
      printLanUrls(server, useSsl);
    },
    // Vite calls a separate hook for `vite preview` (production) — without this,
    // /api/* requests fall through to the SPA and silently return index.html.
    // transformIndexHtml doesn't run for preview, so the page script is added here.
    configurePreviewServer(server: any) {
      server.middlewares.use(hmrStubAndWellKnown);
      server.middlewares.use(devApi.middleware);
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? '').split('?')[0];
        if (req.method !== 'GET' || (path !== base && path !== `${base}index.html`)) { next(); return; }
        let html: string;
        try { html = readFileSync(join(server.config.build.outDir, 'index.html'), 'utf-8'); }
        catch { next(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(injectClientScript(html, clientScript));
      });
      printLanUrls(server, useSsl);
    },
  };

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

  // The exec sandbox bundle (exec-sandbox/entry.ts + the WASM shell), loaded by the sandbox frame
  // from <base>fg-exec-sandbox.js. Built on first request in dev (and again after its sources
  // change); emitted as a file by `vite build`. It's public code: no token needed.
  const SANDBOX_FILE = 'fg-exec-sandbox.js';
  let sandboxCode: Promise<string> | null = null;
  const execSandboxPlugin: Plugin = {
    name: 'fg-exec-sandbox',
    configureServer(server: any) {
      const root = server.config.root;
      server.watcher.on('change', (f: string) => {
        if (/[\\/](shiro|exec-sandbox)[\\/]|pyodide-worker\.ts$/.test(f)) sandboxCode = null;
      });
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if ((req.url ?? '').split('?')[0] !== `${base}${SANDBOX_FILE}`) { next(); return; }
        (sandboxCode ??= buildExecSandbox(root)).then(code => {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(code);
        }, err => {
          sandboxCode = null;
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`exec sandbox build failed: ${err?.message ?? err}`);
        });
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: SANDBOX_FILE, source: await buildExecSandbox(process.cwd()) });
    },
  };

  // Page script (dev server only): the X-FG-Token header for /api/* and the server-key
  // placeholders. apply:'serve' keeps it out of `vite build` — built pages never carry the token
  // or anything derived from local keys.
  const clientScriptPlugin: Plugin = {
    name: 'fg-client-script',
    apply: 'serve',
    transformIndexHtml() {
      return [{ tag: 'script', children: clientScript, injectTo: 'head-prepend' as const }];
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
    plugins: [apiPlugin, clientScriptPlugin, execSandboxPlugin, safari12Plugin, ...(useSsl && !useCustomCert ? [basicSsl()] : [])],
    server: {
      port: PORT,
      // Fail instead of moving to the next free port: allowedOrigins and the proxy's
      // self-target check are built from PORT, and must describe the port actually in use.
      strictPort: true,
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
    // `vite preview` uses the same port (host, https and strictPort default to the server's), so
    // the API middleware's origin list and self-target check hold there too.
    preview: {
      port: PORT,
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
