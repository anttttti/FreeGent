export function createUrlModule(): any {
  return {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    parse: (urlStr: string) => {
      try {
        const u = new URL(urlStr);
        return {
          protocol: u.protocol,
          slashes: u.protocol.endsWith(':'),
          auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
          host: u.host,
          hostname: u.hostname,
          port: u.port || null,
          pathname: u.pathname,
          search: u.search || null,
          query: u.search ? u.search.slice(1) : null,
          hash: u.hash || null,
          path: u.pathname + (u.search || ''),
          href: u.href,
        };
      } catch { return { protocol: null, hostname: null, pathname: urlStr, path: urlStr, href: urlStr }; }
    },
    // Dispatch on the kind of input (an ordinary object also has toString, which printed "[object Object]": D033), then build from the legacy fields.
    format: (o: any) => {
      if (typeof o === 'string') return o;
      if (o instanceof URL) return o.href;
      const proto = o.protocol ? (String(o.protocol).endsWith(':') ? String(o.protocol) : o.protocol + ':') : '';
      const host = o.host || (o.hostname ? o.hostname + (o.port ? ':' + o.port : '') : '');
      let pathname = o.pathname || '';
      const slashes = o.slashes || /^(?:https?|ftp|gopher|file|wss?):$/.test(proto);
      if (slashes && host && pathname && !pathname.startsWith('/')) pathname = '/' + pathname;
      const search = o.search || (o.query && typeof o.query === 'object' ? Object.entries(o.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '');   // a string query is ignored, as in Node
      const hash = o.hash || '';
      return proto + (slashes ? '//' : '') + (o.auth ? o.auth + '@' : '') + host + pathname
        + (search && !search.startsWith('?') ? '?' : '') + search + (hash && !hash.startsWith('#') ? '#' : '') + hash;
    },
    resolve: (from: string, to: string) => new URL(to, from).href,
    // As Node on POSIX: only file: URLs, no host other than localhost, no encoded "/", and the path alone (not the query or fragment): D034.
    fileURLToPath: (url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      const fail = (Ctor: any, code: string, msg: string) => { throw Object.assign(new Ctor(msg), { code }); };
      if (u.protocol !== 'file:') fail(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
      if (u.hostname !== '') fail(TypeError, 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux');
      if (/%2f/i.test(u.pathname)) fail(TypeError, 'ERR_INVALID_FILE_URL_PATH', 'File URL path must not include encoded / characters');
      return decodeURIComponent(u.pathname);
    },
    // "#" and "?" in a file name are data, not the start of a fragment or query.
    pathToFileURL: (path: string) => new URL('file://' + encodeURI(path).replace(/[?#]/g, encodeURIComponent)),
  };
}
