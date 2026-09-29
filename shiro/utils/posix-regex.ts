/**
 * posix-regex.ts — POSIX regular expressions (as GNU grep, sed and awk read them) → JavaScript.
 *
 *   BRE (grep, sed): \( \) \{ \} \| \+ \? are operators; ( ) { } | + ? are literal.
 *   ERE (grep -E, sed -E, awk): ( ) { } | + ? are operators; \( etc. are literal.
 *   Both: [[:alpha:]]-style classes, [] with ] first, backslash literal inside brackets,
 *   \< \> word boundaries, \w \W \s \S \b \B and back-references \1–\9.
 */

const CLASSES: Record<string, string> = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~',
  graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_',
};

const escapeLit = (c: string) => /[.*+?^${}()|[\]\\\/]/.test(c) ? '\\' + c : c;

/** A POSIX bracket expression starting at p[i] === '[' → [JS class, index after it], or null. */
function bracket(p: string, i: number): [string, number] | null {
  let j = i + 1;
  let out = '[';
  if (p[j] === '^') { out += '^'; j++; }
  if (p[j] === ']') { out += '\\]'; j++; }
  while (j < p.length && p[j] !== ']') {
    if (p[j] === '[' && p[j + 1] === ':') {
      const end = p.indexOf(':]', j + 2);
      if (end > 0) { out += CLASSES[p.slice(j + 2, end)] ?? ''; j = end + 2; continue; }
    }
    if (p[j] === '[' && (p[j + 1] === '=' || p[j + 1] === '.')) {
      const end = p.indexOf(p[j + 1] + ']', j + 2);
      if (end > 0) { out += p.slice(j + 2, end).split('').map(c => '\\' + c).join(''); j = end + 2; continue; }
    }
    const c = p[j];
    out += c === '\\' || c === '[' || c === ']' || c === '^' ? '\\' + c : c;
    j++;
  }
  if (j >= p.length) return null;
  return [out + ']', j + 1];
}

function convert(p: string, extended: boolean): string {
  let out = '';
  // Where an anchor or a leading * counts: at the start, after a group opens, after |.
  let atStart = true;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    const start = atStart;
    atStart = false;
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i];
      if (!extended && '(){}|+?'.includes(n)) {
        out += n;
        if (n === '(' || n === '|') atStart = true;
      } else if (n === '<' || n === '>') out += '\\b';
      else if (/[wWsSbB1-9]/.test(n)) out += '\\' + n;
      else if (n === '`') out += '^';
      else if (n === "'") out += '$';
      else if (n === 'n') out += '\\n';
      else if (n === 't') out += '\\t';
      else out += escapeLit(n);
      continue;
    }
    if (c === '[') {
      const b = bracket(p, i);
      if (b) { out += b[0]; i = b[1] - 1; } else out += '\\[';
      continue;
    }
    if ('(){}|+?'.includes(c)) {
      if (!extended) { out += '\\' + c; continue; }
      if (c === '{' && !/^\{\d+(,\d*)?\}/.test(p.slice(i))) { out += '\\{'; continue; }   // not an interval: literal
      if ((c === '+' || c === '?' || c === '{') && start) { out += '\\' + c; continue; }
      out += c;
      if (c === '(' || c === '|') atStart = true;
      continue;
    }
    if (c === '*') { out += start ? '\\*' : '*'; continue; }
    if (c === '^') {
      // An anchor at the start (ERE: anywhere); elsewhere in a BRE a literal ^.
      if (extended || start) { out += '^'; atStart = true; } else out += '\\^';
      continue;
    }
    if (c === '$') {
      const atEnd = i === p.length - 1 || (!extended && (p.startsWith('\\)', i + 1) || p.startsWith('\\|', i + 1)));
      out += extended || atEnd ? '$' : '\\$';
      continue;
    }
    if (c === '/') { out += '\\/'; continue; }
    out += c;
  }
  return out;
}

/** POSIX basic regular expression (grep, sed) → JavaScript regex source. */
export const breToJs = (p: string) => convert(p, false);
/** POSIX extended regular expression (grep -E, sed -E, awk) → JavaScript regex source. */
export const ereToJs = (p: string) => convert(p, true);
