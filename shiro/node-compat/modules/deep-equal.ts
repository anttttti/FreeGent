/** Node's assert.deepEqual (loose) and deepStrictEqual / util.isDeepStrictEqual: structure, not JSON text. */
export function deepEqual(a: any, b: any, strict: boolean, seen: [any, any][] = []): boolean {
  if (strict ? Object.is(a, b) : (a == b || (a !== a && b !== b))) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const tag = Object.prototype.toString.call(a);
  if (tag !== Object.prototype.toString.call(b)) return false;
  if (seen.some(([x, y]) => x === a && y === b)) return true;
  seen = [...seen, [a, b]];
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return String(a) === String(b) && a.lastIndex === b.lastIndex;
  if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    // A key that is an object matches a key of the other map by structure, one to one (Node's deepStrictEqual), not by identity.
    const rest = [...b];
    for (const [k, v] of a) {
      const i = b.has(k) && deepEqual(v, b.get(k), strict, seen) ? rest.findIndex(([x]) => Object.is(x, k)) : rest.findIndex(([x, y]) => deepEqual(k, x, strict, seen) && deepEqual(v, y, strict, seen));
      if (i < 0) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) { if (!b.has(v) && ![...b].some(w => deepEqual(v, w, strict, seen))) return false; }
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const x = a as any, y = b as any;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i], strict, seen)) return false;
    return true;
  }
  if (Array.isArray(a) && a.length !== b.length) return false;   // a hole is not a missing key: [] is not Array(1)
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], strict, seen)) return false; }
  return true;
}
