// Scripts that assign `location` get a per-run view of the global (AE-11): shared by the entry script (execution.ts) and the modules it requires (require.ts).
// `x.location = …` or a bare `location = …` (not ==, not a property of something else like obj.location).
const _ASSIGN = /(?:\b(?:globalThis|window|self|global)\s*\.\s*|(?:^|[^.\w$]))location\s*=(?!=)/g;
// A declaration (`const location = …`) is a local of the script, not an assignment to the global. No lookbehind: Safari before 16.4 cannot parse one.
export const _ASSIGNS_LOCATION_RE = {
  test(code: string): boolean {
    _ASSIGN.lastIndex = 0;
    for (let m; (m = _ASSIGN.exec(code)); ) {
      if (!/\b(?:const|let|var)\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index + m[0].indexOf('location')))) return true;
    }
    return false;
  },
};
// The real global with `location` replaced by a per-run value. Methods without a prototype (setTimeout, fetch, atob …) are bound to the
// real global, because a Window method called on the proxy throws "Illegal invocation"; constructors stay the same objects.
export function _scriptGlobals(): any[] {
  const real: any = globalThis;
  let loc: any = { ...(() => { try { const l = real.location; return { href: l.href, origin: l.origin, protocol: l.protocol, host: l.host, hostname: l.hostname, port: l.port, pathname: l.pathname, search: l.search, hash: l.hash }; } catch { return {}; } })(),
    reload() {}, assign() {}, replace() {}, toString() { return String(this.href ?? ''); } };
  const bound = new Map<any, any>();
  const view: any = new Proxy(real, {
    get(t, prop) {
      if (prop === 'location') return loc;
      if (prop === 'globalThis' || prop === 'window' || prop === 'self' || prop === 'global') return view;
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function' || v.prototype !== undefined) return v;
      if (!bound.has(v)) bound.set(v, v.bind(t));
      return bound.get(v);
    },
    set(t, prop, value) {
      if (prop === 'location') { loc = value; return true; }
      return Reflect.set(t, prop, value, t);
    },
  });
  return [view, view, view, view, loc];
}

