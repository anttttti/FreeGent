// page-expect.ts — FreeGent: expected values for check_page probes.
//
// A page that loads has not been shown to do anything (uploads review 2026-10-14: ring-drain checks read
// G.state, which stayed "title" throughout; mountain checks looked for a canvas). `expect` states the value
// a probe must have at the end of the run, so the answer to "did it work" is a result, not an inference.

export interface Expectation { expr: string; equals?: unknown; matches?: string; truthy?: boolean }
export interface ExpectResult { expr: string; ok: boolean; expected: string; actual: string }

const _FALSY = new Set(['', 'false', '0', 'null', 'undefined', 'NaN', '""', "''"]);

/** Parse the tool argument: only well-formed items with a string `expr` and one condition are kept. */
export function parseExpectations(raw: unknown): Expectation[] {
    if (!Array.isArray(raw)) return [];
    const out: Expectation[] = [];
    for (const r of raw.slice(0, 10)) {
        if (!r || typeof r !== 'object' || typeof (r as any).expr !== 'string' || !(r as any).expr.trim()) continue;
        const e: Expectation = { expr: (r as any).expr };
        if ('equals' in (r as any)) e.equals = (r as any).equals;
        else if (typeof (r as any).matches === 'string') e.matches = (r as any).matches;
        else if (typeof (r as any).truthy === 'boolean') e.truthy = (r as any).truthy;
        else e.truthy = true;
        out.push(e);
    }
    return out;
}

/** Judge one probe value (the page's JSON/string rendering of the expression) against its expectation. */
export function judgeExpectation(e: Expectation, value: unknown, error?: string): ExpectResult {
    const actual = error ? `error: ${error}` : String(value ?? 'undefined');
    if (error) return { expr: e.expr, ok: false, expected: describe(e), actual };
    let ok = false;
    if ('equals' in e) {
        const want = typeof e.equals === 'string' ? e.equals : JSON.stringify(e.equals);
        // probe values arrive as the page's string form: "5", "true", "\"title\""; accept the bare string too
        ok = actual === want || actual === JSON.stringify(e.equals) || actual.replace(/^"|"$/g, '') === String(e.equals);
    } else if (e.matches !== undefined) {
        try { ok = new RegExp(e.matches).test(actual); } catch { ok = false; }
    } else {
        ok = !_FALSY.has(actual.trim()) === (e.truthy !== false);
    }
    return { expr: e.expr, ok, expected: describe(e), actual };
}
function describe(e: Expectation): string {
    if ('equals' in e) return `= ${typeof e.equals === 'string' ? e.equals : JSON.stringify(e.equals)}`;
    if (e.matches !== undefined) return `matches /${e.matches}/`;
    return e.truthy === false ? 'falsy' : 'truthy';
}

export function summarizeExpectations(results: ExpectResult[]): string {
    const failed = results.filter(r => !r.ok);
    if (!failed.length) return `${results.length}/${results.length} expectations met.`;
    return `${results.length - failed.length}/${results.length} expectations met; not met: `
        + failed.slice(0, 3).map(r => `${r.expr} expected ${r.expected}, got ${r.actual}`).join('; ');
}
