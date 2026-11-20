/**
 * semver-utils.ts: Semantic version parsing and range resolution, with node-semver's rules:
 * - ranges are `||` alternatives, each a set of comparators that must all hold: ">=1.2.3 <2.0.0", ">= 1.2.3", "1.2.3 - 2.3.4"
 * - desugared to comparators: ^, ~, ~>, x-ranges and partial versions ("1.2", "1.x", "*")
 * - a prerelease version satisfies a set only when one of its comparators names a prerelease of the same major.minor.patch
 * - prerelease identifiers compare numerically when both are numbers, otherwise as text, and a number is lower than a text
 */

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const PART = '(0|[1-9]\\d*|[xX*])';
const VERSION_RE = new RegExp(`^[=v\\s]*${PART}(?:\\.${PART}(?:\\.${PART}(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?)?)?$`);

function parseSemVer(version: string): SemVer | null {
  const m = /^[=v\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [], raw: version.trim().replace(/^[=v\s]+/, '') };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0;   // a release is higher than any prerelease of it
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) { if (+a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1; }
    else if (an !== bn) return an ? -1 : 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.prerelease, b.prerelease);
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; v: SemVer };
const v = (major: number, minor: number, patch: number, pre: string[] = []): SemVer => ({ major, minor, patch, prerelease: pre, raw: '' });
const isX = (s?: string) => s === undefined || s === '' || /^[xX*]$/.test(s);

/** A possibly partial version: numbers for the parts given, undefined from the first wildcard or missing part on. */
function parsePartial(s: string): { major?: number; minor?: number; patch?: number; pre: string[] } | null {
  const m = VERSION_RE.exec(s.trim());
  if (!m) return null;
  const n = (x?: string) => isX(x) ? undefined : +x!;
  const major = n(m[1]), minor = major === undefined ? undefined : n(m[2]), patch = minor === undefined ? undefined : n(m[3]);
  return { major, minor, patch, pre: patch !== undefined && m[4] ? m[4].split('.') : [] };
}

/** The comparators one range term stands for (`^1.2`, `~1`, `>=1.x`, `1.2.3`, `*`), or null when it is not a term. */
function desugar(term: string): Comparator[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(term.trim());
  const op = m![1] ?? '', p = parsePartial(m![2]);
  if (!p) return null;
  const { major, minor, patch, pre } = p;
  const next = (a: number, b: number, c: number) => ({ op: '<' as const, v: v(a, b, c, ['0']) });   // "<2.0.0-0": no prerelease of 2.0.0 either
  if (major === undefined) return op === '<' || op === '>' ? [{ op: '<', v: v(0, 0, 0, ['0']) }] : [];   // * : everything (> * and < * match nothing, as in node-semver)
  const lo = v(major, minor ?? 0, patch ?? 0, pre);
  if (op === '^') {
    if (major > 0 || minor === undefined) return [{ op: '>=', v: lo }, next(major + 1, 0, 0)];
    if (minor > 0 || patch === undefined) return [{ op: '>=', v: lo }, next(0, minor + 1, 0)];
    return [{ op: '>=', v: lo }, next(0, 0, patch + 1)];
  }
  if (op[0] === '~') return [{ op: '>=', v: lo }, minor === undefined ? next(major + 1, 0, 0) : next(major, minor + 1, 0)];
  const partial = minor === undefined || patch === undefined;
  if (op === '' || op === '=') return partial ? [{ op: '>=', v: lo }, minor === undefined ? next(major + 1, 0, 0) : next(major, minor + 1, 0)] : [{ op: '=', v: lo }];
  if (op === '>') return partial ? [{ op: '>=', v: minor === undefined ? v(major + 1, 0, 0) : v(major, minor + 1, 0) }] : [{ op: '>', v: lo }];
  if (op === '<') return [{ op: '<', v: partial ? v(major, minor ?? 0, 0, ['0']) : lo }];
  if (op === '>=') return [{ op: '>=', v: lo }];
  return partial ? [minor === undefined ? next(major + 1, 0, 0) : next(major, minor + 1, 0)] : [{ op: '<=', v: lo }];   // <=
}

/** One `||` alternative: hyphen ranges, an operator separated from its version by spaces, then whitespace-separated terms. */
function parseSet(set: string): Comparator[] | null {
  set = set.trim().replace(/^(.+?)\s+-\s+(.+)$/, (_, a, b) => {
    const from = parsePartial(a), to = parsePartial(b);
    if (!from || !to) return '\u0000';
    const lower = isX(a) ? '' : `>=${[from.major, from.minor ?? 0, from.patch ?? 0].join('.')}${from.pre.length ? '-' + from.pre.join('.') : ''}`;
    const upper = to.major === undefined ? '' : to.patch === undefined ? `<${to.minor === undefined ? `${to.major + 1}.0.0` : `${to.major}.${to.minor + 1}.0`}-0` : `<=${b.trim()}`;
    return `${lower} ${upper}`;
  });
  if (set.includes('\u0000')) return null;
  const out: Comparator[] = [];
  for (const term of set.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean)) {
    const c = desugar(term);
    if (!c) return null;
    out.push(...c);
  }
  return out;
}

function holds(c: Comparator, version: SemVer): boolean {
  const cmp = compareSemVer(version, c.v);
  return c.op === '=' ? cmp === 0 : c.op === '>' ? cmp > 0 : c.op === '>=' ? cmp >= 0 : c.op === '<' ? cmp < 0 : cmp <= 0;
}

function satisfiesSet(version: SemVer, set: Comparator[]): boolean {
  if (!set.every(c => holds(c, version))) return false;
  if (!version.prerelease.length) return true;
  // A prerelease is only offered by a range that names a prerelease of the same major.minor.patch.
  return set.some(c => c.v.prerelease.length && c.v.major === version.major && c.v.minor === version.minor && c.v.patch === version.patch);
}

/** Check if a version satisfies a range specification ("latest" and "" mean any version). */
export function satisfiesRange(versionStr: string, rangeStr: string): boolean {
  rangeStr = rangeStr.trim();
  if (rangeStr === 'latest') return true;
  const version = parseSemVer(versionStr);
  if (!version) return false;
  return rangeStr.split('||').some(alt => { const set = parseSet(alt); return set !== null && satisfiesSet(version, set); });
}

/** The highest version from a list that satisfies a range. */
export function maxSatisfying(versions: string[], range: string): string | null {
  const parsed = versions.filter(x => satisfiesRange(x, range)).map(parseSemVer).filter((x): x is SemVer => x !== null);
  if (!parsed.length) return null;
  parsed.sort((a, b) => compareSemVer(b, a));
  return parsed[0].raw;
}
