// model-caps.js — per-model tool-call format registry and parsers
// Tells callOAI which tool-calling protocol a model actually implements.
//
// Formats:
//   'openai'  — standard JSON tool_calls delta (OpenAI function-calling spec)
//   'fn-tag'  — <function=name>{"arg":"val"}</function> inline in content
//   'none'    — model doesn't support tool calling; send no schema
import { KEYS } from './storage-keys.js';

const _TOOL_FORMATS = {
    // NVIDIA NIM — Nemotron models: thinking-focused, no function calling
    'nvidia/nvidia/nemotron-3-super-120b-a12b':             'none',
    'nvidia/nvidia/nemotron-3-ultra-550b-a55b':             'fn-tag',
    'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': 'none',
    // NVIDIA NIM — third-party models with non-standard or no tool calling
    'nvidia/minimaxai/minimax-m2.7':                        'none',
    'nvidia/stepfun-ai/step-3.5-flash':                     'fn-tag',
    // DeepSeek outputs <tool_name><param>value</param></tool_name> (Format D)
    'nvidia/deepseek-ai/deepseek-v4-pro':                   'fn-tag',
    // GLM outputs <tool_use><tool_name>name</tool_name><arguments>{json}</arguments></tool_use> (Format C)
    'nvidia/z-ai/glm-5.1':                                  'fn-tag',
    'nvidia/z-ai/glm-5.2':                                  'fn-tag',
    // NVIDIA NIM — Mistral models use standard OpenAI function calling
    'nvidia/mistralai/mistral-large-3-675b-instruct-2512':  'openai',
    'nvidia/mistralai/mistral-medium-3.5-128b':             'openai',
    // OpenRouter — GLM-5.2:free: OR routing has no provider endpoint that supports tool_use,
    // returning HTTP 404 when tools are sent. Disable tool use; use as a text-only model.
    'openrouter/z-ai/glm-5.2:free':                         'none',
    // OpenRouter — models that output <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
    // nemotron via OpenRouter supports native OAI function calling — 'fn-tag' causes it to
    // alternate inconsistently between fn-tag and native formats within the same conversation
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free':    'openai',
};

// Formats learned at runtime for models NOT in _TOOL_FORMATS (the table always wins):
//   native tool_calls in a response      → 'openai'
//   endpoint rejects the tools schema    → 'none' (expires after _NONE_TTL_MS: providers add
//                                          tool support to models over time)
// Stored as { "<provider>/<model>": { fmt, at } }. Written by callOAI (llm-loops.ts).
const _NONE_TTL_MS = 7 * 24 * 3600_000;
function _readLearned(): Record<string, { fmt: string; at: number }> {
    try { return JSON.parse(localStorage.getItem(KEYS.TOOL_FORMATS_LEARNED) || '{}') || {}; } catch { return {}; }
}
export function isToolFormatListed(provider: any, model: any): boolean {
    return `${provider}/${model}` in _TOOL_FORMATS;
}
export function recordToolFormat(provider: any, model: any, fmt: 'openai' | 'fn-tag' | 'none'): void {
    const key = `${provider}/${model}`;
    if (key in _TOOL_FORMATS) return;
    const all = _readLearned();
    const prev = all[key];
    // An expired 'none' must be rewritten: getModelToolFormat ignores it until `at` is renewed.
    if (prev?.fmt === fmt && !(fmt === 'none' && Date.now() - prev.at > _NONE_TTL_MS)) return;
    all[key] = { fmt, at: Date.now() };
    try { localStorage.setItem(KEYS.TOOL_FORMATS_LEARNED, JSON.stringify(all)); } catch {}
}

