// tool-schemas.js — FreeGent: tool schema definitions and the active-tool selector
// Depends on config.js globals (enabledTools, OPT_IN_TOOLS, pyodideStatus, getSandboxProvider,
//   getAstEnabled, getGitEnabled, getHFKey) and state.js (mainAgentRole).
import { mainAgentRole } from './state.js';

const TOOLS_SPEC = [
    {
        name: 'list_files',
        description: 'List workspace files. Do not list the same path twice.',
        parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Prefix filter, e.g. "fg-tasks/" — "local/" prefix optional.' }
        }, required: [] }
    },
    {
        name: 'read_file',
        description: 'Read a file with optional 1-based line range. Prefer a range over reading whole files. "local/foo" and "foo" are the same path — avoid duplicate reads.',
        parameters: {
            type: 'object',
            properties: {
                path:       { type: 'string', description: 'Relative path from workspace root (e.g. "src/foo.py", "game.html"). Never use /workspace/ prefix — that is a bash-internal mount; strip it and use the bare name.' },
                start_line: { type: 'number', description: '1-based first line (omit for beginning).' },
                end_line:   { type: 'number', description: '1-based last line inclusive (omit for end).' }
            },
            required: ['path']
        }
    },
    {
        name: 'write_file',
        description: 'Create or overwrite a file. Write COMPLETE content — no placeholders. Prefer replace_in_file for editing existing files.',
        parameters: {
            type: 'object',
            properties: {
                path:    { type: 'string', description: 'Relative path from workspace root (e.g. "game.html", "src/main.py"). Never use /workspace/ prefix — strip it and use the bare relative path.' },
                content: { type: 'string', description: 'Full content — no placeholders.' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'replace_in_file',
        description: 'Replace exact text in a file. Include 2-3 context lines to target the right occurrence; use start_line/end_line to restrict the search region.',
        parameters: {
            type: 'object',
            properties: {
                path:       { type: 'string', description: 'Relative path from workspace root. Never use /workspace/ prefix.' },
                old_string: { type: 'string', description: 'Exact text to replace (whitespace and newlines must match).' },
                new_string: { type: 'string', description: 'Replacement text. Empty string to delete.' },
                start_line: { type: 'number' },
                end_line:   { type: 'number' }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    {
        name: 'apply_patch',
        description: 'Apply unified diff to a file. More token-efficient than write_file for multi-hunk edits. Auto-corrects @@ offset if context lines exist.',
        parameters: {
            type: 'object',
            properties: {
                path:  { type: 'string', description: 'Relative path from workspace root. Never use /workspace/ prefix.' },
                patch: { type: 'string', description: 'Unified diff (--- a/file / +++ b/file / @@ hunks). Header filenames are ignored.' }
            },
            required: ['path', 'patch']
        }
    },
    {
        name: 'delete_file',
        description: 'Permanently delete a workspace file. Use a relative path — never /workspace/ prefix.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
        }
    },
    {
        name: 'append_file',
        description: 'Append text to a file (create if absent). Good for logs and incremental files.',
        parameters: {
            type: 'object',
            properties: {
                path:    { type: 'string' },
                content: { type: 'string', description: 'Text to append. Newline auto-inserted before content.' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'update_task_status',
        description: 'Update task file status + optional log note. Call on start ("in-progress"), finish ("done"/"failed"), or when blocked. Returns blocked flag if issues remain.',
        parameters: {
            type: 'object',
            properties: {
                path:      { type: 'string', description: 'e.g. "fg-tasks/042-my-task.md"' },
                status:    { type: 'string', description: '"in-progress" | "in-review" | "done" | "blocked" | "open" | "failed"' },
                log_entry: { type: 'string', description: 'One-line note (date header added automatically).' }
            },
            required: ['path', 'status']
        }
    },
    {
        name: 'undo_write',
        description: 'Revert the most recent write_file or replace_in_file on a path, restoring previous content.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' }
            },
            required: ['path']
        }
    },

    {
        name: 'web_search',
        description: 'Search the web or a specific community source. Returns titles, URLs, and snippets.',
        parameters: {
            type: 'object',
            properties: {
                query:  { type: 'string', description: 'Search query.' },
                source: { type: 'string', enum: ['web', 'wikipedia', 'hackernews', 'github', 'stackoverflow', 'reddit', 'devto', 'gdelt', 'duckduckgo'],
                          description: 'Source to search (default: web = configured provider). wikipedia=article summaries; hackernews=community tech discussion; github=repos by stars; stackoverflow=Q&A; reddit=community; devto=developer articles; gdelt=current news; duckduckgo=instant answers.' }
            },
            required: ['query']
        }
    },
    {
        name: 'deep_research',
        description: 'Run a multi-round web research job: plans sub-questions, searches, reads sources, and synthesizes a cited report. Use for "research X", "deep dive on Y", or any question needing multiple sources — NOT for a single quick fact lookup (use web_search for that). Takes 1–3 minutes; the report is saved to research/ automatically.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The research question or topic.' }
            },
            required: ['question']
        }
    },
    {
        name: 'fetch_url',
        description: 'Make an HTTP request — GET, POST, PUT, PATCH, DELETE — with custom headers and body. JSON responses returned parsed; HTML stripped to plain text. Python requests/urllib do not work in Pyodide — use this instead. For API examples (GitHub, Slack, Notion, Linear, GraphQL) type a keyword like "github" to trigger api-calls guidance. For large web pages where you only need specific information, set "extract" to keep just the relevant passages out of your context instead of the whole page. IMPORTANT: search results may include URLs ending with " [UNAVAILABLE]" — these sites are known to block automated requests. Do NOT attempt to fetch them; skip to the next result instead.',
        parameters: {
            type: 'object',
            properties: {
                url:     { type: 'string', description: 'Full URL including https://.' },
                method:  { type: 'string', description: 'HTTP method: GET (default), POST, PUT, PATCH, DELETE.' },
                headers: { type: 'object', description: 'Request headers as key/value pairs. Common: Authorization, Content-Type, Accept, X-Api-Key.' },
                body:    { description: 'Request body. Objects are JSON-serialised automatically; Content-Type is set to application/json unless overridden.' },
                extract: { type: 'string', description: 'Optional. What you are looking for on the page. When set and the response body is large, only passages relevant to this goal are returned instead of the full page — keeps boilerplate out of your context. Omit to get the full (truncated) body.' },
            },
            required: ['url']
        }
    },
    {
        name: 'academic_search',
        description: 'Search academic literature for papers, abstracts, and citations.',
        parameters: {
            type: 'object',
            properties: {
                query:       { type: 'string', description: 'Search query. arXiv supports field prefixes: ti:, au:, abs:.' },
                source:      { type: 'string', enum: ['arxiv', 'semantic_scholar', 'crossref', 'pubmed'],
                               description: 'Source (default: arxiv). arxiv=preprints, CS/math/physics; semantic_scholar=citation counts, cross-discipline; crossref=DOI and bibliographic metadata; pubmed=biomedical peer-reviewed.' },
                max_results: { type: 'number', description: 'Max results to return (default 5).' }
            },
            required: ['query']
        }
    },
    {
        name: 'repo_map',
        description: 'Return a compact map of all code files — functions, classes, exports per file. Use to orient in an unfamiliar codebase before reading files.',
        parameters: {
            type: 'object',
            properties: {
                path_filter: { type: 'string', description: 'Substring filter, e.g. "src/" or ".js".' }
            },
            required: []
        }
    },
    {
        name: 'search_workspace',
        description: 'Search workspace files by name, contents, or both. Use before read_file to locate symbols or files.',
        parameters: {
            type: 'object',
            properties: {
                pattern:        { type: 'string',  description: 'Literal string (default, case-insensitive) or regex when is_regex=true. Use | for multi-term OR (e.g. "foo|bar").' },
                scope:          { type: 'string',  description: '"both" (default) = filenames + contents; "names" = filenames only; "contents" = contents only.' },
                is_regex:       { type: 'boolean', description: 'Treat pattern as a regex.' },
                case_sensitive: { type: 'boolean' },
                path_filter:    { type: 'string',  description: 'Restrict to files whose path contains this substring. Supports | for OR.' },
                context_lines:  { type: 'number',  description: 'Lines of context before/after each content match (default 0, max 50).' }
            },
            required: ['pattern']
        }
    },

    {
        name: 'package_search',
        description: 'Search npm or PyPI for packages. Returns name, description, version.',
        parameters: {
            type: 'object',
            properties: {
                query:    { type: 'string', description: 'Package name or keywords. npm supports keyword search; PyPI uses exact-name lookup — use the package\'s exact name.' },
                registry: { type: 'string', enum: ['npm', 'pypi'], description: 'Registry to search (default: npm).' }
            },
            required: ['query']
        }
    },
    {
        name: 'context7_docs',
        description: 'Fetch current documentation for a library from Context7. Pass the library name directly — no prior resolve step needed.',
        parameters: { type: 'object', properties: {
            library: { type: 'string', description: 'Library name, e.g. "react", "numpy", "express", "tailwindcss".' },
            topic:   { type: 'string', description: 'Optional topic focus, e.g. "hooks", "routing", "authentication".' }
        }, required: ['library'] }
    },
];

function execToolSpec() {
    const p         = getSandboxProvider();
    const hasBash   = p === 'local';
    const hasNative = typeof nativeExec === 'function';
    // Build "use X or Y instead" phrase based on which file-reading tools are enabled.
    // If neither is active, omit the "don't use bash to read" instruction entirely —
    // the model has no alternative to offer.
    const _hasRead  = enabledTools.has('read_file');
    const _hasSrch  = enabledTools.has('search_workspace');
    const _alts     = [_hasRead && 'read_file', _hasSrch && 'search_workspace'].filter(Boolean).join(' or ');
    const _noRead   = _alts ? `Do NOT use this to read or search files — use ${_alts} instead; they deduplicate and survive context compaction. ` : '';
    const _noReadBash = _alts ? `Do NOT use bash to read or search files (cat, grep) — use ${_alts} instead; they deduplicate and survive context compaction. ` : '';
    let description, languages;
    if (hasNative) {
        description = `Execute Python, Bash, or JavaScript (Node.js) in the workspace. Real filesystem — read/write files at relative paths (e.g. "src/index.js"). pip3 and npm available via bash. Use bash for shell commands, npm scripts, and running tests. ${_noRead}When writing Python or JS for an existing project, check requirements.txt or package.json before importing a library not already used there.`;
        languages   = ['python', 'bash', 'javascript'];
    } else if (hasBash) {
        description = `Execute Bash, Python, or JavaScript via the local sandbox. Workspace files are in the working directory. Files written sync back automatically. Use relative paths — do NOT use absolute paths. ${_noRead}When writing Python or JS for an existing project, check requirements.txt or package.json before importing a library not already used there.`;
        languages   = ['python', 'bash', 'javascript'];
    } else {
        const hasPyodide = pyodideStatus === 'ready' || pyodideStatus === 'loading';
        const hasWasm    = p === 'wasm';
        if (hasWasm && hasPyodide) {
            description = 'Execute Bash, Python (Pyodide), or JavaScript (browser sandbox) in-page. ' +
                `Bash: real musl-static Unix tools (grep, sed, awk, find, sort, tr, …) running via x86-64 WASM emulator; workspace at /workspace — use absolute paths. Files written under /workspace sync back automatically. ${_noReadBash}` +
                'Python: workspace files pre-loaded, writes sync back. ' +
                'JavaScript: virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages.';
            languages = ['bash', 'python', 'javascript'];
        } else if (hasWasm) {
            description = 'Execute Bash or JavaScript (browser sandbox) in-page. ' +
                'Bash: real musl-static Unix tools (grep, sed, awk, find, sort, tr, …) via x86-64 WASM emulator; workspace at /workspace — use absolute paths. Files written under /workspace sync back automatically. ' +
                'JavaScript: virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages.';
            languages = ['bash', 'javascript'];
        } else if (hasPyodide) {
            description = 'Execute Python (Pyodide) or JavaScript (browser sandbox) in-page. ' +
                'Python: files pre-loaded, writes sync back. ' +
                'JavaScript: virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages or require() of project modules.';
            languages = ['python', 'javascript'];
        } else {
            description = 'Execute JavaScript (browser sandbox) in-page. Virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages. Written files sync back to workspace automatically.';
            languages = ['javascript'];
        }
    }
    const hasBashLang = languages.includes('bash');
    const languageDesc = hasBashLang
        ? 'Language: "bash", "python", or "javascript". Always specify.'
        : `Language: one of ${languages.map(l => `"${l}"`).join(', ')}.`;
    return {
        name: 'execute_code',
        description,
        parameters: {
            type: 'object',
            properties: {
                language: { type: 'string', enum: languages, description: languageDesc },
                code:     { type: 'string', description: 'Code to execute.' }
            },
            required: ['language', 'code']
        }
    };
}

const GENERATE_IMAGE_TOOL_SPEC = {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. Uses Pollinations.ai (FLUX, no key needed) by default; falls back to HuggingFace Inference (FLUX / SDXL) if a HF key is configured. Image displayed inline and saved to workspace.',
    parameters: {
        type: 'object',
        properties: {
            prompt:          { type: 'string',  description: 'Text description of the image to generate.' },
            filename:        { type: 'string',  description: 'Output filename in the workspace (e.g. "sunset.png"). Defaults to generated_<timestamp>.png.' },
            negative_prompt: { type: 'string',  description: 'Things to exclude from the image.' },
        },
        required: ['prompt'],
    },
};

const AST_TOOL_SPEC = {
    name: 'ast_query',
    description: 'Query code structure with exact line numbers — locating definitions, call sites, and references.',
    parameters: {
        type: 'object',
        properties: {
            path:  { type: 'string', description: 'File path (e.g. "tools.js" or "local/src/app.py").' },
            query: { type: 'string', description: '"functions" | "classes" | "imports" | "exports" | "symbols" | "calls:NAME" | "references:NAME" | "symbol_at:LINE"' },
        },
        required: ['path', 'query'],
    },
};

const GIT_TOOL_SPEC = {
    name: 'run_git',
    description: 'Run a git command (status, diff, log, commit, branch, etc.) via the local sandbox.',
    parameters: {
        type: 'object',
        properties: {
            args: { type: 'array', items: { type: 'string' }, description: 'Git subcommand and flags, e.g. ["log", "--oneline", "-5"] runs `git log --oneline -5`.' },
        },
        required: ['args'],
    },
};

const WORKERS_TOOL_SPEC = {
    name: 'run_workers',
    description: 'Run independent worker agents in parallel. Each gets a workspace snapshot; writes are merged after all finish. Workers cannot see each other\'s writes.',
    parameters: {
        type: 'object',
        properties: {
            agents: {
                type: 'array',
                description: 'Workers to run in parallel. Must be an array even for a single worker: agents:[{id,task,role}].',
                items: {
                    type: 'object',
                    properties: {
                        id:    { type: 'string', description: 'Short identifier, e.g. "w1" or "search".' },
                        task:  { type: 'string', description: 'The subtask. For coder/researcher, include the paths, findings and constraints you have worked out — besides this text they see only the user\'s request.' },
                        role:  { type: 'string', enum: ['researcher', 'coder', 'director'], description: 'director: a fork of you with your full context and tools — use when the subtask depends on what you have learned. coder: reads, edits and runs code — use coder for file edits. researcher: read-only search and research. coder and researcher see the user\'s request and the task you send, not the rest of the conversation.' },
                        model: { type: 'string', description: 'Model override (format: "provider|model-id").' }
                    },
                    required: ['id', 'task', 'role']
                }
            }
        },
        required: ['agents']
    }
};

// Context7 tools are in TOOLS_SPEC and included whenever the role allows them.
// Disable per-config by adding context7_docs to disabledTools.

export function _hasBashOrCode() {
    const p = getSandboxProvider();
    const hasNative = typeof nativeExec === 'function';
    // JS eval is always available in browser (no nativeExec = not headless, not 'local' = not server-backed)
    const hasBrowserEval = typeof window !== 'undefined' && !hasNative && p !== 'local' && p !== 'none';
    return p === 'local' || p === 'wasm' || pyodideStatus === 'ready' || pyodideStatus === 'loading' || hasNative || hasBrowserEval;
}

// ignoreRole: when true, bypasses mainAgentRole.tools so the caller sees all enabledTools.
// Used by the keyword matcher which needs the full candidate pool; role ceiling is enforced
// at payload-build time by the normal activeTools() call inside callOAI.
//
// Two ceiling modes:
//   Director (forWorker=false): mainAgentRole.tools is the ceiling; toolFilterOverride is
//     ADDITIVE — extends the ceiling with specialist tools the role normally excludes.
//   Worker  (forWorker=true):  toolFilterOverride IS the ceiling (the role's tools Set).
//     Nothing is additive — workers get exactly (toolFilterOverride ∩ enabledTools ∩ conditionalGates).
//     An explicit empty-Set suppresses all tools (media routing).
export function activeTools(forWorker: boolean = false, toolFilterOverride: Set<string> | null = null, ignoreRole = false): any[] {
    const filter = toolFilterOverride;
    // Resolve ceiling and additive extensions based on call context.
    let _ceiling: Set<string> | null;
    let _additions: Set<string> | null;
    if (ignoreRole) {
        _ceiling = null; _additions = filter;                              // keyword scan: no ceiling
    } else if (forWorker) {
        _ceiling = (filter && filter.size > 0) ? filter : null;           // worker: filter IS the ceiling
        _additions = null;
    } else {
        _ceiling = (mainAgentRole?.tools) ? mainAgentRole.tools : null;   // director: role ceiling
        _additions = filter;                                               //           + additive extras
    }
    const _allows = (name: string) => {
        if (filter !== null && filter.size === 0) return false;           // explicit "no tools" override
        if (_ceiling) return _ceiling.has(name) || (_additions?.has(name) ?? false);
        return true;
    };
    const t: any[] = TOOLS_SPEC.filter(s => {
        if (!isToolActive(s.name)) return false;
        return _allows(s.name);
    });
    // Tools with extra availability conditions (beyond enabledTools) or a runtime-built spec.
    // enabledTools.has(name) is applied automatically for all — no manual list needed.
    // Add new entries here; the gating comes for free.
    const _conditionalTools: [string, () => boolean, () => any][] = [
        ['execute_code',   () => _hasBashOrCode(),                                    execToolSpec],
        ['ast_query',      () => getAstEnabled(),                                     () => AST_TOOL_SPEC],
        ['run_git',        () => getGitEnabled() && getSandboxProvider() === 'local', () => GIT_TOOL_SPEC],
        // generate_image works without credentials (Pollinations); no gating condition needed.
        ['generate_image', () => true,                                                () => GENERATE_IMAGE_TOOL_SPEC],
        // run_workers: workers may not spawn sub-workers unless their ceiling explicitly includes it.
        ['run_workers',    () => !forWorker || (_ceiling?.has('run_workers') ?? false), () => WORKERS_TOOL_SPEC],
    ];
    for (const [name, cond, spec] of _conditionalTools) {
        if (isToolActive(name) && cond() && _allows(name)) t.push(spec());
    }
    return t;
}

export function buildOAITools(forWorker: boolean | undefined = false, toolFilterOverride: Set<string> | null | undefined = null): { type: string; function: any; }[] {
    return activeTools(forWorker, toolFilterOverride).map(t => ({ type: 'function', function: t }));
}

// Window bridge for classic scripts.
Object.assign(window, { activeTools, buildOAITools, _hasBashOrCode });
