// syntax-check.ts — does a file the agent just changed still parse? In-process checks that need no native toolchain, so the
// WebUI gets them too: there the post-write check (node --check / python compile) never ran, and an edit that left a game's
// render.js unparseable was reported "Change applied. No need to re-read the file to verify." (chat log 45cdc500, task 107: the
// page then failed to load and the task was marked done). Only formats with a strict parser are checked; CSS and HTML markup are
// lenient by design, so a check there would only raise false alarms.
//
// Returns "path:line:col: SyntaxError: message" plus the offending line, or null when the text parses or cannot be checked.

// Browser: the CDN, as for the diff library in apply_patch (a bare-specifier import makes Vite inject its client into the importer);
// Node (headless, TUI): the npm package, named through a variable so Vite leaves it alone. Offline the check is unavailable.
const ACORN_CDN = 'https://esm.sh/acorn@8.15.0';
let _acorn: Promise<any> | null = null;
function loadAcorn(): Promise<any> {
    if (!_acorn) {
        const inNode = !!(globalThis as any).process?.versions?.node;
        const spec = inNode ? 'acorn' : ACORN_CDN;
        _acorn = import(/* @vite-ignore */ spec).catch(() => { _acorn = null; return null; });
    }
    return _acorn;
}

// JSON with comments by convention: a strict parse would flag every comment.
const JSONC_RE = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|devcontainer|settings|launch|tasks|extensions)\.json$|(^|\/)\.vscode\//i;

type Loc = { line: number; column: number } | null;   // 1-based line, 0-based column

function _frame(text: string, loc: Loc): string {
    if (!loc) return '';
    const src = text.split('\n')[loc.line - 1];
    if (src === undefined) return '';
    const shown = src.length > 160 ? src.slice(Math.max(0, loc.column - 80), loc.column + 80) : src;
    const col = src.length > 160 ? Math.min(loc.column, 80) : loc.column;
    return `\n  ${shown}\n  ${' '.repeat(Math.max(0, col))}^`;
}
const _report = (path: string, loc: Loc, msg: string, text: string, where = '') =>
    `${path}${loc ? `:${loc.line}:${loc.column + 1}` : ''}: SyntaxError${where}: ${msg}${_frame(text, loc)}`;

function _locOfOffset(text: string, pos: number): Loc {
    const before = text.slice(0, Math.max(0, Math.min(pos, text.length)));
    const line = before.split('\n').length;
    return { line, column: pos - (before.lastIndexOf('\n') + 1) };
}

// JSON.parse's message carries the place in V8 ("at position 42", newer "(line 3 column 5)") and Firefox ("at line 3 column 5");
// Safari names none. The place is reported in the file's own terms, so it is cut from the message.
function _jsonError(text: string): { loc: Loc; msg: string } | null {
    try { JSON.parse(text); return null; } catch (e: any) {
        const raw = String(e?.message ?? e);
        const lc = /line (\d+) column (\d+)/i.exec(raw), pos = /position (\d+)/i.exec(raw);
        const loc: Loc = lc ? { line: +lc[1], column: +lc[2] - 1 } : pos ? _locOfOffset(text, +pos[1]) : null;
        const msg = raw.replace(/^JSON(\.parse| Parse error)?:?\s*/i, '')
            .replace(/\s*(?:in JSON\s*)?(?:at position \d+)?\s*\(?(?:at )?line \d+ column \d+(?: of the JSON data)?\)?|\s*(?:in JSON\s*)?at position \d+/gi, '').trim();
        return { loc, msg: msg || raw };
    }
}
function checkJson(path: string, text: string): string | null {
    const err = _jsonError(text);
    return err ? _report(path, err.loc, err.msg, text) : null;
}