// A 4xx that says the endpoint cannot take the tools schema for this model (vs. a malformed
// request, which must not switch tools off for good). Seen: vLLM "auto" tool choice requires
// --enable-auto-tool-choice…; OpenRouter "No endpoints found that support tool use";
// "<model> does not support tools".
const _TOOLS_REJECTED_RE = /(?:not|n't) support(?:ed)?\b.{0,40}\b(?:tools?|tool[ _-]?(?:use|calling|calls?|choice)|function[ _-]?calling)\b|\b(?:tools?|tool[ _-]?(?:use|calling|calls?|choice)|function[ _-]?calling)\b.{0,40}\bnot (?:supported|enabled|available)|enable-auto-tool-choice|tool-call-parser|no endpoints? found that supports? tool/i;
export function isToolsRejectedError(e: any): boolean {
    const s = e?.status;
    return (s === 400 || s === 404 || s === 422) && _TOOLS_REJECTED_RE.test(String(e?.message ?? ''));
}

// Returns the tool-call format for a given provider/model pair: the table, else what was
// learned for this model, else the provider default. Unknown NVIDIA models start as 'fn-tag':
// they get the schema (native calls, if the endpoint returns them, switch the model to 'openai')
// and their text calls are parsed. They used to default to 'none', which cut every new NIM model
// off from tools until someone listed it (glm5.3-flash, 2026-09-29).
export function getModelToolFormat(provider: any, model: any): any {
    const key = `${provider}/${model}`;
    if (key in _TOOL_FORMATS) return _TOOL_FORMATS[key];
    const l = _readLearned()[key];
    if (l && !(l.fmt === 'none' && Date.now() - l.at > _NONE_TTL_MS)) return l.fmt;
    return provider === 'nvidia' ? 'fn-tag' : 'openai';
}

// Built-in tool names the text formats D, F, G-b and H accept (those carry the name as the tag
// or call itself, so an unrestricted match would grab arbitrary XML/prose). Keep in sync with
// AGENT_TOOL_NAMES in step-validator.ts. The enabled MCP tools (mcp__<server>__<tool>) are
// added per call — see _knownToolNames().
const _BUILTIN_TEXT_TOOL_NAMES = [
    'list_files','read_file','write_file','replace_in_file','apply_patch','append_file',
    'undo_write','delete_file','execute_code','search_workspace','repo_map','web_search','fetch_url',
    'update_task_status','run_workers','run_git','ast_query','generate_image','deep_research',
    'context7_docs','academic_search','package_search',
];

export function _knownToolNames(): Set<string> {
    const mcp = typeof mcpToolNames === 'function' ? mcpToolNames() : [];
    return new Set([..._BUILTIN_TEXT_TOOL_NAMES, ...mcp]);
}

const _reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

// Gemma-4 native call syntax, when vLLM leaves it in the content:
//   <|tool_call>call:execute_code{code:<|"|>ls -a<|"|>,language:<|"|>bash<|"|>}<tool_call|>
// Keys are bare; strings are delimited by <|"|>; numbers, booleans, objects and arrays are bare.
// About 20 replies per run (v0.55–v0.58) arrived like this with no tool call; each ended its turn,
// and in SWE started a blind 100-step continuation (v0.58 requests-1142 was lost that way).
const _GQ = '<|"|>';
function _gemmaValue(s: string, i: number): [any, number] {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith(_GQ, i)) {
        i += _GQ.length;
        // A closing delimiter is one followed by , } ] or the end. A model sometimes drops the
        // closing delimiter before the next key (body:<|"|>{…},method:<|"|>POST<|"|>…): end the
        // string at a ",key:<|"|>" that comes first.
        let j = i;
        let close = -1;
        while ((j = s.indexOf(_GQ, j)) !== -1) {
            const after = s.slice(j + _GQ.length).trimStart();
            if (!after || /^[,}\]]/.test(after)) { close = j; break; }
            j += _GQ.length;
        }
        const nextKey = /,\s*[A-Za-z_][\w-]*:(?=<\|"\|>)/g;
        nextKey.lastIndex = i;
        const nk = nextKey.exec(s);
        if (nk && (close === -1 || nk.index < close)) return [s.slice(i, nk.index), nk.index];
        if (close === -1) return [s.slice(i), s.length];
        return [s.slice(i, close), close + _GQ.length];
    }
    if (s[i] === '{') return _gemmaObject(s, i);
    if (s[i] === '[') {
        const arr: any[] = [];
        i++;
        while (i < s.length) {
            while (i < s.length && /[\s,]/.test(s[i])) i++;
            if (s[i] === ']') return [arr, i + 1];
            const [v, n] = _gemmaValue(s, i);
            if (n <= i) break;
            arr.push(v); i = n;
        }
        return [arr, i];
    }
    const m = /^[^,}\]]*/.exec(s.slice(i))!;
    const raw = m[0].trim();
    let v: any = raw;
    try { v = JSON.parse(raw); } catch {}
    return [v, i + m[0].length];
}
function _gemmaObject(s: string, i: number): [Record<string, any>, number] {
    const obj: Record<string, any> = {};
    i++;   // '{'
    while (i < s.length) {
        while (i < s.length && /[\s,]/.test(s[i])) i++;
        if (s[i] === '}') return [obj, i + 1];
        const km = /^([A-Za-z_][\w-]*)\s*:/.exec(s.slice(i));
        if (!km) break;
        i += km[0].length;
        const [v, n] = _gemmaValue(s, i);
        obj[km[1]] = v;
        if (n <= i) break;
        i = n;
    }
    return [obj, s.length];
}

