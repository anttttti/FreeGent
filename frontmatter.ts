// The one place that reads and writes `---` front matter (tasks, skills, rules, QA status). Reading and writing used to be
// scattered over config.ts, tasks.ts, qa.ts, skills.ts and workers.ts, each with its own quote handling and its own regex
// (codex report 8, cases 207-209). Values go through yaml-scalar.ts both ways.
import { fmQuote, fmUnquote } from './yaml-scalar.js';

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export interface SplitFrontmatter {
    /** The block's lines, without the `---` fences. */
    lines: string[];
    /** Everything after the closing fence's line break. */
    body: string;
    /** Whether a line break followed the closing fence (kept when the block is rewritten). */
    closing: string;
}

/** Splits front matter from the body; null when the text has none. The body is returned byte for byte. */
export function splitFrontmatter(content: string): SplitFrontmatter | null {
    const m = String(content ?? '').match(FM_RE);
    if (!m) return null;
    return { lines: m[1].split(/\r?\n/), body: content.slice(m[0].length), closing: m[2] };
}

/** `key: value` lines → a map of unquoted values (a line without a colon is ignored; the last duplicate wins). */
export function parseFmLines(lines: string[]): Record<string, string> {
    const fm: Record<string, string> = {};
    for (const line of lines) {
        const col = line.indexOf(':');
        if (col === -1) continue;
        const key = line.slice(0, col).trim();
        if (key) fm[key] = fmUnquote(line.slice(col + 1));
    }
    return fm;
}

export function parseFrontmatter(content: string): Record<string, string> {
    const s = splitFrontmatter(String(content ?? ''));
    return s ? parseFmLines(s.lines) : {};
}

const _line = (k: string, v: unknown, quote: boolean) => `${k}: ${quote ? fmQuote(String(v)) : String(v)}`;

/** Sets fields in a block's lines. The first line of a key is rewritten in place, its duplicates are dropped, other lines
 *  (comments, unknown keys) stay. A key that is not there yet is added at the end, or at the top with `missing: 'top'`. */
export function setFmLines(lines: string[], fields: Record<string, unknown>, opts: { missing?: 'top' | 'end'; quote?: boolean } = {}): string[] {
    const quote = opts.quote !== false;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of lines) {
        const k = l.slice(0, Math.max(l.indexOf(':'), 0)).trim();
        if (k && k in fields) { if (!seen.has(k)) { out.push(_line(k, fields[k], quote)); seen.add(k); } }
        else out.push(l);
    }
    const added = Object.keys(fields).filter(k => !seen.has(k)).map(k => _line(k, fields[k], quote));
    return opts.missing === 'top' ? [...added, ...out] : [...out, ...added];
}

/** A new block: `---`, the fields in the given order, `---` (no trailing blank line). Undefined/null/'' values are left out. */
export function buildFrontmatter(fields: Record<string, unknown>, quote = true): string {
    const lines = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => _line(k, v, quote));
    return `---\n${lines.join('\n')}\n---\n`;
}

/** Sets fields in a document's front matter, or puts a new block in front when it has none. */
export function setFrontmatterFields(content: string, fields: Record<string, unknown>, opts: { missing?: 'top' | 'end'; quote?: boolean } = {}): string {
    const s = splitFrontmatter(content);
    if (!s) return `${buildFrontmatter(fields, opts.quote !== false)}\n${content}`;
    return `---\n${setFmLines(s.lines, fields, opts).join('\n')}\n---${s.closing ? '\n' : ''}${s.body}`;
}