// A parse as a module and, for anything that is not .mjs, as a classic script: the one that gets further is the file's kind
// (a script can use `with` or legacy octals, a module `import`). Returns acorn's error or null.
function _parseJs(acorn: any, text: string, kind: 'module' | 'script' | 'either'): any {
    const opts = { ecmaVersion: 'latest', allowHashBang: true, locations: false };
    const tryParse = (sourceType: 'module' | 'script') => {
        try { acorn.parse(text, { ...opts, sourceType, allowReturnOutsideFunction: sourceType === 'script' }); return null; } catch (e: any) { return e; }
    };
    if (kind !== 'either') return tryParse(kind);
    const asModule = tryParse('module');
    if (!asModule) return null;
    const asScript = tryParse('script');
    if (!asScript) return null;
    return (asScript.pos ?? 0) > (asModule.pos ?? 0) ? asScript : asModule;
}
// JSX or Flow in a .js file (a React app's components) is not JavaScript to acorn: an error at a "<" or ":" that the file's
// syntax explains is not reported.
const _looksLikeJsx = (text: string) => /<\/?[A-Za-z][\w.:-]*(\s[^<>]*)?\/?>/.test(text) && /\breturn\s*\(?\s*</.test(text);

function _jsError(acorn: any, text: string, kind: 'module' | 'script' | 'either'): { loc: Loc; msg: string } | null {
    const e = _parseJs(acorn, text, kind);
    if (!e) return null;
    if (text[e.pos] === '<' && _looksLikeJsx(text)) return null;
    return { loc: e.loc ? { line: e.loc.line, column: e.loc.column } : _locOfOffset(text, e.pos ?? 0), msg: String(e.message).replace(/\s*\(\d+:\d+\)$/, '') };
}

async function checkJs(path: string, text: string, ext: string): Promise<string | null> {
    const acorn = await loadAcorn();
    if (!acorn) return null;
    const err = _jsError(acorn, text, ext === 'mjs' ? 'module' : ext === 'cjs' ? 'script' : 'either');
    return err ? _report(path, err.loc, err.msg, text) : null;
}

// Inline <script> blocks of an HTML page, checked as what the browser runs them as; positions are given in the HTML file.
const _SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const _JSON_SCRIPT_TYPES = new Set(['importmap', 'application/json', 'application/ld+json', 'speculationrules']);
async function checkHtml(path: string, text: string): Promise<string | null> {
    let acorn: any;
    for (const m of text.matchAll(_SCRIPT_RE)) {
        const attrs = m[1], body = m[2];
        if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
        const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '').toLowerCase();
        const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
        const at = _locOfOffset(text, start);
        const tagLine = at!.line;
        const shift = (loc: Loc): Loc => loc && { line: at!.line + loc.line - 1, column: loc.line === 1 ? at!.column + loc.column : loc.column };
        if (_JSON_SCRIPT_TYPES.has(type)) {
            const err = _jsonError(body);
            if (err) return _report(path, shift(err.loc), err.msg, text, ` in <script type="${type}"> at line ${tagLine}`);
            continue;
        }
        if (type && !['module', 'text/javascript', 'application/javascript', 'javascript', 'text/ecmascript'].includes(type)) continue;   // templates, shaders, text/babel
        acorn ??= await loadAcorn();
        if (!acorn) return null;
        const err = _jsError(acorn, body, type === 'module' ? 'module' : 'script');
        if (err) return _report(path, shift(err.loc), err.msg, text, ` in the <script> at line ${tagLine}`);
    }
    return null;
}

/** The file kinds checkSyntax can judge. */
export function syntaxCheckable(path: string): boolean {
    const ext = (/\.([^./\\]+)$/.exec(path) ?? [])[1]?.toLowerCase();
    return !!ext && (['js', 'mjs', 'cjs', 'html', 'htm'].includes(ext) || (ext === 'json' && !JSONC_RE.test(path)));
}

export async function checkSyntax(path: string, text: string): Promise<string | null> {
    if (!syntaxCheckable(path) || !text.trim()) return null;   // an empty file is a placeholder, not a broken one
    const ext = (/\.([^./\\]+)$/.exec(path) ?? [])[1]!.toLowerCase();
    try {
        if (ext === 'json') return checkJson(path, text);
        if (ext === 'html' || ext === 'htm') return await checkHtml(path, text);
        return await checkJs(path, text, ext);
    } catch { return null; }   // a checker fault must never fail the write
}
