// curl / wget for the browser shell. Requests go through sandboxFetch (exec-sandbox/net.ts):
// direct first, and a plain GET the browser refuses (CORS) is retried through FreeGent's fetch
// proxy. Only the common options are supported. Output to stdout is decoded as UTF-8 text — shell
// stdout is a string — so binary downloads need -o / -O.

import type { Command, CommandContext } from './index';
import { sandboxFetch, VIA_PROXY_HEADER } from '../../exec-sandbox/net';

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  output?: string;       // file path; '-' = stdout
  remoteName: boolean;   // -O: save under the URL's file name
  fail: boolean;         // -f: exit 22 on HTTP >= 400
  includeHeaders: boolean;
  silent: boolean;
  showErrors: boolean;
  verbose: boolean;
  writeOut?: string;
}

const CURL_HELP = `Usage: curl [options] URL
  -o FILE        write the body to FILE        -O            save as the URL's file name
  -X METHOD      request method                -H 'K: V'     request header
  -d DATA        request body (POST)           --data-raw    same, no @file
  -I             HEAD request, print headers   -i            include response headers
  -f             exit 22 on HTTP errors        -s / -S       silent / show errors when silent
  -L             follow redirects (always on)  -v            show how the request was made
  -w FMT         print %{http_code} / %{content_type} after the transfer
Sites that refuse browser requests are fetched through FreeGent's proxy: plain GET only,
without custom headers.`;

function fileNameFromUrl(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'index.html'; }
  catch { return 'index.html'; }
}

async function readData(ctx: CommandContext, v: string): Promise<string> {
  if (!v.startsWith('@')) return v;
  if (v === '@-') return ctx.stdin;
  return await ctx.fs.readFile(ctx.fs.resolvePath(v.slice(1), ctx.cwd), 'utf8') as string;
}

async function run(ctx: CommandContext, name: string, req: Req): Promise<number> {
  const err = (msg: string) => { if (!req.silent || req.showErrors) ctx.stderr += `${name}: ${msg}\n`; };
  if (!/^https?:\/\//i.test(req.url)) req.url = `https://${req.url}`;
  let resp: Response;
  try {
    resp = await sandboxFetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined && { body: req.body }),
    });
  } catch (e: any) {
    const proxied = (req.method === 'GET' || req.method === 'HEAD') && req.body === undefined;
    err(proxied
      ? `(7) ${e?.message ?? e}`
      : `(7) ${req.url}: the site refused the browser request (cross-origin), and only plain GET requests can go through FreeGent's proxy`);
    return 7;
  }
  const viaProxy = resp.headers.has(VIA_PROXY_HEADER);
  if (req.verbose) {
    ctx.stderr += `* ${req.method} ${req.url}\n* ${viaProxy ? 'fetched through FreeGent\'s proxy (the site refuses browser requests)' : 'fetched directly'}\n`;
    if (viaProxy && Object.keys(req.headers).length) ctx.stderr += `* request headers were not sent (proxied requests carry none)\n`;
  }
  const headerText = () => {
    let h = `HTTP/1.1 ${resp.status} ${resp.statusText}`.trimEnd() + '\n';
    resp.headers.forEach((v, k) => { if (k.toLowerCase() !== VIA_PROXY_HEADER.toLowerCase()) h += `${k}: ${v}\n`; });
    return h + '\n';
  };
  if (req.fail && resp.status >= 400) {
    err(`(22) The requested URL returned error: ${resp.status}`);
    return 22;
  }
  const bytes = req.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await resp.arrayBuffer());
  const out = req.remoteName ? fileNameFromUrl(req.url) : req.output;
  if (req.includeHeaders || req.method === 'HEAD') ctx.stdout += headerText();
  if (out && out !== '-') {
    await ctx.fs.writeFile(ctx.fs.resolvePath(out, ctx.cwd), bytes);
    if (name === 'wget' && !req.silent) ctx.stderr += `'${out}' saved [${bytes.length}]\n`;
  } else {
    ctx.stdout += new TextDecoder().decode(bytes);
  }
  if (req.writeOut) {
    ctx.stdout += req.writeOut
      .replace(/%\{http_code\}/g, String(resp.status))
      .replace(/%\{content_type\}/g, resp.headers.get('Content-Type') ?? '')
      .replace(/%\{size_download\}/g, String(bytes.length))
      .replace(/\\n/g, '\n');
  }
  return 0;
}

