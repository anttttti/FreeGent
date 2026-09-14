// tool-call-repair.ts — FreeGent: deterministic repair of malformed tool calls.
//
// Small models mangle tool calls in recurring, mechanically-fixable ways
// (deterministic tier — recovery over nudge):
//   - JSON arguments wrapped in ```json fences            → strip the fence
//   - tool NAME with embedded XML/stream artifacts        → extract the known name
//     ("<tool_call>\n<function=execute_code", "search_workspace\n<tool_call>…")
//   - execute_code code under an alias key                → move to "code"
//     ({"bash": "ls"}, {"command": …} — ~50 occurrences across v0.10 SQL/DB/bash logs)
//   - execute_code code with fence/language-token wrapper → strip, recover language
//     ("bash\ntimeout 5 mysql …" ran an interactive shell that hung to timeout)
//
// One module, one behavior: the main loop and BOTH worker branches run the same
// repairs (the P1-2 commit had hand-copied the name repair into workers.ts, and the
// alias list existed only inside executeToolAsync — this file is now the single owner;
// tools.ts consumes EXEC_CODE_ALIASES from here).
//
// Phase contract (main loop): these run BETWEEN the assistant tool_calls message
// landing in history and tool execution. They may MUTATE call arguments/names but
// must NOT append anything to history — corrective nudges belong in the post-results
// nudge block (see the 2026-07 nudge-ordering bug).
//
// Follows the step-validator/nudge-emitter/payload-builder/detectors pattern:
// ES module, exports, window bridge.

// Alias keys models use for execute_code's code/language parameters, in priority order.
// executeToolAsync applies the same lists at dispatch — keep them here only.
export const EXEC_CODE_ALIASES = [
    'code', 'script', 'program', 'source', 'text', 'content', 'command', 'bash',
    'task', 'args', 'arguments', 'argument', 'commands', 'cmd', 'shell_command',
    'tool_code', 'execution_bash', 'input', 'query',
];
export const EXEC_LANG_ALIASES = ['language', 'lang', 'type'];

const _LANG_CANON: Record<string, string> = { sh: 'bash', python3: 'python', js: 'javascript', typescript: 'javascript' };
const _META = new Set(['language', 'lang', 'type', 'description', 'name', 'run_if', 'timeout']);
const _VALID_LANGS = new Set(['bash', 'python', 'javascript', 'sql']);

// Deterministic repair of fence-wrapped JSON arguments (```json ... ```). ONLY the
// fence strip — regex fixes for python literals or trailing commas would also mutate
// matching text INSIDE string values (e.g. write_file content containing Python code),
// producing parseable-but-corrupted args. Irreparable → null; the caller nudges.
export function _repairJsonArgs(s: string): string | null {
    const t = s.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    if (t === s.trim()) return null;
    try { JSON.parse(t); return t; } catch { return null; }
}

// Malformed JSON arguments on raw OAI tool_calls: fence-wrapped args are repaired in
// place; irreparable ones execute with {} (their error is real feedback) and are
// returned so the post-results block can push the targeted nudge.
export function _repairToolCallArgs(calls: any[], repairFn: (s: string) => string | null = _repairJsonArgs): string[] {
    const bad: string[] = [];
    for (const tc of calls) {
        const s = tc.function.arguments;
        if (typeof s !== 'string' || !s.trim()) continue;
        try { JSON.parse(s); continue; } catch {}
        const fixed = repairFn(s);
        if (fixed !== null) tc.function.arguments = fixed;
        else bad.push(tc.function.name);
    }
    return bad;
}

