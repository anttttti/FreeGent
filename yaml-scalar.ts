// Front-matter scalars as the task writer emits them and as the readers take them back.
// Reader and writer used to disagree (codex report 8, cases 207-209): the readers stripped one quote character from
// either end of any value, so a literal title ending in `"` lost it; the writer left `Prepare: "Quarterly report"`
// unquoted (invalid YAML) and double-quoted a Windows path without escaping its backslashes.

// Plain scalars can't start with these, can't hold ": " or " #", and lose edge whitespace.
const _NEEDS_QUOTES = /^[\s"'\[\]{}>|*&!%@`,?#-]|[\s:]$|: |:$| #|^$|\s$/;

// Words a YAML reader turns into a boolean or null instead of text.
const _RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;

/** `title` as a YAML value: plain when that reads back identically, otherwise double-quoted with `\\` and `\"` escaped. */
export function fmQuote(value: string): string {
    const v = String(value ?? '');
    if (!v.includes(':') && !_NEEDS_QUOTES.test(v) && !_RESERVED.test(v)) return v;
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The value of a front-matter line. Quotes are removed only as a matching pair around the whole value; inside double
 *  quotes `\\` and `\"` are decoded and every other backslash stays literal (older files wrote paths like "C:\reports"). */
export function fmUnquote(raw: string): string {
    const v = String(raw ?? '').trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
    return v;
}
