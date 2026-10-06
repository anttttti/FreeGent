// shiro/utils/format.ts — C printf number formatting shared by awk and od.

/** C's %e with the given digits after the point (exponent at least two digits). */
export function fmtExp(n: number, prec: number, upper = false): string {
  let s = n.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

/** C's %g with `prec` significant digits; alt = the '#' flag (keep trailing zeros), upper = %G. */
export function fmtG(n: number, prec: number, alt = false, upper = false): string {
  if (!Number.isFinite(n)) {
    const s = Number.isNaN(n) ? 'nan' : n < 0 ? '-inf' : 'inf';
    return upper ? s.toUpperCase() : s;
  }
  if (n === 0) return alt ? (0).toFixed(Math.max(prec - 1, 0)) : Object.is(n, -0) ? '-0' : '0';
  const p = prec === 0 ? 1 : prec;
  const exp = parseInt(n.toExponential(p - 1).split('e')[1], 10);
  let s: string;
  if (exp < -4 || exp >= p) {
    s = fmtExp(n, p - 1, upper);
    if (!alt) s = s.replace(/\.?0+(e)/i, '$1');
  } else {
    s = n.toFixed(Math.max(p - 1 - exp, 0));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}