// Normalize a tool name for fuzzy matching: lowercase + strip every non-alphanumeric
// character. This collapses case variants and punctuation differences:
//   "Execute_Code" → "executecode", "web-search" → "websearch", "WebSearch" → "websearch"
function _normName(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Semantic aliases: shortened or alternate names that remain distinct even after
// normalization (e.g. normalize("execute") = "execute" ≠ normalize("execute_code") = "executecode").
// Keys are normalized at build time so all case/punct variants of the alias key match.
// Do NOT list case variants here — normalization handles those automatically.
const _TOOL_NAME_ALIASES_RAW: Record<string, string> = {
    'execute':       'execute_code',
    'run_code':      'execute_code',
    'execute_bash':  'execute_code',
    'run_command':   'execute_code',
    'bash':          'execute_code',
    'shell':         'execute_code',
    // list_files aliases
    'list':          'list_files',
    'ls':            'list_files',
    // read_file aliases
    'read':          'read_file',
    'read file':     'read_file',
    'read_files':    'read_file',
    // search_workspace aliases
    'search':        'search_workspace',
    'grep':          'search_workspace',
};
// Pre-normalize alias keys once at module load.
const _ALIASES_NORM = new Map<string, string>(
    Object.entries(_TOOL_NAME_ALIASES_RAW).map(([k, v]) => [_normName(k), v])
);

// Tool name validation against the canonical list (step-validator's AGENT_TOOL_NAMES).
// Streaming assembly and fn-tag parsing can produce mangled names; three-pass repair:
//   1. Normalized alias lookup  — semantic abbreviations ("execute" → "execute_code")
//   2. Normalized canonical     — case/punct variants of the real name ("WebSearch" → "web_search")
//   3. Substring search         — name embedded in garbage ("<tool_call>\nexecute_code")
// Mutates normCalls in place.
export function _repairToolNames(normCalls: any[], toolNames: string[] | null = null): void {
    const names = toolNames ?? AGENT_TOOL_NAMES ?? null;
    if (!names) return;
    // Build normalized → canonical map for this call (small list, cheap).
    const normCanon = new Map<string, string>(names.map((n: string) => [_normName(n), n]));
    for (const c of normCalls) {
        if (names.includes(c.name)) continue;
        const norm = _normName(c.name);
        // 1. Semantic alias (normalized lookup)
        const aliased = _ALIASES_NORM.get(norm);
        if (aliased) { c.name = aliased; continue; }
        // 2. Normalized canonical match (handles any case/punct variant of the real name)
        const canon = normCanon.get(norm);
        if (canon) { c.name = canon; continue; }
        // 3. Known name embedded in garbage (e.g. "<tool_call>\nexecute_code")
        const found = names.find((n: string) => c.name.includes(n));
        if (found) c.name = found;
    }
}

// execute_code argument repair, in order:
//   1. alias normalization — code under "bash"/"command"/… moves to "code" (so the
//      fence/token strips below actually run on it, and emptyCode doesn't false-fire
//      on calls that dispatch would have aliased successfully anyway)
//   2. fence strip: ```lang\n…\n``` → …, recovering language from the fence tag
//   3. stray leading language token: "bash\ntimeout 5 mysql …" → strip, recover language
// Returns true when a call had NO code under any key (TerminalBench TOOL_MISUSE loops)
// so the caller's post-results block can nudge.
export function _repairExecCodeArgs(normCalls: any[]): boolean {
    let emptyCode = false;
    for (const nc of normCalls) {
        if (nc.name !== 'execute_code') continue;
        if (!nc.args || typeof nc.args !== 'object') { emptyCode = true; continue; }
        if (typeof nc.args.code !== 'string' || !nc.args.code.trim()) {
            for (const k of EXEC_CODE_ALIASES) {
                const v = nc.args[k];
                if (typeof v === 'string' && v.trim()) { nc.args.code = v; break; }
            }
        }
        // Longest-string fallback: any non-META string value longer than current best
        if (typeof nc.args.code !== 'string' || !nc.args.code.trim()) {
            let best = '';
            for (const [k, v] of Object.entries(nc.args)) {
                if (!_META.has(k) && typeof v === 'string' && v.length > best.length) best = v;
            }
            if (best) nc.args.code = best;
        }
        if (typeof nc.args.code !== 'string' || !nc.args.code.trim()) { emptyCode = true; continue; }
        let code = nc.args.code;
        const fence = code.match(/^```(\w*)[ \t]*\n([\s\S]*?)\n?```\s*$/);
        if (fence) {
            code = fence[2];
            if (fence[1] && !nc.args.language) nc.args.language = _LANG_CANON[fence[1]] ?? fence[1];
        }
        const tok = code.match(/^(bash|sh|python|python3|javascript|js|sql)[ \t]*\n(?=[\s\S])/);
        if (tok) {
            code = code.slice(tok[0].length);
            const lang = _LANG_CANON[tok[1]] ?? tok[1];
            if (!nc.args.language && lang !== 'sql') nc.args.language = lang;
        }
        nc.args.code = code;
        // Language canonicalization: strip XML-residue chars (="bash">, "python">, etc.)
        if (typeof nc.args.language === 'string') {
            const cleaned = nc.args.language.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
            const canon = _LANG_CANON[cleaned] ?? cleaned;
            if (_VALID_LANGS.has(canon)) nc.args.language = canon;
            else if (cleaned !== nc.args.language.toLowerCase()) delete nc.args.language;
        }
    }
    return emptyCode;
}

// Parse XML-format pseudo-tool-calls from plain-text assistant responses.
// Handles two formats:
//   1. JSON-body:  <tool_name>{json}</tool_name> or <tool_name>\n{json}
//      Uses brace counting to extract complete JSON so nested braces are handled correctly.
//   2. Attr-style: <tool_name attr1="val1" attr2="val2">  (HTML attribute format)
//      Some models emit attributes directly on the tag without a JSON body (T3.4).
// Returns array of {name, args} for direct execution, or null if none found.
export function _repairXmlPseudoCalls(text: string, toolNames: string[] | null): Array<{name: string; args: any}> | null {
    if (!toolNames?.length) return null;
    const nameRe = toolNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const openRe = new RegExp(`<(${nameRe})>`, 'gi');
    const results: Array<{name: string; args: any}> = [];
    let m: RegExpExecArray | null;
    // Pass 1: JSON-body format — <toolname>{...}
    while ((m = openRe.exec(text)) !== null) {
        const braceStart = text.indexOf('{', m.index + m[0].length);
        if (braceStart < 0 || braceStart - (m.index + m[0].length) > 50) continue;
        let depth = 0, i = braceStart, inStr = false, esc = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}' && --depth === 0) break;
        }
        if (depth !== 0) continue;
        try { results.push({ name: m[1].toLowerCase(), args: JSON.parse(text.slice(braceStart, i + 1)) }); } catch {}
    }
    // Pass 2: attr-style format — <toolname attr="val" ...> (no JSON body on same tag).
    // Requires at least one space after the tool name (distinguishes from JSON-body format).
    const attrTagRe = new RegExp(`<(${nameRe})\\s+([^>]*?)(?:>|$)`, 'gi');
    // Snapshot Pass 1 names so dedup only suppresses JSON-body/attr-style duplicates
    // (same invocation in two formats), not a second attr-style call of the same tool.
    const pass1Names = new Set(results.map(r => r.name));
    while ((m = attrTagRe.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        // Skip if Pass 1 already captured this tool (JSON-body wins; attr-style is a fallback).
        if (pass1Names.has(name)) continue;
        const attrStr = m[2];
        const attrs: Record<string, string> = {};
        const attrPairRe = /(\w+)="([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = attrPairRe.exec(attrStr)) !== null) attrs[am[1]] = am[2];
        if (Object.keys(attrs).length) results.push({ name, args: attrs });
    }
    return results.length ? results : null;
}