/** The index just past the JSON object that starts at s[start] === '{' (string- and escape-aware), or -1 when it never closes. */
function _jsonObjectEnd(s: string, start: number): number {
    let depth = 0, inStr = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

/** A tool-argument value as written in text: JSON when it parses, the raw string otherwise. */
// <parameter=KEY>v</parameter> and <parameter name="KEY">v</parameter> (either quote): Hermes models write both, and Format A
// read only the first, so a call in the attribute form arrived with empty arguments ("path is required"; self-analysis task P6).
const _PARAM_TAG_RE = /<parameter(?:=(["']?)(\w+)\1|\s+name=(["'])(\w+)\3)\s*>([\s\S]*?)<\/parameter>/g;
function _paramTagArgs(body: string): Record<string, any> {
    const args: Record<string, any> = {};
    for (const m of body.matchAll(_PARAM_TAG_RE)) args[m[2] ?? m[4]] = _looseJson(m[5].trim());
    return args;
}

function _looseJson(val: string): any {
    try { return JSON.parse(val); } catch { return val; }
}


/** True when the user's request says a command is to be shown, not run ("do not execute it", "documentation
 *  only", "just show me an example"). A shell fence in the reply is then the answer, not a command to rescue. */
export function userForbidsExecution(userText: unknown): boolean {
    const t = String(userText ?? '');
    return /\b(?:do\s*n['o]t|don['’]t|never|without|not\s+to|no\s+need\s+to)\s+(?:actually\s+)?(?:execut|run|launch)/i.test(t)
        || /\b(?:documentation|docs?|example|illustration|reference)[\s-]+only\b/i.test(t)
        || /\b(?:just|only)\s+(?:show|display|give|write|list|print)\b/i.test(t)
        || /\bfor\s+(?:documentation|illustration|reference|the\s+docs)\b/i.test(t);
}

// Parse tool-call XML blocks emitted by models that don't use native function calling.
// Handles eight formats:
//   Format A (Hermes/trinity): <tool_call><function=name><parameter=k>v</parameter>...</function></tool_call>
//   Format B (fn-tag):         <function=name>{"k":"v"}</function> or bare <function=name>
//   Format C (GLM):            <tool_use><tool_name>name</tool_name><arguments>{json}</arguments></tool_use>
//   Format D (DeepSeek):       <tool_name><param>value</param>...</tool_name>
//   Format E (Hermes JSON):    <tool_call>{"name":"fn","arguments":{...}}</tool_call>
//   Format F (attr XML):       <tool_name arg1="v1" arg2="v2">body</tool_name> or self-closing
//   Format G (Anthropic XML):  <invoke name="tool">...</invoke> or <call name="tool">...</call>
//   Format H (Python-style):   tool_name(arg1="v1", arg2="v2")
//   Format I (AgentBench/fenced): <|mask_start|>cmd<|mask_end|> or ```bash\ncmd\n``` (last resort)
//   Format J (GLM native):     <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
//   Format K (Gemma native):   <|tool_call>call:name{k:<|"|>v<|"|>,n:3}<tool_call|>  (wrappers optional)
// Returns { tool_calls, cleaned } — cleaned is the text with all tool-call blocks removed.
// opts.fenceRescue=false skips Format I-b (see userForbidsExecution).
export function parseFnTagCalls(text: any, opts: { fenceRescue?: boolean } = {}): { tool_calls: any[]; cleaned: any; } {
    const tool_calls = [];
    const pushCall = (name: string, args: string) => tool_calls.push({
        id: `call_${name}_${Date.now()}_${tool_calls.length}`,
        type: 'function',
        function: { name, arguments: args }
    });
    let cleaned = text;
    const _known = _knownToolNames();
    const _knownAlt = [..._known].map(_reEsc).join('|');

    // Format K — Gemma native (see _gemmaValue). Known tool names only.
    {
        const re = /(?:<\|tool_call>\s*)?call:([A-Za-z_][\w-]*)\s*(?=\{)/g;
        let m: RegExpExecArray | null;
        let out = '', last = 0;
        while ((m = re.exec(cleaned)) !== null) {
            if (!_known.has(m[1])) continue;
            const [args, end] = _gemmaObject(cleaned, m.index + m[0].length);
            let stop = end;
            const tail = /^\s*<tool_call\|>/.exec(cleaned.slice(stop));
            if (tail) stop += tail[0].length;
            pushCall(m[1], JSON.stringify(args));
            out += cleaned.slice(last, m.index);
            last = stop;
            re.lastIndex = stop;
        }
        if (last) cleaned = out + cleaned.slice(last);
    }

    // Format J — GLM native: <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>…</tool_call>
    // The last block often lacks </tool_call> (it is GLM's stop token), so a block also ends at
    // the next <tool_call> or the end of the text. The name must follow the tag directly —
    // Formats E/A start with { or <function=.
    cleaned = cleaned.replace(
        /<tool_call>[ \t]*(\w+)\s*((?:<arg_key>[\s\S]*?)?)(?:<\/tool_call>|(?=<tool_call>)|$)/g,
        (full, name, body) => {
            const args = {};
            const pairRe = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|(?=<arg_key>)|$)/g;
            let m: RegExpExecArray | null;
            while ((m = pairRe.exec(body)) !== null) {
                const val = m[2].trim();
                args[m[1]] = _looseJson(val);
            }
            pushCall(name, JSON.stringify(args));
            return '';
        }
    );

    // Format E — Hermes JSON: <tool_call>{"name":"fn","arguments":{...}}</tool_call>
    // Must run before Format A so the <tool_call> wrapper is consumed first.
    // Some models use "parameters" instead of "arguments"; both are accepted.
    cleaned = cleaned.replace(
        /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g,
        (_, jsonBody) => {
            try {
                const parsed = JSON.parse(jsonBody);
                const name = parsed.name || parsed.function;
                if (!name || typeof name !== 'string') return '';
                const argsObj = parsed.arguments ?? parsed.parameters ?? {};
                const argsStr = typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj);
                pushCall(name, argsStr);
            } catch { /* malformed JSON — drop block, don't push */ }
            return '';
        }
    );

    // Format A — <tool_call><function=name><parameter=k>v</parameter>...</function></tool_call>
    cleaned = cleaned.replace(
        /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g,
        (_, name, body) => {
            pushCall(name, JSON.stringify(_paramTagArgs(body)));
            return '';
        }
    );

    // Strip <function_calls>...</function_calls> wrapper (Anthropic's outer envelope)
    cleaned = cleaned.replace(/<function_calls>([\s\S]*?)<\/function_calls>/g, '$1');

    // Format G — Anthropic XML: <invoke name="tool">...</invoke> or <call name="tool">...</call>
    // Also handles <invoke toolname>...</invoke> (tool name in tag, without name= attribute) —
    // maps unknown shell-like tool names (e.g. <invoke rw_standard_shell>) to execute_code.
    // Handles two param styles:
    //   Anthropic-style: <parameter name="language">bash</parameter>
    //   Plain children:  <language>bash</language>
    const _parseInvokeBody = (body: string): Record<string, any> => {
        const args: Record<string, any> = _paramTagArgs(body);
        let m: RegExpExecArray | null;
        const paramReB = /<(\w+)>([\s\S]*?)<\/\1>/g;
        while ((m = paramReB.exec(body)) !== null) {
            if (m[1] === 'parameter') continue;
            const val = m[2].trim();
            args[m[1]] = _looseJson(val);
        }
        return args;
    };
    cleaned = cleaned.replace(
        /<(invoke|call)\s+name="(\w+)">([\s\S]*?)<\/\1>/g,
        (_, _tag, name, body) => {
            pushCall(name, JSON.stringify(_parseInvokeBody(body)));
            return '';
        }
    );
    // Format G-b — <invoke toolname>...</invoke> (tool name in tag, not as name= attribute).
    // Unknown tool names with a run/command/cmd/code parameter are mapped to execute_code bash.
    cleaned = cleaned.replace(
        /<(invoke|call)\s+(\w+)\s*>([\s\S]*?)<\/\1>/g,
        (full, _tag, name, body) => {
            const args = _parseInvokeBody(body);
            let resolvedName = name;
            let resolvedArgs = args;
            if (!_known.has(name)) {
                const code = args.run ?? args.command ?? args.cmd ?? args.code;
                if (!code) return full; // Unknown tool with no shell mapping — leave as-is
                resolvedName = 'execute_code';
                resolvedArgs = { language: 'bash', code: String(code) };
            }
            pushCall(resolvedName, JSON.stringify(resolvedArgs));
            return '';
        }
    );

    // Format H — Python-style: tool_name(arg1="val1", arg2="val2") on a single line
    // Matches greedily to the last ) on the line so code="cmd(a,b)" is captured whole.
    cleaned = cleaned.replace(
        new RegExp(`^(${_knownAlt})\\((.*)\\)\\s*$`, 'gm'),
        (full, name, argsStr) => {
            const args: Record<string, any> = {};
            const attrRe = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            let m: RegExpExecArray | null;
            while ((m = attrRe.exec(argsStr)) !== null) {
                const val = m[2] ?? m[3] ?? '';
                args[m[1]] = _looseJson(val);
            }
            pushCall(name, JSON.stringify(args));
            return '';
        }
    );

    // Format B′ — <function=name>{"k":"v"}</arg_value></tool_call>: the JSON body is there but the call is not closed by
    // </function> (a model mixing two dialects: v0.96.50 replace_in_file, whose body was left in the text while the call went out
    // with empty arguments). The body is taken by brace matching, then any run of stray closing tags is dropped with it.
    {
        const re = /<function=(\w+)>\s*(?=\{)/g;
        let m: RegExpExecArray | null;
        let out = '', last = 0;
        while ((m = re.exec(cleaned)) !== null) {
            const start = m.index + m[0].length;
            const end = _jsonObjectEnd(cleaned, start);
            if (end < 0) continue;
            if (/^\s*<\/function>/.test(cleaned.slice(end))) continue;   // well formed: Format B below takes it
            let body = cleaned.slice(start, end);
            try { JSON.parse(body); } catch { continue; }
            let stop = end;
            const tail = /^(?:\s*<\/(?:arg_value|parameter|arguments|tool_call|function)>)+/.exec(cleaned.slice(stop));
            if (tail) stop += tail[0].length;
            pushCall(m[1], body);
            out += cleaned.slice(last, m.index);
            last = stop;
            re.lastIndex = stop;
        }
        if (last) cleaned = out + cleaned.slice(last);
    }

    // Format B — <function=name>{"k":"v"}</function> or bare <function=name />
    cleaned = cleaned.replace(
        /<function=(\w+)>([\s\S]*?)<\/function>|<function=(\w+)\s*\/?>/g,
        (_, name1, args, name2) => {
            const name = name1 || name2;
            let parsedArgs = '{}';
            if (args && args.trim()) {
                try { JSON.parse(args.trim()); parsedArgs = args.trim(); }
                catch { parsedArgs = JSON.stringify({ input: args.trim() }); }
            }
            pushCall(name, parsedArgs);
            return '';
        }
    );

    // Format C — GLM: <tool_use>...<tool_name>name</tool_name>...<arguments>{json}</arguments>...</tool_use>
    cleaned = cleaned.replace(
        /<tool_use>[\s\S]*?<tool_name>([\w]+)<\/tool_name>[\s\S]*?<arguments>([\s\S]*?)<\/arguments>[\s\S]*?<\/tool_use>/g,
        (_, name, argsText) => {
            let parsedArgs = '{}';
            if (argsText.trim()) {
                try { JSON.parse(argsText.trim()); parsedArgs = argsText.trim(); }
                catch { parsedArgs = JSON.stringify({ input: argsText.trim() }); }
            }
            pushCall(name, parsedArgs);
            return '';
        }
    );

    // Format F — attribute XML: <tool_name arg1="v1" arg2="v2">body</tool_name> or self-closing.
    // Handles models that emit tool calls as HTML-attribute-style tags (e.g. ThinkingCap's
    // <execute_code language="bash" code="..."/>). Only matches known tool names.
    cleaned = cleaned.replace(
        /<(\w[\w-]*)(\s+\w+=(?:"[^"]*"|'[^']*')(?:\s+\w+=(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g,
        (full, name, attrStr, body) => {
            if (!_known.has(name)) return full; // unknown tag — leave as-is
            const args: Record<string, any> = {};
            const attrRe = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
            let m: RegExpExecArray | null;
            while ((m = attrRe.exec(attrStr)) !== null) {
                const val = m[2] ?? m[3] ?? '';
                args[m[1]] = _looseJson(val);
            }
            // Body content (between open/close tags) goes into a 'code' key if not already set
            if (body?.trim() && !('code' in args)) args['code'] = body.trim();
            pushCall(name, JSON.stringify(args));
            return '';
        }
    );

    // Format D — DeepSeek: <tool_name><param>value</param>...</tool_name>
    // Restricted to known tool names to avoid matching arbitrary XML in responses.
    cleaned = cleaned.replace(new RegExp(`<(${_knownAlt})>([\\s\\S]*?)<\\/\\1>`, 'g'), (_, name, body) => {
        const args = {};
        const paramRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
        let m: RegExpExecArray | null;
        while ((m = paramRe.exec(body)) !== null) {
            const val = m[2].trim();
            args[m[1]] = _looseJson(val);
        }
        pushCall(name, JSON.stringify(args));
        return '';
    });

    // Format I-a — AgentBench fill-in-the-blank: <|mask_start|>cmd<|mask_end|>
    // Used by models trained on AgentBench's original masked-completion format.
    cleaned = cleaned.replace(
        /<\|mask_start\|>([\s\S]*?)<\|mask_end\|>/g,
        (_, code) => {
            pushCall('execute_code', JSON.stringify({ language: 'bash', code: code.trim() }));
            return '';
        }
    );

    // Format I-b — fenced bash/sh blocks as last resort when no tool call was recognized.
    // Models that fall back to narrating commands in code fences rather than using XML formats.
    // Not when the reply is a document shown to the user: a ```markdown / ```md wrapper, or markdown
    // headings around the fence (a README pasted as-is). Its shell examples are content, and
    // running them is wrong. A command narrated in a fence with prose and no headings is still rescued.
    if (opts.fenceRescue !== false && !tool_calls.length && !/```(?:markdown|md|text|txt)\b/i.test(cleaned) && !/^#{1,6}[ \t]+\S/m.test(cleaned)) {
        cleaned = cleaned.replace(
            /```(?:bash|sh|shell)\n([\s\S]*?)\n```/g,
            (_, code) => {
                pushCall('execute_code', JSON.stringify({ language: 'bash', code: code.trim() }));
                return '';
            }
        );
    }

    return { tool_calls, cleaned: cleaned.trim() };
}

// Window bridge for classic scripts.
Object.assign(window, { getModelToolFormat, parseFnTagCalls, recordToolFormat, isToolFormatListed, isToolsRejectedError });
