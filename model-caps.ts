// model-caps.js — per-model tool-call format registry and parsers
// Tells callOAI which tool-calling protocol a model actually implements.
//
// Formats:
//   'openai'  — standard JSON tool_calls delta (OpenAI function-calling spec)
//   'fn-tag'  — <function=name>{"arg":"val"}</function> inline in content
//   'none'    — model doesn't support tool calling; send no schema

const _TOOL_FORMATS = {
    // Mistral — Voxtral is an audio model; it hallucinates tool calls when given a schema
    'mistral/voxtral-small-latest':                          'none',
    'mistral/voxtral-mini-latest':                           'none',
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

// Returns the tool-call format for a given provider/model pair.
// Unknown NVIDIA models default to 'none' (safe — avoids hallucinated tool calls).
// All other providers default to 'openai'.
export function getModelToolFormat(provider: any, model: any): any {
    const key = `${provider}/${model}`;
    if (key in _TOOL_FORMATS) return _TOOL_FORMATS[key];
    return provider === 'nvidia' ? 'none' : 'openai';
}

// Known tool names — used by Format D to avoid matching arbitrary XML tags.
// Keep in sync with AGENT_TOOL_NAMES in step-validator.ts — that list is the canonical source.
const _FORMAT_D_TOOLS_RE = /<(list_files|read_file|write_file|replace_in_file|apply_patch|append_file|undo_write|delete_file|execute_code|search_workspace|repo_map|web_search|fetch_url|update_task_status|run_workers|run_git|ast_query|generate_image|deep_research|context7_docs|academic_search|package_search)>([\s\S]*?)<\/\1>/g;

// Known tool names for Format F attribute-style matching.
// Keep in sync with AGENT_TOOL_NAMES in step-validator.ts.
const _FORMAT_F_TOOL_NAMES = new Set([
    'list_files','read_file','write_file','replace_in_file','apply_patch','append_file',
    'undo_write','delete_file','execute_code','search_workspace','repo_map','web_search','fetch_url',
    'update_task_status','run_workers','run_git','ast_query','generate_image','deep_research',
    'context7_docs','academic_search','package_search',
]);

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
// Returns { tool_calls, cleaned } — cleaned is the text with all tool-call blocks removed.
export function parseFnTagCalls(text: any): { tool_calls: any[]; cleaned: any; } {
    const tool_calls = [];
    let cleaned = text;

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
                tool_calls.push({
                    id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                    type: 'function',
                    function: { name, arguments: argsStr }
                });
            } catch { /* malformed JSON — drop block, don't push */ }
            return '';
        }
    );

    // Format A — <tool_call><function=name><parameter=k>v</parameter>...</function></tool_call>
    cleaned = cleaned.replace(
        /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g,
        (_, name, body) => {
            const args = {};
            const paramRe = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
            let m: RegExpExecArray | null;
            while ((m = paramRe.exec(body)) !== null) {
                const val = m[2].trim();
                try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
            }
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
            });
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
        const args: Record<string, any> = {};
        const paramReA = /<parameter\s+name="(\w+)">([\s\S]*?)<\/parameter>/g;
        let m: RegExpExecArray | null;
        while ((m = paramReA.exec(body)) !== null) {
            const val = m[2].trim();
            try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
        }
        const paramReB = /<(\w+)>([\s\S]*?)<\/\1>/g;
        while ((m = paramReB.exec(body)) !== null) {
            if (m[1] === 'parameter') continue;
            const val = m[2].trim();
            try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
        }
        return args;
    };
    cleaned = cleaned.replace(
        /<(invoke|call)\s+name="(\w+)">([\s\S]*?)<\/\1>/g,
        (_, _tag, name, body) => {
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(_parseInvokeBody(body)) }
            });
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
            if (!_FORMAT_F_TOOL_NAMES.has(name)) {
                const code = args.run ?? args.command ?? args.cmd ?? args.code;
                if (!code) return full; // Unknown tool with no shell mapping — leave as-is
                resolvedName = 'execute_code';
                resolvedArgs = { language: 'bash', code: String(code) };
            }
            tool_calls.push({
                id: `call_${resolvedName}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name: resolvedName, arguments: JSON.stringify(resolvedArgs) }
            });
            return '';
        }
    );

    // Format H — Python-style: tool_name(arg1="val1", arg2="val2") on a single line
    // Matches greedily to the last ) on the line so code="cmd(a,b)" is captured whole.
    cleaned = cleaned.replace(
        new RegExp(`^(${[..._FORMAT_F_TOOL_NAMES].join('|')})\\((.*)\\)\\s*$`, 'gm'),
        (full, name, argsStr) => {
            const args: Record<string, any> = {};
            const attrRe = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            let m: RegExpExecArray | null;
            while ((m = attrRe.exec(argsStr)) !== null) {
                const val = m[2] ?? m[3] ?? '';
                try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
            }
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
            });
            return '';
        }
    );

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
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: parsedArgs }
            });
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
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: parsedArgs }
            });
            return '';
        }
    );

    // Format F — attribute XML: <tool_name arg1="v1" arg2="v2">body</tool_name> or self-closing.
    // Handles models that emit tool calls as HTML-attribute-style tags (e.g. ThinkingCap's
    // <execute_code language="bash" code="..."/>). Only matches known tool names.
    cleaned = cleaned.replace(
        /<(\w+)(\s+\w+=(?:"[^"]*"|'[^']*')(?:\s+\w+=(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g,
        (full, name, attrStr, body) => {
            if (!_FORMAT_F_TOOL_NAMES.has(name)) return full; // unknown tag — leave as-is
            const args: Record<string, any> = {};
            const attrRe = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
            let m: RegExpExecArray | null;
            while ((m = attrRe.exec(attrStr)) !== null) {
                const val = m[2] ?? m[3] ?? '';
                try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
            }
            // Body content (between open/close tags) goes into a 'code' key if not already set
            if (body?.trim() && !('code' in args)) args['code'] = body.trim();
            tool_calls.push({
                id: `call_${name}_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
            });
            return '';
        }
    );

    // Format D — DeepSeek: <tool_name><param>value</param>...</tool_name>
    // Restricted to known tool names to avoid matching arbitrary XML in responses.
    _FORMAT_D_TOOLS_RE.lastIndex = 0;
    cleaned = cleaned.replace(_FORMAT_D_TOOLS_RE, (_, name, body) => {
        const args = {};
        const paramRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
        let m: RegExpExecArray | null;
        while ((m = paramRe.exec(body)) !== null) {
            const val = m[2].trim();
            try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
        }
        tool_calls.push({
            id: `call_${name}_${Date.now()}_${tool_calls.length}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
        });
        return '';
    });

    // Format I-a — AgentBench fill-in-the-blank: <|mask_start|>cmd<|mask_end|>
    // Used by models trained on AgentBench's original masked-completion format.
    cleaned = cleaned.replace(
        /<\|mask_start\|>([\s\S]*?)<\|mask_end\|>/g,
        (_, code) => {
            tool_calls.push({
                id: `call_execute_code_${Date.now()}_${tool_calls.length}`,
                type: 'function',
                function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: code.trim() }) }
            });
            return '';
        }
    );

    // Format I-b — fenced bash/sh blocks as last resort when no tool call was recognized.
    // Models that fall back to narrating commands in code fences rather than using XML formats.
    if (!tool_calls.length) {
        cleaned = cleaned.replace(
            /```(?:bash|sh|shell)\n([\s\S]*?)\n```/g,
            (_, code) => {
                tool_calls.push({
                    id: `call_execute_code_${Date.now()}_${tool_calls.length}`,
                    type: 'function',
                    function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: code.trim() }) }
                });
                return '';
            }
        );
    }

    return { tool_calls, cleaned: cleaned.trim() };
}

// Window bridge for classic scripts.
Object.assign(window, { getModelToolFormat, parseFnTagCalls });
