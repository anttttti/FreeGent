// Front-matter scalars as the task writer emits them and as the readers take them back.
// Reader and writer used to disagree (codex report 8, cases 207-209): the readers stripped one quote character from
// either end of any value, so a literal title ending in `"` lost it; the writer left `Prepare: "Quarterly report"`
// unquoted (invalid YAML) and double-quoted a Windows path without escaping its backslashes.

// Plain scalars can't start with these, can't hold ": " or " #", and lose edge whitespace.
const _NEEDS_QUOTES = /^[\s"'\[\]{}>|*&!%@`,?#-]|[\s:]$|: |:$| #|^$|\s$/;

// Words a YAML reader turns into a boolean or null instead of text.
const _RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;

// Values a YAML reader turns into a number or a date: `2026`, `007`, `1e3`, `0x1f`, `.inf`, `2026-11-20`. Written plain, an external read, edit and write of the
// file made them numbers, and a title of 007 came back as 7 (explorations N002).
const _NUMERIC_OR_DATE = /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0[xob][0-9a-f_]+|[-+]?\.(?:inf|nan)|\d{4}-\d{1,2}-\d{1,2}(?:[Tt ].*)?)$/i;

/** `title` as a YAML value: plain when that reads back identically, otherwise double-quoted with `\\` and `\"` escaped. */
export function fmQuote(value: string): string {
    const v = String(value ?? '');
    if (!v.includes(':') && !_NEEDS_QUOTES.test(v) && !_RESERVED.test(v)) return v;
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A free-text field (a title): `fmQuote`, and quoted too when it reads as a number or a date. Not for ids, whose readers take the plain spelling. */
export function fmQuoteText(value: string): string {
    const v = String(value ?? '');
    return _NUMERIC_OR_DATE.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : fmQuote(v);
}

/** The value of a front-matter line. Quotes are removed only as a matching pair around the whole value; inside double
 *  quotes `\\` and `\"` are decoded and every other backslash stays literal (older files wrote paths like "C:\reports"). */
export function fmUnquote(raw: string): string {
    const v = String(raw ?? '').trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
    return v;
}