// Parse [[{...}]] or [{...}] bracket-wrapped pseudo-tool-calls from plain-text responses.
// Some models (e.g. nemotron-3-ultra-free) emit tool calls as a JSON array instead of
// native function calls. Handles double-bracket ([[…]]) and single-bracket ([{…}])
// wrappers, and tolerates a missing final bracket. Each object is expected to have:
//   { "name": "<tool_name>", "parameters"|"arguments"|"args": { … } }
// Returns array of {name, args} for direct execution, or null if no known tool calls found.
export function _repairBracketPseudoCalls(text: string, toolNames: string[] | null): Array<{name: string; args: any}> | null {
    if (!toolNames?.length) return null;
    const trimmed = text.trim();
    // Must start with [ or [[ followed (after whitespace) by a {
    if (!/^\[\[?\s*\{/.test(trimmed)) return null;

    const results: Array<{name: string; args: any}> = [];
    let i = 0;
    // Skip all opening brackets and surrounding whitespace
    while (i < trimmed.length && /[\[\s]/.test(trimmed[i])) i++;

    while (i < trimmed.length) {
        // Skip whitespace, commas, and closing brackets between objects
        while (i < trimmed.length && trimmed[i] !== '{') {
            if (trimmed[i] === '[') break; // nested array start (shouldn't happen but guard)
            i++;
        }
        if (i >= trimmed.length || trimmed[i] !== '{') break;

        // Brace counting to extract the complete object
        let depth = 0, inStr = false, esc = false;
        const start = i;
        for (; i < trimmed.length; i++) {
            const c = trimmed[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}' && --depth === 0) break;
        }
        if (depth !== 0) break; // unclosed brace — bail on remaining text

        try {
            const obj = JSON.parse(trimmed.slice(start, i + 1));
            const name = typeof obj.name === 'string' ? obj.name.toLowerCase() : '';
            if (name && toolNames.includes(name)) {
                // Accept any of these common parameter-envelope keys
                const rawArgs = obj.parameters ?? obj.arguments ?? obj.args ?? obj.input ?? {};
                results.push({ name, args: typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {} });
            }
        } catch {}
        i++;
    }

    return results.length ? results : null;
}

// Unwrap {arg_keys, arg_values} double-serialized arg envelopes emitted by some models.
// Applies to all tool calls (not just execute_code). Mutates normCalls in place.
export function _repairArgEnvelope(normCalls: any[]): void {
    for (const nc of normCalls) {
        const a = nc.args;
        if (!a || typeof a !== 'object') continue;
        if (Array.isArray(a.arg_keys) && Array.isArray(a.arg_values) && a.arg_keys.length === a.arg_values.length) {
            const rebuilt: Record<string, any> = {};
            for (let i = 0; i < a.arg_keys.length; i++) rebuilt[a.arg_keys[i]] = a.arg_values[i];
            nc.args = rebuilt;
        }
    }
}

/**
 * One-shot repair pass for a batch of OAI tool_calls.
 *   raw = the tool_calls array from the model response (.function.arguments are strings)
 *
 * Steps (in order — ordering is load-bearing):
 *   1. _repairToolCallArgs  — fix fence-wrapped / malformed JSON argument strings in raw
 *   2. normalize            — JSON.parse the now-repaired argument strings into {name, args}
 *   3. _repairToolNames     — extract valid tool name from embedded XML artifacts
 *   4. _repairArgEnvelope   — unwrap arg_keys/arg_values double-serialization
 *   5. _repairExecCodeArgs  — execute_code alias resolution, fence stripping, lang canon
 *
 * Returns { bad, norm }:
 *   bad  — tool names whose JSON args were irreparable (for nudging); empty if all fixed
 *   norm — the normalized {name, args} array after all repairs
 *
 * Workers can ignore bad; the main loop uses it to emit a targeted bad-args nudge.
 */
export function repairAllToolCalls(raw: any[]): { bad: string[]; norm: { name: string; args: any }[]; hasEmptyCode: boolean } {
    const bad = _repairToolCallArgs(raw);                    // step 1: repair raw strings
    const norm = raw.map(tc => {                             // step 2: normalize (post-repair)
        try { return { name: tc.function.name, args: JSON.parse(tc.function.arguments) }; }
        catch { return { name: tc.function.name, args: {} }; }
    });
    _repairToolNames(norm);                                  // step 3
    _repairArgEnvelope(norm);                                // step 4
    const hasEmptyCode = _repairExecCodeArgs(norm);          // step 5
    return { bad, norm, hasEmptyCode };
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    EXEC_CODE_ALIASES, EXEC_LANG_ALIASES,
    _repairJsonArgs, _repairToolCallArgs, _repairToolNames, _repairExecCodeArgs,
    _repairXmlPseudoCalls, _repairBracketPseudoCalls, _repairArgEnvelope,
    repairAllToolCalls,
});