export const curlCmd: Command = {
  name: 'curl',
  description: 'Transfer a URL (direct, or through FreeGent\'s proxy for plain GETs)',
  async exec(ctx) {
    const req: Req = { url: '', method: '', headers: {}, remoteName: false, fail: false,
                       includeHeaders: false, silent: false, showErrors: false, verbose: false };
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      const next = () => a[++i] ?? '';
      if (arg === '-h' || arg === '--help') { ctx.stdout = CURL_HELP + '\n'; return 0; }
      // Bundled short flags: -sSL, -fsSL, -sI …
      if (/^-[a-zA-Z]{2,}$/.test(arg) && [...arg.slice(1)].every(c => 'sSLfiIvkO'.includes(c))) {
        for (const c of arg.slice(1)) a.splice(i + 1, 0, `-${c}`);
        continue;
      }
      switch (arg) {
        case '-o': case '--output':         req.output = next(); break;
        case '-O': case '--remote-name':    req.remoteName = true; break;
        case '-X': case '--request':        req.method = next().toUpperCase(); break;
        case '-H': case '--header': {
          const h = next(); const c = h.indexOf(':');
          if (c > 0) req.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
          break;
        }
        case '-d': case '--data': case '--data-binary': case '--data-urlencode':
          req.body = (req.body ? req.body + '&' : '') + await readData(ctx, next()); break;
        case '--data-raw':                  req.body = (req.body ? req.body + '&' : '') + next(); break;
        case '--json':
          req.body = await readData(ctx, next());
          req.headers['Content-Type'] ??= 'application/json';
          req.headers['Accept'] ??= 'application/json';
          break;
        case '-I': case '--head':           req.method = 'HEAD'; break;
        case '-i': case '--include':        req.includeHeaders = true; break;
        case '-f': case '--fail':           req.fail = true; break;
        case '-s': case '--silent':         req.silent = true; break;
        case '-S': case '--show-error':     req.showErrors = true; break;
        case '-v': case '--verbose':        req.verbose = true; break;
        case '-w': case '--write-out':      req.writeOut = next(); break;
        case '-A': case '--user-agent':     req.headers['User-Agent'] = next(); break;
        case '-u': case '--user':           req.headers['Authorization'] = `Basic ${btoa(next())}`; break;
        case '-L': case '--location': case '-k': case '--insecure': case '--compressed': break;
        case '--max-time': case '-m': case '--connect-timeout': case '--retry': next(); break;
        default:
          if (arg.startsWith('-')) { ctx.stderr += `curl: option ${arg}: not supported in the browser shell (curl --help)\n`; return 2; }
          req.url = arg;
      }
    }
    if (!req.url) { ctx.stderr += 'curl: no URL specified (curl --help)\n'; return 2; }
    req.method ||= req.body !== undefined ? 'POST' : 'GET';
    return run(ctx, 'curl', req);
  },
};

export const wgetCmd: Command = {
  name: 'wget',
  description: 'Download a URL (direct, or through FreeGent\'s proxy)',
  async exec(ctx) {
    const req: Req = { url: '', method: 'GET', headers: {}, remoteName: true, fail: true,
                       includeHeaders: false, silent: false, showErrors: true, verbose: false };
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === '-O' || arg === '--output-document') { req.output = a[++i] ?? '-'; req.remoteName = false; }
      else if (arg.startsWith('-O') && arg.length > 2) { req.output = arg.slice(2); req.remoteName = false; }
      else if (arg === '-qO-' || arg === '-qO') { req.silent = true; req.output = arg === '-qO-' ? '-' : (a[++i] ?? '-'); req.remoteName = false; }
      else if (arg === '-q' || arg === '--quiet') req.silent = true;
      else if (arg === '--header') { const h = a[++i] ?? ''; const c = h.indexOf(':'); if (c > 0) req.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim(); }
      else if (arg === '--help' || arg === '-h') { ctx.stdout = 'Usage: wget [-q] [-O FILE|-] [--header "K: V"] URL\n'; return 0; }
      else if (arg.startsWith('-')) { /* ignore other flags (-c, --no-check-certificate, …) */ }
      else req.url = arg;
    }
    if (!req.url) { ctx.stderr += 'wget: missing URL\n'; return 1; }
    const code = await run(ctx, 'wget', req);
    return code === 22 ? 8 : code === 7 ? 4 : code;   // wget's exit codes: 8 server error, 4 network
  },
};
