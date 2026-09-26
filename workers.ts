// workers.js — FreeGent: 3-way diff/merge + parallel worker agent system
// Depends on: config.js, tools.js, llm-shared.js, state.js.
// Note: workers.js defines setMainAgentRole(name) that takes a role-NAME string and
// resolves it through rolesRegistry — this overrides state.js's same-named setter on window.
// The state module's object-setter is imported under an alias for the direct-assignment sites.
import { setMainAgentRole as _setRoleObj, activePlaceholder, softStopPending, activeChatId } from './state.js';
import type { ForkBase } from './llm-loops.js';
import { NULL_TASK_HANDLE } from './render-adapter.js';
import { _fpTrunc, _updateStuckDetector, _checkTextResponse, _updateEnvFailureDetector, newRepeatGuard, _callSig, _resultSig, _repeatRefused, _updateRepeatGuard, _repeatRefusalResult, REPEAT_REFUSALS_BEFORE_STOP } from './detectors.js';
import { validateOutput } from './step-validator.js';
import { emitNudge } from './nudge-emitter.js';
import { sleepInterruptible, withRetry, _makeOAIRetryHandler } from './retry.js';
import { getCooldownRemaining, oaiEndpoint, recordSuccess, specToEndpoint, modelFriendlyName, resolveWorkerModelSpec } from './model-router.js';
import { _normPath, truncateResultForHistory } from './history.js';
import { parseArgs, isRealUserMessage, stripInjected } from './history-util.js';
import { repairAllToolCalls } from './tool-call-repair.js';
import { buildSystemPrompt, _buildWorkspaceDesc, _buildEnvContext } from './system-prompt.js';
import { isCustomEndpoint, buildChatPayload } from './payload-builder.js';
import { splitLines, diffRegions, tryMerge } from './diff-utils.js';
import { getProvider, getTemperature, getAgentConcisePrompts, getAgentLeanWorkers, getAgentWorkerHistory, getAgentWorkerReduce, getEndpointRotation, ls, enabledTools, ALL_TOOL_NAMES, skillsRegistry, isRoleEnabled, getRoleBody, getRoleBodyFn, getLocalApiProxy } from './config.js';
import { KEYS, chatKey } from './storage-keys.js';
import { toolLabel } from './tools.js';
import { agentReadFile, agentWriteFile, agentDeleteFile, agentListFiles, renderFileList } from './workspace.js';
import { sessionSetChatRole, sessionCreateWorkerRun, sessionFinishWorkerRun, sessionRecordWorkerAgent } from './session-store.js';
import { convoLogTurn } from './convo-log.js';
import { registry } from './session-registry.js';



const WORKER_STATUS_FOOTER = `
At the end of your response, always output a status line:
STATUS: complete
or
STATUS: blocked — <one sentence reason>
or
STATUS: partial — <what was done / what remains>
`;

const _roleConciseBlock = getAgentConcisePrompts()
    ? '\n\n## Conciseness\nComplete with one sentence stating the outcome and nothing else, then COMPLETED. No Goal/Approach/Changes/Outcome blocks, no recap of what code already printed, no preamble before tool calls. The work speaks for itself.\nRespond in compressed, telegraphic style — facts, findings, file paths, decisions. No preamble, no summary wrap-up, no pleasantries.\n'
    : '';

// Tools added to the director's headless ceiling by fg-run --enable-tools (e.g. fetch_url for a
// benchmark whose task API is HTTP). Tool availability only — fetch_url's reach is governed
// separately by --fetch-allow.
const _directorHeadlessExtras = new Set<string>();
export function setDirectorHeadlessTools(names: string[]): void {
    _directorHeadlessExtras.clear();
    for (const n of names) _directorHeadlessExtras.add(n);
}

const BUILTIN_ROLES = [
    {
        name: 'researcher',
        description: 'Research specialist: gathers information from the web, academic sources, and the workspace. Uses deep_research for multi-source questions. Read-only.',
        tier: 'execution',
        tools: new Set([
            'list_files', 'read_file', 'search_workspace',
            'web_search', 'fetch_url', 'deep_research', 'academic_search',
            'execute_code', 'repo_map', 'ast_query',
        ]),
        body_fn(): string {
            const _has = (t: string) => enabledTools.has(t);
            const hasDeep     = _has('deep_research');
            const hasWeb      = _has('web_search');
            const hasFetch    = _has('fetch_url');
            const hasAcademic = _has('academic_search');
            const hasRepoMap  = _has('repo_map');
            const hasAst      = _has('ast_query') && (typeof getAstEnabled === 'function' ? getAstEnabled() : false);
            const hasExec     = _has('execute_code');
            const hasWsRead   = _has('read_file') || _has('search_workspace') || _has('list_files');

            const strategyLines: string[] = [];
            if (hasDeep)
                strategyLines.push(`For any question needing multiple web sources, call **deep_research** once — it plans sub-questions, searches and reads pages, and returns a cited report. Do NOT chain individual web_search calls for multi-source research; deep_research does it better.`);
            if (hasWeb || hasFetch) {
                const webTools = [hasWeb && 'web_search', hasFetch && 'fetch_url'].filter(Boolean).join(' / ');
                if (hasDeep)
                    strategyLines.push(`Use **${webTools}** for specific lookups, current events, or when you need one page rather than a full research sweep.`);
                else
                    strategyLines.push(`Use **${webTools}** to find and retrieve information from the web. Run parallel searches for different angles.`);
            }
            if (hasAcademic)
                strategyLines.push(`For scientific, technical, or medical questions, use **academic_search** (source: arxiv for CS/physics preprints, semantic_scholar for citation counts, pubmed for biomedical, crossref for DOI lookup).`);
            if (hasWsRead)
                strategyLines.push(`For codebase or workspace questions, use **search_workspace** (parallel calls, one keyword each) then **read_file** for the relevant sections.`);

            const toolLines: string[] = [];
            if (hasDeep)
                toolLines.push(`**deep_research** — multi-round web research: plans sub-questions, searches and reads sources, synthesizes a cited report. Use for any broad or multi-source question.`);
            if (hasWeb)
                toolLines.push(`**web_search** — find pages by keyword; source param selects: web (default), wikipedia, hackernews, github, stackoverflow, reddit, gdelt.`);
            if (hasFetch)
                toolLines.push(`**fetch_url** — retrieve a specific URL; set extract to pull only relevant passages from large pages.`);
            if (hasAcademic)
                toolLines.push(`**academic_search** — search academic papers; source: arxiv, semantic_scholar, pubmed, crossref.`);
            if (_has('list_files'))
                toolLines.push(`**list_files** — list workspace directory contents.`);
            if (_has('search_workspace'))
                toolLines.push(`**search_workspace** — search file contents by keyword or regex; use context_lines 20–40 to see full function bodies.`);
            if (_has('read_file'))
                toolLines.push(`**read_file** — read a file or line range; use start_line/end_line to target the section you need.`);
            if (hasExec)
                toolLines.push(`**execute_code** — run bash/Python to inspect workspace state; do not use to write files.`);
            if (hasRepoMap)
                toolLines.push(`**repo_map** — compact symbol map of all workspace code files; call first when the task involves code structure.`);
            if (hasAst)
                toolLines.push(`**ast_query** — exact function/class/symbol locations by name.`);

            const strategySection = strategyLines.length
                ? `\n## Research strategy\n${strategyLines.map(l => `- ${l}`).join('\n')}`
                : '';
            const toolSection = toolLines.length
                ? `\n## Tools\n${toolLines.map(l => `- ${l}`).join('\n')}`
                : '';

            return `You are a research specialist agent. Your goal is to find and synthesize information — from the web, academic sources, and the workspace — to answer questions completely and with citations. Do NOT write or modify files.
${strategySection}
**Parallel tool use:** Send independent tool calls together in one response. Only sequence when a later call depends on an earlier result.
**Format:** Use the structured JSON function-call format. Do NOT output tool calls as XML tags, markdown links, or code fences.
${toolSection}
## Output format
1. **Findings** — answer with citations: URLs for web sources, file:line for workspace
2. **Gaps** — what the research could not establish`;
        },
    },
    {
        name: 'coder',
        description: 'Reads, edits, and runs code. Uses write_file/replace_in_file for file edits, execute_code for running commands.',
        tier: 'execution',
        tools: new Set(['list_files', 'read_file', 'repo_map', 'search_workspace', 'execute_code',
                        'write_file', 'replace_in_file', 'apply_patch', 'append_file', 'delete_file',
                        'undo_write', 'ast_query']),
        body_fn(): string {
            const _has = (t: string) => enabledTools.has(t);

            const toolLines: string[] = [];
            if (_has('list_files'))
                toolLines.push(
`**list_files** — list directory contents
- "path" (optional): directory to list (default: workspace root).`);
            if (_has('search_workspace'))
                toolLines.push(
`**search_workspace** — find code locations
- "pattern" (required): ONE keyword, case-insensitive. One keyword per parallel call.
- "path_filter" (optional): pipe-separated filename filters: "tools.js|config.js".
- "context_lines" (optional, 0–50): use 20–40 to see full function bodies around a match.`);
            if (_has('read_file'))
                toolLines.push(
`**read_file** — read a file or section
- "path" (required): exact path from search_workspace or list_files output.
- "start_line" / "end_line" (optional, 1-based): target only the section you need.`);
            if (_has('repo_map'))
                toolLines.push(`**repo_map** — compact symbol map of all workspace code files; call first when understanding code structure matters.`);
            if (_has('ast_query'))
                toolLines.push(`**ast_query** — find exact function/class/symbol locations by name.`);
            if (_has('write_file'))
                toolLines.push(
`**write_file** — create or fully overwrite a file
- "path" (required): workspace-relative path.
- "content" (required): complete new file content.
- Use for new files or when replacing most of a file.`);
            if (_has('replace_in_file'))
                toolLines.push(
`**replace_in_file** — surgical in-place edit
- "path" (required): file to edit.
- "old_string" / "new_string" (required): exact before/after strings; must match file exactly.
- Prefer over write_file for small targeted changes to avoid clobbering unrelated code.
- Never use bash \`sed -i\` or \`echo >\` to edit files — those create .bak junk and corrupt Python string literals.`);
            if (_has('apply_patch'))
                toolLines.push(
`**apply_patch** — apply a unified diff
- "patch" (required): valid unified diff string (--- a/… +++ b/… @@ hunks).
- Use when you have a ready-made patch to apply.`);
            if (_has('append_file'))
                toolLines.push(
`**append_file** — append text to an existing file
- "path" (required): file to append to.
- "content" (required): text to append.`);
            if (_has('delete_file'))
                toolLines.push(`**delete_file** — permanently remove a file from the workspace\n- "path" (required): file to delete.`);
            if (_has('undo_write'))
                toolLines.push(`**undo_write** — undo the last write_file / replace_in_file / apply_patch operation.`);
            if (_has('execute_code'))
                toolLines.push(
`**execute_code** — run shell commands or scripts
- "language": "bash" (default) for shell commands; "python" for Python scripts.
- "code": code to run. Returns stdout, stderr, exit_code.
- Use for running tests, inspecting output, or shell operations. Do NOT use bash to write or edit files — use write_file or replace_in_file instead.`);

            const toolSection = toolLines.length ? `\n## Tools\n\n${toolLines.join('\n\n')}` : '';
            return `You are a coding specialist agent. Read code, edit files, run commands, and return findings or results.

**Response style:** Not allowed: multiple sentences of preamble, post-action summaries, narrating the answer instead of stating it directly, and printing a command as text instead of running it. Never output a shell command or code snippet as your answer — call the tool.

## Tool use
**Parallel:** Whenever possible, send tool calls as a list in a single response so they run in parallel. Only sequence calls when a later one depends on the result of an earlier one.
**Format:** Use the structured JSON function-call format. Do NOT output tool calls as XML tags, markdown links, or code fences — only structured calls are processed.
${toolSection}`;
        },
    },
    {
        name: 'director',
        description: 'Director: autonomous senior developer. Reads code directly, runs commands, and delegates parallel or complex work to coder/researcher workers.',
        tier: 'orchestrator',
        // Getter evaluated at call time (not module load) so nativeExec is reliably set.
        // • Browser (WebUI / TUI): ALL_TOOL_NAMES ceiling — every named tool the user enables
        //   in Settings is available.  Dynamic tools not in ALL_TOOL_NAMES (generate_image)
        //   are excluded: they are not Director workflow tools and should be delegated.
        // • Headless (benchmarks, fg-run): controlled set for reproducible benchmark runs.
        get tools() {
            if (typeof nativeExec !== 'function') return new Set(ALL_TOOL_NAMES as string[]);
            // Headless ceiling (benchmarks / fg-run): tools the director can call directly.
            // Write tools (write_file, replace_in_file, apply_patch) are intentionally excluded
            // here — the director should delegate editing work to coder workers rather than
            // writing files inline, and excluding them from this ceiling prevents hallucinated
            // direct calls. headless-runner.ts adds them to enabledTools so worker ceilings
            // (coder) can pass them through.
            //   • web_search, fetch_url — off unless listed in fg-run --enable-tools.
            // run_git is kept so the role-dispatch guard passes; the tool handler itself gates
            // on getGitEnabled() && getSandboxProvider() === 'local' and returns a clear error.
            return new Set([
                'read_file', 'search_workspace', 'list_files', 'run_workers', 'execute_code',
                'run_git', 'ast_query',
                ..._directorHeadlessExtras,
            ]);
        },
        // body_fn: called at prompt-build time so the Available tools section reflects
        // the tools actually in enabledTools at that moment, rather than a static snapshot.
        body_fn(): string {
            const _has = (t: string) => enabledTools.has(t);

            // ── Direct tools available to the director ──────────────────────────
            const readTools  = (['read_file', 'search_workspace', 'list_files'] as const).filter(_has);
            const writeTools = (['write_file', 'replace_in_file', 'apply_patch', 'append_file', 'delete_file', 'undo_write'] as const).filter(_has);
            const hasExec    = _has('execute_code');
            const hasGit     = _has('run_git') && getGitEnabled() && getSandboxProvider() === 'local';
            const hasAst     = _has('ast_query') && getAstEnabled();
            const hasRepoMap = _has('repo_map');
            const hasWeb     = _has('web_search');
            const hasFetch   = _has('fetch_url');
            const hasWk      = _has('run_workers');

            const toolLines: string[] = [];
            if (readTools.length)
                toolLines.push(`- **Read** — ${readTools.join(', ')}: read a file or range, search content by keyword, list directory`);
            if (writeTools.length)
                toolLines.push(`- **Write** — ${writeTools.join(', ')}: create, edit, patch, or delete files`);
            if (hasExec)
                toolLines.push(`- **Execute** — execute_code: run shell commands or scripts`);
            if (hasGit)
                toolLines.push(`- **Git** — run_git: git status, diff, log, commit, branch operations`);
            if (hasAst)
                toolLines.push(`- **AST** — ast_query: query code structure (functions, classes, imports, call graphs)`);
            if (hasRepoMap)
                toolLines.push(`- **Map** — repo_map: compact symbol map of all code files`);
            const webParts = ([hasWeb && 'web_search', hasFetch && 'fetch_url'] as const).filter(Boolean) as string[];
            if (webParts.length) {
                let webDesc: string;
                if (hasWeb && hasFetch)
                    webDesc = '- **Web** — web_search: find pages by keyword, returns titles/URLs/snippets. fetch_url: retrieve a specific URL and return its content.';
                else if (hasWeb)
                    webDesc = '- **Web** — web_search: find pages by keyword, returns titles/URLs/snippets.';
                else
                    webDesc = '- **Web** — fetch_url: retrieve a URL and return its content.';
                toolLines.push(webDesc);
            }

            if (hasWk) {
                // Coder worker, described without tool names: _filterRoleBody deletes every line
                // naming a tool the director lacks, and a director without edit tools (SWE-bench)
                // lost the whole coder line — it was never told coders exist.
                const hasCoderWrite = _has('write_file') || _has('replace_in_file') || _has('apply_patch');
                const coderDesc = hasCoderWrite ? 'reads, edits and runs code' : 'reads and runs code; edits through shell commands';

                // Researcher worker: ceiling intersected with enabledTools.
                // The researcher ceiling now includes web/research tools — only advertise
                // those that are both in the ceiling and currently enabled.
                const _researcherCeiling = rolesRegistry.get('researcher')?.tools;
                const _rAllowed = (t: string) => _has(t) && (!_researcherCeiling || _researcherCeiling.has(t));
                const researcherCoreTools = (['list_files', 'read_file', 'search_workspace', 'execute_code'] as const).filter(_rAllowed);
                const researcherWebTools  = (['deep_research', 'web_search', 'fetch_url', 'academic_search'] as const).filter(_rAllowed);
                if (_rAllowed('repo_map')) researcherCoreTools.push('repo_map' as never);
                const researcherTools = [...researcherCoreTools, ...researcherWebTools];
                // Build researcher description: emphasise web/research tools when present.
                let researcherDesc = 'workspace search, code structure, execution';
                if (researcherWebTools.includes('deep_research'))
                    researcherDesc += '; deep_research for multi-source web questions';
                else if (researcherWebTools.length)
                    researcherDesc += `; ${researcherWebTools.join(', ')} for web research`;

                const delegateCases = [
                    'parallel sub-tasks',
                    'broad or multi-step exploration',
                    'tasks too large for one turn',
                    ...(researcherWebTools.length || hasGit ? ['web/git research'] : []),
                ].join(', ');
                toolLines.push(
`- **Delegate** — run_workers(agents): spawn parallel workers; choose the role that matches the sub-task:
  - role "director" — a fork of you with your full context and tools. Use it when the subtask depends on what you've learned. Just state the subtask.
  - role "coder" — ${coderDesc}. Use coder for file edits. Sees the user's request and the task you send, not the rest of the conversation: include any paths, findings and constraints you have worked out.
  - role "researcher" — ${researcherDesc} (${researcherTools.join(', ')}). Sees the user's request and the task you send, not the rest of the conversation: include any paths, findings and constraints you have worked out.
Delegate to workers for: ${delegateCases}.`
                );
            }

            const availableToolsSection = toolLines.length
                ? `\n## Available tools\n${toolLines.join('\n')}`
                : '';

            return `You are the Director for FreeGent's autonomous task loop. You read code, run commands, make targeted edits, and delegate parallel or complex work to specialized workers.

# Protocol

## State machine

Every response with no tool call must end with exactly one of:
- \`COMPLETED\` — Task done. Past tense: report what was done, not what you are doing. Sanity-check each deliverable exists. Use for answered questions too.
- \`BLOCKED: <reason>\` — Cannot proceed. Name the exact blocker. Do not loop on an unobtainable thing.

A response with no tool call and no state line will be bounced. The only wrong move is trailing off without a state line or repeating a call you already ran.

**Dispatch independent sub-tasks in one \`run_workers\` call** rather than sequentially.

## Definition of done
COMPLETED requires every deliverable verified to exist by a tool result — not assumed.
Task-type-specific done criteria are injected as guidance when they become relevant — apply them.

## Context budget
Your history is shared with the user. Keep it lean:
- Summarise file contents — never echo them in full.
- One \`run_workers\` call per logical phase.
- Tool results in your history are compressed to ~20k chars. For detailed multi-file work, workers get full content in their own context.

## Response style
Not allowed: multiple sentences of preamble, post-action summaries, narrating the answer instead of stating it directly, and printing a command as text instead of running it. Never output a shell command or code snippet as your answer — call the tool.

# Tool use
**Parallel:** Whenever possible, send tool calls as a list in a single response so they run in parallel. Only sequence calls when a later one depends on the result of an earlier one.
**Format:** Use the structured JSON function-call format the API provides. Do NOT output tool calls as XML tags (e.g. \`<execute_code>\`), markdown links, or code fences — only structured calls are processed.
**Text is never executed:** Code blocks and command text do nothing. If you want something run, make the tool call.

## Policy
After a tool succeeds: do not second-guess. Move to the next step — no re-checking, no replaying, no validation theater.

After a tool fails: retry with a fix (corrected args, exact text re-read from the file, smaller step), run a diagnostic, or state plainly what failed. A failed tool is not a stopping condition — only DONE or BLOCKED is.
${availableToolsSection}
${_roleConciseBlock}`;
        },
    },
];

// Pre-populate with built-ins; loadRoles() overlays workspace roles/ files
const rolesRegistry = new Map(BUILTIN_ROLES.map(r => [r.name, r]));

function _parseRoleFile(content: string) {
    const m = content.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n([\s\S]*)$/);
    if (!m) return null;
    const fm = m[1], body = m[2].trim();
    const name        = (fm.match(/^name:\s*(.+)$/m)        || [])[1]?.trim();
    const description = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
    const toolsStr    = (fm.match(/^tools:\s*(.+)$/m)       || [])[1]?.trim() || '';
    const tier       = (fm.match(/^tier:\s*(.+)$/m)         || [])[1]?.trim() || 'execution';
    if (!name) return null;
    const tools = new Set(toolsStr.split(/[,\s]+/).filter(Boolean));
    // Wrap the static body in body_fn so all registry entries share one interface.
    return { name, description, tools, tier, body_fn: () => body };
}

async function loadRoles() {
    for (const r of BUILTIN_ROLES) rolesRegistry.set(r.name, r); // reset to built-ins
    try {
        const files = await agentListFiles();
        const roleFiles = files.filter(f => /^(?:local\/)?roles\/[^/]+\.md$/i.test(f.name));
        await Promise.all(roleFiles.map(async f => {
            try {
                const content = await agentReadFile(f.name);
                const r = _parseRoleFile(content);
                if (r) rolesRegistry.set(r.name, r);
            } catch {}
        }));
    } catch {}
}


function inferWorkerTools(task: string): Set<string> {
    const t = task.toLowerCase();
    // Candidate set — intersected with enabledTools below so OPT_IN tools (write_file,
    // replace_in_file, apply_patch, repo_map, …) can never be smuggled in via this path.
    const s = new Set(['list_files', 'read_file', 'write_file', 'append_file', 'delete_file',
                       'replace_in_file', 'apply_patch', 'search_workspace', 'repo_map']);
    if (/\b(search|research|find|look.?up|browse|fetch|url|https?|web|wikipedia|news|current|latest)\b/.test(t))
        ['web_search', 'fetch_url'].forEach(n => s.add(n));
    if (/\b(code|script|python|bash|run|execute|test|debug|implement|compute|calculat)\b/.test(t))
        s.add('execute_code');

    // Respect OPT_IN_TOOLS: only pass through tools that are actually in enabledTools.
    // activeTools() would gate on enabledTools anyway, but filtering here keeps the tool
    // filter honest so the system prompt and tool list stay in sync.
    return new Set([...s].filter(n => enabledTools.has(n)));
}

let workerRole: any = null;       // module-level; set during worker runs, read by buildWorkerSystemPrompt()
_setRoleObj(rolesRegistry.get('director') || null); // Director is the persistent default role

function _saveRoleForChat(name: string): void {
    try {
        const id = activeChatId;
        if (!id) return;
        // Only persist non-default roles; delete the key when back to Director
        if (name && name !== 'director') localStorage.setItem(chatKey.role(id), name);
        else localStorage.removeItem(chatKey.role(id));
        sessionSetChatRole?.(id, name && name !== 'director' ? name : null);
    } catch {}
}
function setMainAgentRole(name: string): void {
    const _name = name?.toLowerCase() ?? name;
    _setRoleObj(rolesRegistry.get(_name) || null);
    _saveRoleForChat(_name);
}
function clearMainAgentRole(): void {
    // Director is always the default; this restores it after a custom role is done.
    _setRoleObj(rolesRegistry.get('director') || null);
    _saveRoleForChat('director');
}
function restoreRoleForChat(id: string): void {
    try {
        const name = localStorage.getItem(chatKey.role(id));
        // Always resolve to a role object — director is the default when nothing custom is saved.
        const role = (name && name !== 'director' && rolesRegistry.get(name)) || rolesRegistry.get('director');
        _setRoleObj(role ?? null);
    } catch {}
}
const _fileStallCounts = new Map(); // path → consecutive stall count — reset when a file is cleanly written

// Returns skill bodies from the registry that are auto-injected for a given role name.
// Skills declare role affinity via `roles: roleName` frontmatter.
// toolSet: the role's effective tool set (role.tools ∩ enabledTools); undefined = use enabledTools.
function _roleSkillBodies(roleName: string, toolSet?: Set<string>): string {
    // toolSet is role.tools ∩ enabledTools; check requires_tools against it so a skill
    // requiring write_file isn't injected into a worker whose ceiling excludes it.
    const _toolCheck = (t: string) => toolSet ? toolSet.has(t) : enabledTools.has(t);
    const parts = [];
    for (const skill of skillsRegistry.values()) {
        if (!skill.roles) continue;
        const names = skill.roles.split(',').map(s => s.trim().toLowerCase());
        if (!names.includes(roleName.toLowerCase())) continue;
        if (skill.requires && localStorage.getItem(skill.requires) === 'false') continue;
        if (skill.requires_tools && skill.requires_tools.split(',').some(t => !_toolCheck(t.trim()))) continue;
        const body = typeof skill.body_fn === 'function' ? skill.body_fn() : skill.body;
        if (body) parts.push('\n\n' + _filterRoleBody(body, toolSet));
    }
    return parts.join('');
}

// Post-process a role body to remove references to tools that are not in the effective tool set.
// toolSet: the role's effective tool set (role.tools ∩ enabledTools); undefined = use enabledTools.
// Pass the effective set so that a role whose .tools ceiling excludes a tool gets its body filtered
// even if that tool is globally enabled — the model should only see tools it can actually call.
function _filterRoleBody(body: string, toolSet?: Set<string>): string {
    const has = (name: string) => toolSet ? toolSet.has(name) : enabledTools.has(name);
    const hasWeb     = has('web_search');
    const hasFetch   = has('fetch_url');
    const hasDR      = has('deep_research');
    const hasExec    = has('execute_code');
    const hasRepoMap = has('repo_map');
    const hasSearch  = has('search_workspace');
    const hasRead    = has('read_file');
    const hasWrite   = has('write_file');
    const hasReplace = has('replace_in_file');
    const hasPatch   = has('apply_patch');

    let b = body;

    if (!hasExec) {
        b = b.replace(/\*\*execute_code\*\* — run source code[\s\S]*?(?=\n\n\*\*|\n##|$)/, '');
        b = b.replace(/\bexecute_code, /g, '').replace(/, execute_code\b/g, '');
    }

    // ── web_search / fetch_url references ───────────────────────────────────
    if (!hasWeb && !hasFetch)
        b = b.replace(/ — use web_search or fetch_url if needed/g, '');
    else if (!hasWeb)
        b = b.replace(/web_search or fetch_url/g, 'fetch_url').replace(/web_search, /g, '').replace(/, web_search/g, '');
    else if (!hasFetch)
        b = b.replace(/web_search or fetch_url/g, 'web_search').replace(/fetch_url, /g, '').replace(/, fetch_url/g, '');

    // Fix researcher tool list before broad removal — strip only web-specific tools from
    // the researcher line rather than deleting the whole line (researcher still has read_file etc.)
    if (!hasWeb || !hasFetch) {
        b = b.replace(/^(- \*\*researcher\*\* — read_file, repo_map, search_workspace).*$/m,
            (_, base) => base);
    }
    // Fix "researcher (deep web/academic search)" description when web is disabled
    if (!hasWeb && !hasFetch)
        b = b.replace(/researcher \(deep web\/academic search\)/g, 'researcher (codebase search)');
    else if (!hasWeb)
        b = b.replace(/researcher \(deep web\/academic search\)/g, 'researcher (fetch_url + codebase search)');

    // Remove whole lines / bullets that are solely about disabled web tools
    if (!hasWeb)  b = b.replace(/^.*\bweb_search\b.*\n?/gm, '');
    if (!hasFetch) b = b.replace(/^.*\bfetch_url\b.*\n?/gm, '');
    if (!hasDR)   b = b.replace(/^.*\bdeep_research\b.*\n?/gm, '');

    const hasAppend      = has('append_file');
    const hasList        = has('list_files');
    const hasWorkers     = has('run_workers');
    const hasTaskStatus  = has('update_task_status');

    // ── Optional filesystem tool references (user may disable individually in Settings → Tools) ──
    // Two-pass approach for each tool:
    //   1. Remove from comma-separated lists inline (surgical — preserves sibling tools on the same line).
    //   2. Remove whole lines/sections that remain solely about the disabled tool.
    // Pass 1 must run before pass 2 so that a multi-tool summary line (e.g. director's "Direct" list)
    // doesn't get entirely stripped just because one of its tools is disabled.

    // ── replace_in_file / apply_patch (always paired in guidance) ───────────
    if (!hasReplace && !hasPatch) {
        b = b.replace(/\bPrefer replace_in_file and apply_patch over full rewrites; /gi, '');
        // Pass 1: strip from comma lists
        b = b.replace(/\breplace_in_file,\s*/g, '').replace(/,\s*replace_in_file\b/g, '');
        b = b.replace(/\bapply_patch,\s*/g, '').replace(/,\s*apply_patch\b/g, '');
        // Pass 2: strip remaining lines/sections
        b = b.replace(/^.*\b(?:replace_in_file|apply_patch)\b.*\n?/gm, '');
    } else if (!hasReplace) {
        b = b.replace(/\breplace_in_file and apply_patch\b/g, 'apply_patch');
        b = b.replace(/\breplace_in_file,\s*/g, '').replace(/,\s*replace_in_file\b/g, '');
        b = b.replace(/^.*\breplace_in_file\b.*\n?/gm, '');
    } else if (!hasPatch) {
        b = b.replace(/\breplace_in_file and apply_patch\b/g, 'replace_in_file');
        b = b.replace(/\bapply_patch,\s*/g, '').replace(/,\s*apply_patch\b/g, '');
        b = b.replace(/^.*\bapply_patch\b.*\n?/gm, '');
    }

    // ── repo_map / search_workspace ──────────────────────────────────────────
    if (!hasRepoMap) {
        b = b.replace(/\buse repo_map (first|to[^.;,\n]*)/gi,
            'use execute_code (bash: find + grep) to map the codebase');
        b = b.replace(/\bcall repo_map first[^.;,\n]*/gi,
            'use execute_code (bash: find + grep) to explore the codebase first');
        b = b.replace(/\bstart with repo_map[^.;,\n]*/gi,
            'use execute_code (bash: grep/find) to explore the codebase');
        b = b.replace(/\brepo_map,\s*/g, '').replace(/,\s*repo_map\b/g, '');
        b = b.replace(/^.*\brepo_map\b.*\n?/gm, '');
    }
    if (!hasSearch) {
        b = b.replace(/\buse search_workspace to locate[^.;,\n]*/gi,
            'use execute_code (bash: grep -r) to locate content');
        b = b.replace(/\bsearch_workspace,\s*/g, '').replace(/,\s*search_workspace\b/g, '');
        b = b.replace(/^.*\bsearch_workspace\b.*\n?/gm, '');
    }

    // ── individual file tools ────────────────────────────────────────────────
    if (!hasRead) {
        b = b.replace(/\bread_file,\s*/g, '').replace(/,\s*read_file\b/g, '');
        b = b.replace(/^.*\bread_file\b.*\n?/gm, '');
    }
    if (!hasWrite) {
        b = b.replace(/\bwrite_file,\s*/g, '').replace(/,\s*write_file\b/g, '');
        b = b.replace(/^.*\bwrite_file\b.*\n?/gm, '');
    }
    if (!hasAppend) {
        b = b.replace(/\bappend_file,\s*/g, '').replace(/,\s*append_file\b/g, '');
        b = b.replace(/^.*\bappend_file\b.*\n?/gm, '');
    }
    const hasDelete = has('delete_file');
    if (!hasDelete) {
        b = b.replace(/\bdelete_file,\s*/g, '').replace(/,\s*delete_file\b/g, '');
        b = b.replace(/^.*\bdelete_file\b.*\n?/gm, '');
    }
    const hasUndo = has('undo_write');
    if (!hasUndo) {
        b = b.replace(/\bundo_write,\s*/g, '').replace(/,\s*undo_write\b/g, '');
        b = b.replace(/^.*\bundo_write\b.*\n?/gm, '');
    }

    // ── list_files ───────────────────────────────────────────────────────────
    if (!hasList) {
        b = b.replace(/\blist_files,\s*/g, '').replace(/,\s*list_files\b/g, '');
        b = b.replace(/^.*\blist_files\b.*\n?/gm, '');
    }

    // ── run_git ──────────────────────────────────────────────────────────────
    const hasGit = has('run_git');
    if (!hasGit) {
        b = b.replace(/\brun_git,\s*/g, '').replace(/,\s*run_git\b/g, '');
        b = b.replace(/^.*\brun_git\b.*\n?/gm, '');
    }

    // ── run_workers ──────────────────────────────────────────────────────────
    if (!hasWorkers) {
        // Strip the bolded run_workers section header + its body (tool description block)
        b = b.replace(/\*\*run_workers\b[^*]*\*\*[\s\S]*?(?=\n\n\*\*|\n##|$)/g, '');
        // Strip the "Delegate" bullet in the director's Available tools summary
        b = b.replace(/^- \*\*Delegate\*\* —[^\n]*\n?/gm, '');
        // Strip any remaining inline or bullet references
        b = b.replace(/\brun_workers,\s*/g, '').replace(/,\s*run_workers\b/g, '');
        b = b.replace(/^.*\brun_workers\b.*\n?/gm, '');
    }

    // ── update_task_status ───────────────────────────────────────────────────
    if (!hasTaskStatus) {
        b = b.replace(/\bupdate_task_status,\s*/g, '').replace(/,\s*update_task_status\b/g, '');
        b = b.replace(/^.*\bupdate_task_status\b.*\n?/gm, '');
    }

    // Clean up empty fenced code blocks left by line removals (``` with no content)
    b = b.replace(/^```[^\n]*\n```/gm, '');
    // Clean up any double-blank lines left by removals
    b = b.replace(/\n{3,}/g, '\n\n');
    return b;
}

function buildWorkerSystemPrompt(roleOverride: any = null): string {
    const concise = getAgentConcisePrompts()
        ? '\nRespond in compressed, telegraphic style — facts, findings, file paths, decisions. No preamble, no summary wrap-up, no pleasantries.'
        : '';
    const effectiveRole = roleOverride ?? workerRole;
    const _envCtx = typeof _buildEnvContext === 'function' ? _buildEnvContext() : '';
    if (effectiveRole) {
        // Effective tool set = role.tools ∩ enabledTools.  When the role has no .tools ceiling
        // (custom roles loaded from files may omit it), fall back to enabledTools alone.
        const effectiveToolSet: Set<string> | undefined = effectiveRole.tools
            ? new Set([...effectiveRole.tools].filter((t: string) => enabledTools.has(t)))
            : undefined;
        // Precedence: saved JS source > saved plain text > built-in body_fn > static body.
        // Saved JS source is the full body_fn.toString() string, edited and saved via Settings →
        // Roles.  We extract the function body and run it so the saved code has access to all
        // window globals (enabledTools, rolesRegistry, isToolActive …) exactly like body_fn does.
        const _savedFnSrc = typeof getRoleBodyFn === 'function' ? getRoleBodyFn(effectiveRole.name) : null;
        const _rawBody = (_savedFnSrc
            ? (() => {
                try {
                    // Extract body between first { and last } of the saved function definition.
                    const _b = _savedFnSrc.indexOf('{');
                    const _e = _savedFnSrc.lastIndexOf('}');
                    const _body = (_b !== -1 && _e > _b) ? _savedFnSrc.slice(_b + 1, _e) : _savedFnSrc;
                    // eslint-disable-next-line no-new-func
                    return new Function(_body)() as string;
                } catch (err) {
                    console.warn('[FreeGent] saved role body_fn eval failed — falling back:', err);
                    return null;
                }
              })()
            : null)
            || getRoleBody(effectiveRole.name)
            || (typeof effectiveRole.body_fn === 'function' ? effectiveRole.body_fn() : (effectiveRole.body || ''));
        const body = _filterRoleBody(_rawBody, effectiveToolSet);
        return `${body}${_roleSkillBodies(effectiveRole.name, effectiveToolSet)}${_envCtx}${WORKER_STATUS_FOOTER}${concise}`;
    }
    const _wsWorkerDesc = typeof _buildWorkspaceDesc === 'function'
        ? _buildWorkspaceDesc()
        : 'Files are in the workspace. Use execute_code (bash) or the available file tools to access them.';
    // Build code-navigation guidance based on which tools are actually enabled.
    const _hasExec   = enabledTools.has('execute_code') && (typeof _hasBashOrCode === 'function' ? _hasBashOrCode() : false);
    const _hasRepo   = enabledTools.has('repo_map');
    const _hasSearch = enabledTools.has('search_workspace');
    const _hasRead   = enabledTools.has('read_file');
    const _hasList   = enabledTools.has('list_files');
    const _navLines: string[] = [];
    if (_hasRepo)   _navLines.push('- **repo_map** — symbol map of all code files (functions, classes per file); use this first to orient');
    if (_hasSearch) _navLines.push('- **search_workspace(pattern, [is_regex], [path_filter], [context_lines])** — search all files; path_filter supports pipe-separated values e.g. "local/a.js|local/b.js"; use context_lines 20–40 to capture full function bodies');
    if (_hasRead)   _navLines.push('- **read_file(path, [start_line], [end_line])** — read a file or a specific line range');
    if (_hasList)   _navLines.push('- **list_files** — list all workspace files');
    if (_hasExec && !_hasRepo && !_hasSearch) _navLines.push('- **execute_code (bash)** — use grep/find to search; workspace at /workspace (absolute paths)');
    const _navHint = _navLines.length
        ? `Use these tools to find and read code:\n${_navLines.join('\n')}\n\n`
        : '';
    const _parallelHint = _hasExec && !_hasRepo
        ? 'Run grep/find calls in parallel. Read files freely — your context is disposable.'
        : _hasRepo
        ? 'Run repo_map and grep calls in parallel. Read full files or large sections freely — your context is disposable.'
        : 'Work carefully — read only what you need.';
    return `You are a focused worker agent. Complete your assigned task using the available tools.
${WORKER_STATUS_FOOTER}
${_wsWorkerDesc}
${_navHint}${_parallelHint}
Do not attempt to spawn workers. Work independently and write your outputs as files.${concise}`;
}

// Workspace view for one run_workers call. The file list is taken up front; a file's content is
// read on first access and then kept, so every worker sees the same content for it. Reading every
// file eagerly cost 1.2 s per call on a Django-sized repo, and 43 s through docker exec (one
// `docker exec cat` per file, TerminalBench), while workers touch only a handful of files.
export class LazySnapshot {
    private _sizes   = new Map<string, number>();                        // name → size from the listing
    private _content = new Map<string, Promise<string | undefined>>();   // name → first read
    constructor(files: Array<{ name: string; size?: number }>) {
        for (const f of files) this._sizes.set(f.name, f.size ?? 0);
    }
    get size(): number { return this._sizes.size; }
    has(name: string): boolean { return this._sizes.has(name); }
    list(): Array<{ name: string; size: number }> { return [...this._sizes].map(([name, size]) => ({ name, size })); }
    // undefined when the file isn't in the listing or can't be read (e.g. a directory).
    get(name: string): Promise<string | undefined> {
        if (!this._sizes.has(name)) return Promise.resolve(undefined);
        let p = this._content.get(name);
        if (!p) { p = agentReadFile(name).catch(() => undefined); this._content.set(name, p); }
        return p;
    }
}

async function takeWorkspaceSnapshot(): Promise<LazySnapshot> {
    try { return new LazySnapshot((await agentListFiles()).filter(f => !f.isLocal)); }
    catch { return new LazySnapshot([]); }
}

// ── Endpoint busy-tracking for parallel rotation ──────────────────────────
// When "Rotate endpoints each step" is on, parallel workers should each use
// a different endpoint so no two requests hit the same provider at once.
// _busyEndpointSpecs tracks specs ("provider|model") currently in-flight.
const _busyEndpointSpecs = new Set();

/**
 * When endpoint rotation is enabled, pick a primary-list spec that is neither
 * cooling down nor already busy with another parallel worker.
 * Returns the spec string (e.g. "google|gemini-...") or null if none available.
 * The caller is responsible for adding the returned spec to _busyEndpointSpecs
 * before launching the request and removing it when the request finishes.
 */
function _pickFreeRotationSpec(alreadyPicked: Set<string> | null): string | null {
    if (!getEndpointRotation()) return null;
    const pool = getActiveMainModelList();
    if (pool.length < 2) return null;
    for (const spec of pool) {
        if (getCooldownRemaining(spec) > 0) continue;
        if (_busyEndpointSpecs.has(spec)) continue;
        if (alreadyPicked?.has(spec)) continue;
        return spec;
    }
    return null; // all busy or cooling
}

// Task message for a forked worker, appended after the inherited prefix. Every fork-specific
// instruction lives here, after the shared prefix, so it cannot break prefix-cache identity.
function _forkTaskMessage(task: string): string {
    return `<fork>
You are a fork of the main agent, working on one subtask it delegated to you. The conversation above is your context. Do only this subtask; do not redo earlier work or continue the main task. End your final reply with a status line instead of COMPLETED: STATUS: complete, STATUS: blocked — <reason>, or STATUS: partial — <what remains>.
</fork>

Subtask: ${task}`;
}

// The user's request for a non-fork worker: the first real user message and, when different, the
// latest one, with framework blocks stripped. Workers without it lose the task's details
// (v0.55: coder delegations dropped from 28 to 8 and none resolved).
function _userRequestMsgs(messages: any[]): { role: string; content: string }[] {
    const real = messages.filter(isRealUserMessage)
        .map(m => stripInjected(m.content.replace(/^\[TASK[^\]]*\]\n/, '')))
        .filter(Boolean);
    if (!real.length) return [];
    const first = real[0], last = real[real.length - 1];
    return (last !== first ? [first, last] : [first]).map(content => ({ role: 'user', content }));
}

async function runWorkerTurn(task: string, context: any, taskHandle: any, workerModelSpec: string | null = null, role: any = null, forkBase: ForkBase | null = null): Promise<{ output: string; toolCalls: { name: string; label: string }[] }> {
    const wSpec = resolveWorkerModelSpec(workerModelSpec, role);
    let endpoint = wSpec ? specToEndpoint(wSpec) : null;
    taskHandle.setModel(modelFriendlyName(wSpec || `${getProvider()}|${getActiveModel()}`));

    // Capture role and tool filter as local constants — avoids race conditions when multiple
    // workers run in parallel and would otherwise stomp on the shared module-level globals.
    const localRole       = role;
    // localToolFilter is passed to activeTools(forWorker=true, ...) where it acts as the
    // worker's API schema ceiling (role.tools ∩ enabledTools ∩ conditionalGates).
    // Lean-worker inference (inferWorkerTools) is the fallback when no named role is given.
    // null means no ceiling — worker gets all of enabledTools.
    const localToolFilter = role?.tools ?? (getAgentLeanWorkers() ? inferWorkerTools(task) : null);

    const localOH   = [];
    const localSeenRF = new Map(); // per-worker read-file dedup (isolates from main agent globals)
    const localSeenLF = new Set(); // per-worker list-files dedup
    // Accumulates every tool call this worker makes across all steps — surfaced in session log.
    const _wToolCalls: { name: string; label: string }[] = [];

    // create an isolated session for this worker.
    // Uses a deterministic ID so parallel workers don't collide (activeChatId + role + timestamp).
    const _wSessId = `worker-${activeChatId ?? 'anon'}-${localRole?.name ?? 'w'}-${Date.now()}`;
    const _wSession = (() => {
        try { return registry.create({ id: _wSessId, chatId: activeChatId ?? 'anon' }); } catch { return null; }
    })();
    let _wEvtTurn = 0;
    if (_wSession) {
        try { _wSession.append('turn/start', { turn: 0, chatId: activeChatId ?? 'anon' }); } catch {}
    }

    // Two kinds of worker:
    // - Fork (role "director"): inherits the parent's last request verbatim — system prompt,
    //   tools and messages — plus the subtask. The request shares the parent's exact prefix, so
    //   the endpoint's prefix cache covers the inherited history. Off when the worker-history
    //   setting is off, or when there is no parent request to fork.
    // - Specialist (every other role): own role prompt and tools; sees the user's request
    //   (first and latest user messages) and the task.
    const isFork = !!forkBase && (!role || role.name === 'director') && getAgentWorkerHistory();
    if (isFork) {
        localOH.push(...forkBase!.messages);
        localOH.push({ role: 'user', content: _forkTaskMessage(task) });
    } else {
        localOH.push(..._userRequestMsgs(forkBase?.messages ?? []));
        localOH.push({ role: 'user', content: task });
    }
    // This worker's own last request, exposed so a nested run_workers call can fork it.
    let _ownRequest: ForkBase | null = null;
    if (context) context.parentRequest = () => _ownRequest;

    const maxSteps = _WORKER_MAX_STEPS;
    let wResultHashes: string[] = [];
    const _wSeen = { rf: localSeenRF, lf: localSeenLF };
    const _workerRepeatCache = new Map();
    let _wRepeatGuard = newRepeatGuard();
    let workerFallback: any = null;

    const _garbledState = { count: 0 };
    let _wEnvFailSig = '', _wEnvFailCount = 0, _wEnvFailTotal = 0;
    let _noToolNudgeFired = false;
    // Helper: close worker session and clean up registry.
    const _wSessionClose = (reason: import('./session-event.ts').TurnEndReason) => {
        if (!_wSession) return;
        try { _wSession.append('turn/end', { turn: _wEvtTurn, reason }); } catch {}
        try { registry.remove(_wSessId); } catch {}
    };

    for (let step = 0; step < maxSteps; step++) {
        if (softStopPending) { _wSessionClose({ kind: 'soft-stop' }); return { output: '*(break)*', toolCalls: _wToolCalls }; }

            let message: any;
            let workerMaxTokens: number | null = null;
            const _wRole = localRole?.name ?? 'anon'; // used in the catch/post blocks too — must outlive the try scope
            try {
                const _wEp = (endpoint ?? oaiEndpoint());
                let _callAttempt = 0;
                // Pass worker session + step so callOAI can log request/header.
                // evtSession uses a fake AgentSession shape (only _session and _evtTurn needed).
                const _wEvtSessProxy = _wSession ? { _session: _wSession, _evtTurn: _wEvtTurn } as any : null;
                message = await withRetry(
                    () => { console.error(`[worker:${_wRole}:step${step}] calling callOAI attempt=${_callAttempt++} ep=${(endpoint??oaiEndpoint()).provider}|${(endpoint??oaiEndpoint()).model} histLen=${localOH.length}`); return callOAI((c, t) => taskHandle.append(c, t),
                        p => {
                            taskHandle.setRequest?.(JSON.stringify(p, null, 2));
                            _ownRequest = { system: p.messages[0]?.content ?? '', tools: p.tools ?? null, messages: p.messages.slice(1) };
                        },
                        { localHistory: localOH, forWorker: true, endpointOverride: endpoint,
                          roleOverride: localRole, toolFilterOverride: localToolFilter,
                          maxTokens: workerMaxTokens, evtSession: _wEvtSessProxy, evtStep: step,
                          forkPrefix: isFork ? { system: forkBase!.system, tools: forkBase!.tools } : null }); },
                    _makeOAIRetryHandler({
                        getEp: () => endpoint ?? oaiEndpoint(),
                        setEp: ep => { endpoint = ep; taskHandle.setModel(modelFriendlyName(`${ep.provider}|${ep.model}`)); },
                        onNote: msg => { console.error(`[worker:${_wRole}:retry] ${msg}`); taskHandle.append(`\n${msg}\n`, 'thinking'); },
                        onContextOverflow: max => { workerMaxTokens = max; taskHandle.append(`\n[context overflow: reducing max_tokens to ${max}]\n`, 'thinking'); },
                        onContextTruncate: () => {
                            // Prompt exceeds context window even at min max_tokens.
                            // Progressively drop middle messages, keeping localOH[0] (task).
                            // Returns true if something was removed (caller retries), false to bail.
                            if (localOH.length > 1) {
                                // Drop half of everything after index 0, at least 1 message.
                                const drop = Math.max(1, Math.floor((localOH.length - 1) / 2));
                                localOH.splice(1, drop);
                                workerMaxTokens = null;
                                taskHandle.append(`\n[context overflow: dropped ${drop} messages, ${localOH.length} remain]\n`, 'thinking');
                                return true;
                            }
                            return false;  // only task message left; bail so caller records error
                        },
                    }),
                    100,
                    () => (endpoint ?? oaiEndpoint()).provider === 'custom'
                );
                const _u = message?.usage;
                console.error(`[worker:${_wRole}:step${step}] callOAI done, tool_calls=${(message?.tool_calls||[]).length}${isFork ? ' fork' : ''} prompt_tokens=${_u?.prompt_tokens ?? '?'} cached_tokens=${_u?.prompt_tokens_details?.cached_tokens ?? '?'}`);
                recordSuccess(endpoint ?? oaiEndpoint());
            } catch (e) { console.error(`[worker:${_wRole}:step${step}] callOAI threw: ${e.message}`); throw e; }

            const { usage, ...msg } = message;
            localOH.push(msg);
            const text  = typeof message.content === 'string' ? message.content : '';
            const calls = message.tool_calls || [];
            if (!calls.length) {
                // Quality gate (shared _checkTextResponse): don't return runaway garbage
                // (repetition loops, giant no-call dumps, narration-only) as worker output —
                // truncate it in history, nudge, and retry. After 3 consecutive bad responses
                // (action === 'bail'), return the truncated text rather than looping further.
                const qc = _checkTextResponse(text, step, maxSteps, _garbledState);
                if (qc) {
                    localOH[localOH.length - 1] = { ...msg, content: qc.truncated };
                    emitNudge('worker_runaway', { role: 'user', content: `<nudge>${qc.nudge}</nudge>` }, { history: localOH });
                    if (qc.action === 'bail') { _wSessionClose({ kind: 'error', message: 'bail:garbled' }); return { output: qc.truncated, toolCalls: _wToolCalls }; }
                    continue;
                }
                // No tool calls AND no tools ever called this turn: the worker narrated
                // instead of acting (tools-as-text, backtick names, prose plan). Nudge once;
                // if it happens again, let the response through as-is.
                // Forks skip this: the inherited context may already hold the answer.
                if (!isFork && _wToolCalls.length === 0 && !_noToolNudgeFired) {
                    _noToolNudgeFired = true;
                    emitNudge('worker_no_tools', { role: 'user', content: `<nudge>You haven't called any tools yet. Use the structured function-call format to call tools — code blocks, backtick names, and prose descriptions do nothing. Call a tool now to start your task.</nudge>` }, { history: localOH });
                    continue;
                }
                console.error(`[worker:${_wRole}:step${step}] no tool calls, returning text`);
                _wSessionClose({ kind: 'completed' });
                return { output: text, toolCalls: _wToolCalls };
            }

            // Shared repairs (tool-call-repair.ts): fence-wrapped JSON args, mangled
            // names, execute_code alias/fence/token cleanup — same as the main loop.
            // Irreparable args/empty code execute as-is; their errors are real feedback
            // (dispatch rejects empty code with a targeted message).
            const { norm: _normCalls } = repairAllToolCalls(calls);
            // Repeat guard (same as the main loop): refuse a call that already repeated with the same result.
            const _wCallSig = _callSig(_normCalls);
            const _wRefused = _repeatRefused(_wRepeatGuard, _wCallSig);
            const _exec = _wRefused
                ? _normCalls.map(({ name, args }) => ({ name, args, result: _repeatRefusalResult(_wRepeatGuard.streak) }))
                : await _runToolCalls(_normCalls, null, {
                    forWorker: true, context, repeatCache: _workerRepeatCache,
                    onStart: (name, args) => taskHandle.append(`→ ${toolLabel(name, args)}\n`, 'thinking'),
                });
            _wRepeatGuard = _wRefused
                ? { ..._wRepeatGuard, refused: _wRepeatGuard.refused + 1 }
                : _updateRepeatGuard(_wRepeatGuard, _wCallSig, _resultSig(_exec));
            // Record every tool call this step into the per-worker log (name + compact label).
            for (const c of _normCalls) _wToolCalls.push({ name: c.name, label: toolLabel(c.name, c.args) });
            const results = _exec.map((r, i) => ({ tc: calls[i], name: r.name, result: r.result }));
            const wStepBudgetChars = parseInt((typeof ls === 'function' ? ls(KEYS.AGENT_STEP_BUDGET, ls(KEYS.AGENT_MAX_TOOL_RESULT, '20000')) : '20000'), 10);
            const wStepBudget = { remaining: wStepBudgetChars };
            for (const { tc, name, result } of results) {
                const histResult = truncateResultForHistory(name, result, { seenReadFiles: localSeenRF, seenListFiles: localSeenLF, stepBudget: wStepBudget });
                const _histContent = JSON.stringify(histResult);
                localOH.push({ role: 'tool', tool_call_id: tc.id, name, content: _histContent });
                // log tool result to worker session.
                if (_wSession) {
                    try {
                        _wSession.append('tool/result', {
                            turn: _wEvtTurn, step, callId: tc.id, name, content: _histContent,
                            ...(result?.error || (result?.exit_code != null && result.exit_code !== 0) ? { isError: true } : {}),
                        }, { surfaceOp: 'append' } as any);
                    } catch {}
                }
            }

            // Stuck + env-failure detection (shared). Nudges go AFTER tool results (OAI ordering).
            // _fpTrunc keeps signatures cheap on large results — same fingerprinting as the main loop.
            const resSig = JSON.stringify(results.map(r => ({ n: r.name, res: r.result })), _fpTrunc);
            const stalledPaths = new Set(_normCalls.map(c => c.args?.path).filter(Boolean).map(_normPath)) as Set<string>;
            let _stuckMsg: string | null;
            ({ resultHashes: wResultHashes, stuckMsg: _stuckMsg } = _updateStuckDetector(resSig, stalledPaths, wResultHashes, _wSeen));
            let _wEnvFailMsg: string | null;
            ({ envFailSig: _wEnvFailSig, envFailCount: _wEnvFailCount, envFailTotal: _wEnvFailTotal, envFailMsg: _wEnvFailMsg } =
                _updateEnvFailureDetector(results, _wEnvFailSig, _wEnvFailCount, _wEnvFailTotal));
            if (_stuckMsg)    emitNudge('worker_stuck',   { role: 'user', content: `<nudge>${_stuckMsg}</nudge>` },    { history: localOH });
            if (_wEnvFailMsg) emitNudge('worker_env_fail',{ role: 'user', content: `<nudge>${_wEnvFailMsg}</nudge>` }, { history: localOH });
            // Kept repeating a refused call: report the loop (executeWorkers marks it blocked).
            if (_wRepeatGuard.refused >= REPEAT_REFUSALS_BEFORE_STOP) {
                _wSessionClose({ kind: 'error', message: 'repeat loop' });
                return { output: '*(loop detected)*', toolCalls: _wToolCalls };
            }
    }
    _wSessionClose({ kind: 'max-turns' });
    return { output: '*(max steps reached)*', toolCalls: _wToolCalls };
}

// Labels used by the two protocol-compliance judge mechanisms (step-validator.js's generic
// checks, turn-protocol.js's post-COMPLETED verify) — logged to turn_log below since neither
// ever touches openaiHistory. Everything else callLLMComplete is used for (research:*,
// skill:*, worker:review/locate/analyze/resolve) is the agent's own sub-task work, not
// protocol judging, and stays out of this to avoid misrepresenting it as "validation".
function _isJudgeLabel(label: string | null | undefined): boolean { return label === 'completion:verify' || !!label?.startsWith('validate:'); }

// Central router for single-turn text completions (no tools, no history management).
// All background LLM calls (synthesis, conflict resolution, review, analysis) go through here.
//
// handle behaviour:
//   null   — creates a stepbox from activePlaceholder using opts.label; owns lifecycle
//   object — uses existing handle; sets model/request/output only; caller owns lifecycle
// history: optional OAI-format message array prepended before the prompt (plus the main
// system prompt at position 0). Used by history-aware judges (completion verify): the
// judge sees the full conversation — tool calls AND results — and the request shares the
// main loop's prefix in the server's KV cache, so the marginal cost is ~the output tokens.
async function callLLMComplete(prompt: string, { temperature = getTemperature(), maxTokens = 1024, endpoint = null as any, label = 'worker:llm:text', history = null as any[] | null, maxAttempts = 12 as number } = {}, handle: any = null): Promise<string> {
    const _own = !handle;
    if (!handle) {
        handle = activePlaceholder?.addToolStep([label])?.[0] ?? NULL_TASK_HANDLE;
        handle.setPrompt(prompt.length > 500 ? prompt.slice(0, 497) + '…' : prompt);
    }

    // OAI-compatible
    // Worker calls always use firstFreeEndpoint (the main/vLLM model).
    // Callers that want a lighter model (title gen, prompt suggestions) pass endpoint explicitly.
    let ep = endpoint ?? firstFreeEndpoint() ?? oaiEndpoint();
    handle.setModel(modelFriendlyName(`${ep.provider}|${ep.model}`));
    // Worker/judge calls never think: thinkingBudget 0 → explicit enable_thinking:false on custom.
    // Rebuilt per attempt because the retry handler can rotate ep to a different provider —
    // the old spread-with-model-override kept stale provider quirks across rotations.
    // With history: replicate the main loop's message shape ([system, …history, user])
    // so the request prefix-matches the previous main call in the server's KV cache.
    // Mid-history system messages become <nudge> user turns (strict providers reject
    // system after position 0 — same mapping callOAI applies).
    const _judgeMsgs = history ? [
        { role: 'system', content: buildSystemPrompt() },
        ...history
            .filter(m => m != null && !(m.role === 'assistant' && m.content == null && !m.tool_calls?.length))
            .map(m => m.role === 'system' ? { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` } : m),
        { role: 'user', content: prompt },
    ] : [{ role: 'user', content: prompt }];
    const _buildPayload = () => buildChatPayload(ep, {
        messages: _judgeMsgs,
        temperature,
        maxTokens,
        stream: true,
        thinkingBudget: 0,
    });
    let result = '';
    try {
        let _streaming = '';
        const data = await withRetry(async () => {
            // Build payload inside the lambda: ep may rotate between retries via the
            // retry handler's setEp, so provider-specific fields must be fresh each attempt.
            const payload = _buildPayload();
            _streaming = '';
            const _onChunk = (chunk: string, kind: string) => {
                if (kind === 'output') { _streaming += chunk; handle.setOutput(_streaming); }
            };
            const _data = await callLLM(ep, payload, _onChunk, {
                onRequest: p => handle.setRequest(JSON.stringify(p, null, 2)),
            });
            // Empty stream (no output tokens, no text) — provider swallowed the request
            // (e.g. upstream 429 returned as an empty stream instead of an HTTP error).
            // Treat as truncated so _makeOAIRetryHandler cycles the endpoint with a cooldown.
            if (!_streaming.trim()) {
                const _e: any = new Error('TruncatedResponse(empty:no_content)');
                _e.isTruncated = true;
                throw _e;
            }
            return _data;
        }, _makeOAIRetryHandler({
            getEp: () => ep,
            setEp: e => { ep = e; handle.setModel(modelFriendlyName(`${e.provider}|${e.model}`)); },
            onNote: () => {},
        }), maxAttempts, e => e.isTruncated || isCustomEndpoint(ep));
        result = data.content || '';
        handle.setOutput(result || '(empty)');
        if (_own) result.trim() ? handle.complete() : handle.abort();
        // Judge calls never touch openaiHistory and aren't otherwise logged — this is
        // their only durable record once the live UI step box is gone.
        if (_isJudgeLabel(label) && typeof convoLogTurn === 'function') {
            convoLogTurn({
                type: 'validation', name: label,
                model: ep.model, provider: ep.provider,
                prompt: prompt.length > 500 ? prompt.slice(0, 497) + '…' : prompt, response: result,
                promptTokens: data.usage?.prompt_tokens, responseTokens: data.usage?.completion_tokens,
            });
        }
    } catch (e) {
        handle.setOutput(`Error: ${e.message}`);
        if (_own) handle.abort();
        throw e;
    }
    return result;
}

async function resolveFileConflicts(conflicts: Record<string, Record<string, string>>, snapshot: LazySnapshot | Map<string, string>, handle: any = null): Promise<{resolved: Record<string, string>; stats: {auto: number; llm: number}}> {
    const autoMerged: Record<string, any> = {}, needsLLM: Record<string, any> = {};

    for (const [path, versions] of Object.entries(conflicts)) {
        const sides = Object.values(versions);
        if (sides.length < 2) { autoMerged[path] = sides[0] ?? ''; continue; }
        if (sides.length === 2) {
            const base = (await snapshot.get(path)) ?? '';
            const { merged, conflicts: hasConflicts } = tryMerge(base, sides[0], sides[1]);
            if (!hasConflicts) { autoMerged[path] = merged; continue; }
            needsLLM[path] = { merged, versions };
        } else {
            needsLLM[path] = { merged: null, versions };
        }
    }

    if (!Object.keys(needsLLM).length)
        return { resolved: autoMerged, stats: { auto: Object.keys(autoMerged).length, llm: 0 } };

    const fileDescs = Object.entries(needsLLM).map(([path, { merged, versions }]) => {
        if (merged !== null)
            return `### ${path}\n(conflict markers: <<<<<<< A / ======= / >>>>>>> B)\n\`\`\`\n${merged}\n\`\`\``;
        return `### ${path}\n${Object.entries(versions).map(([id, c]) =>
            `**Worker ${id}:**\n\`\`\`\n${c}\n\`\`\``).join('\n\n')}`;
    }).join('\n\n---\n\n');

    const prompt = `Multiple workers wrote conflicting file versions. Resolve all conflicts and produce the best merged content for each file.\n\n${fileDescs}\n\nReply with a JSON object mapping each filename to its resolved content. Example: {"file.txt": "resolved content"}`;

    // maxTokens must cover full resolved file contents — the callLLMComplete default
    // (1024) truncates any merge over ~4KB mid-JSON, failing the whole resolution.
    // temperature: 0.1 — conflict resolution is deterministic merging; higher temps
    // can introduce hallucinated lines or omissions into the merged file content.
    const text = await callLLMComplete(prompt, { temperature: 0.1, maxTokens: 16384, label: 'worker:resolve:resolve' }, handle ?? null);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not parse conflict resolution response');
    const llmResolved = JSON.parse(match[0]);
    // Merged-content validation (deterministic): this content is written to
    // files, so reject merges that lost most of the content, substituted placeholders,
    // or hallucinated filenames — fall back to the longest source version instead.
    const _longest = versions => Object.values(versions).reduce((a, b) =>
        (String(a ?? '').length >= String(b ?? '').length ? a : b), '');
    for (const [path, content] of Object.entries(llmResolved)) {
        const versions = needsLLM[path]?.versions;
        if (!versions) { delete llmResolved[path]; continue; }        // filename not in the conflict set
        const minLen = Math.min(...Object.values(versions).map(s => String(s ?? '').length));
        const bad = typeof content !== 'string'
            || content.length < minLen * 0.5
            || /\/\/ \.\.\.|\/\* \.\.\. \*\/|rest of (the )?(code|file)|merged content here|\[unchanged\]/i.test(content);
        if (bad) llmResolved[path] = _longest(versions);
    }
    for (const [path, { versions }] of Object.entries(needsLLM))
        if (!(path in llmResolved)) llmResolved[path] = _longest(versions); // dropped by the LLM
    return {
        resolved: { ...autoMerged, ...llmResolved },
        stats: { auto: Object.keys(autoMerged).length, llm: Object.keys(llmResolved).length },
    };
}

// Max steps a worker turn may run — distinct from the main-agent cap (getAgentMaxSteps()).
const _WORKER_MAX_STEPS = 30;

const WORKER_REDUCE_THRESHOLD = 2000; // chars; if total worker text output exceeds this, synthesise

async function reduceWorkerOutputs(outputs: Array<{id: string; text: string}>, handle: any = null): Promise<string> {
    const desc   = outputs.map(o => `### Worker: ${o.id}\n${o.text}`).join('\n\n');
    const prompt = `You received outputs from ${outputs.length} parallel worker agents. Synthesise into one concise summary — key findings, decisions, files written, anything the Director needs to continue. Compress aggressively; omit detail already captured in written files.\n\n${desc}`;
    // temperature: 0.3 — compression/synthesis; slightly creative for fluency but kept
    // low so the summary doesn't drift from the actual worker outputs.
    return await callLLMComplete(prompt, { temperature: 0.3, maxTokens: 2048 }, handle);
}

function parseWorkerStatus(text: string): { status: string; note: string | null; footer: string | null } {
    const match = text.match(/STATUS:\s*(complete|blocked|partial)\s*(?:—\s*(.*))?$/im);
    if (!match) return { status: 'complete', note: null, footer: null };
    const [footer, status, note] = match;
    return { status, note: note?.trim() || null, footer };
}

// Missing STATUS footer: parseWorkerStatus defaults to 'complete' when the
// footer is absent — fail-open in the harmful direction (a rambling or stalled worker
// gets reported complete to the Director). Band check: footer present → trust it;
// no footer → LLM judges whether the output actually reflects completed work.
const _WORKER_STATUS_CHECKS = [{
    name: 'missing_status_footer',
    re_pass: t => /STATUS:\s*(complete|blocked|partial)/im.test(t),
    llmPrompt: 'A worker agent ended its turn with the output below, without the required STATUS footer. Does the output indicate the worker FAILED to complete its assigned work — it stalled, gave up, asked a question instead of acting, or only partially finished? Answer YES (incomplete) or NO (the work appears done).',
}];

async function executeWorkers(args: any): Promise<any> {
    const depth = args.depth || 0;
    // Accept several calling conventions models use instead of {agents:[...]}:
    //   {workers:[...]}         — wrong key name
    //   {id,task,role}          — single agent passed at top level
    //   [{id,task},...}         — args itself is an array
    let rawAgents = args.agents || args.workers
        || (Array.isArray(args) ? args : null)
        || (args.id && args.task ? [args] : null)
        || [];
    // Some models serialize the array as a JSON string — parse it back.
    if (typeof rawAgents === 'string') {
        try { rawAgents = JSON.parse(rawAgents); } catch { rawAgents = []; }
    }
    if (!Array.isArray(rawAgents)) rawAgents = [];
    let agents = rawAgents.filter(a => a && a.id && a.task);
    if (!agents.length) return { error: 'No workers specified.' };

    // Dedup: block an identical run_workers call if the last one failed due to context overflow.
    // Fingerprint = sorted agent ids + task strings (model/role changes are allowed to retry).
    const _callSig = JSON.stringify(agents.map(a => ({ id: a.id, task: a.task })).sort((a, b) => a.id < b.id ? -1 : 1));
    if ((executeWorkers as any)._lastOverflowSig === _callSig) {
        (executeWorkers as any)._lastOverflowSig = null; // clear so it only blocks once per failure
        return { error: 'Blocked: identical run_workers call failed due to context window overflow on the previous attempt. The workers read too much context to fit in the 20k token limit. Split the task into smaller steps that read fewer/smaller files, use path_filter with repo_map, or read specific line ranges with start_line/end_line.' };
    }

    // Assign default role to any worker missing one.
    agents = agents.map(a => a.role ? a : { ...a, role: 'director' });
    // Clamp to known roles: if the model hallucinated a non-existent role name (e.g. "Weather",
    // "kissat"), fall back to director. isRoleEnabled() only checks disabledRoles — it does NOT
    // validate that the name is a known/registered role. rolesRegistry.has() is the correct check.
    agents = agents.map(a => {
        if (!a.role || (rolesRegistry.has(a.role) && isRoleEnabled(a.role))) return a;
        console.error(`[executeWorkers] agent ${a.id} has unknown/disabled role "${a.role}" — falling back to director`);
        return { ...a, role: 'director' };
    });

    // Backpressure: if all active model endpoints are rate-limited, wait before spawning.
    if (!softStopPending) {
        const allSpecs = getActiveMainModelList();
        if (allSpecs.length > 0 && allSpecs.every(spec => getCooldownRemaining(spec) > 0)) {
            const minWaitSec = Math.min(...allSpecs.map(spec => getCooldownRemaining(spec)));
            const waitMs = Math.min(minWaitSec * 1000, 60_000);
            if (waitMs > 500) await sleepInterruptible(waitMs);
        }
    }

    // Strip agent model specs that aren't available (e.g. model names hallucinated by LLM).
    // An unavailable model causes the worker's LLM call to 404-loop indefinitely.
    const _activePool = new Set(getActiveMainModelList());
    agents = agents.map(a => {
        if (!a.model || _activePool.has(a.model)) return a;
        console.error(`[executeWorkers] agent ${a.id} requested unavailable model ${a.model} — falling back to default`);
        const { model: _m, ...rest } = a;
        return rest;
    });

    // Sub-worker calls reuse the parent's snapshot so they share the same consistent view.
    console.error(`[executeWorkers] starting ${agents.length} agents: ${agents.map(a=>a.id).join(',')}`);
    const snapshot = args._parentSnapshot || await takeWorkspaceSnapshot();
    console.error(`[executeWorkers] snapshot taken (${snapshot.size} files), launching workers`);
    const labels   = agents.map(a => a.role ? `worker:${a.id}:${a.role}` : `worker:${a.id}`);

    // activePlaceholder may be null when executeWorkers is called from a background/post-turn
    // context; fall back to no-op stubs so workers run silently without touching the chat UI.
    const ph = activePlaceholder || { addToolStep: labels => labels.map(() => NULL_TASK_HANDLE) };
    const handles  = ph.addToolStep(labels);

    // Pre-assign rotation endpoints to workers that have no explicit model.
    // This ensures no two parallel workers share an endpoint when rotation is on.
    const workerAssignedSpecs = new Map(); // index → spec string
    if (getEndpointRotation() && getActiveMainModelList().length >= 2) {
        const pickedThisRound = new Set<string>();
        for (let i = 0; i < agents.length; i++) {
            if (agents[i].model) continue; // explicit model → skip
            const role = agents[i].role ? ((isRoleEnabled(agents[i].role) ? rolesRegistry.get(agents[i].role) : null) || null) : null;
            const baseSpec = resolveWorkerModelSpec(null, role);
            // Only rotate if the worker would otherwise use the primary pool
            // (i.e., baseSpec resolves to the main model or worker model, not a forced override)
            const spec = _pickFreeRotationSpec(pickedThisRound);
            if (spec) {
                workerAssignedSpecs.set(i, spec);
                pickedThisRound.add(spec);
            }
        }
    }

    // Net-new: persist this run and each agent's outcome to the session-store adapter
    // (SQLite in daemon/headless mode) so background-agent runs become durable/queryable.
    // No-op when no adapter is injected — zero behavior change otherwise.
    const runId = 'wrun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    sessionCreateWorkerRun?.(runId, activeChatId ?? null);

    // Request that forked workers inherit: the calling worker's own last request for nested
    // run_workers calls, otherwise the main agent's last request.
    const forkBase: ForkBase | null = args._parentRequest
        ?? (typeof getLastMainRequest === 'function' ? getLastMainRequest() : null);

    const agentResults = await Promise.all(agents.map(async (agent, i) => {
        const staging = new Map();
        const context = { snapshot, staging, depth };
        const handle  = handles[i];
        const _agentStart = Date.now();
        handle.setPrompt(agent.task);
        // If a rotation endpoint was pre-assigned, mark it busy for the duration.
        const rotationSpec = workerAssignedSpecs.get(i) ?? null;
        if (rotationSpec) _busyEndpointSpecs.add(rotationSpec);
        const MAX_RETRIES = 2;
        let lastError: any;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const role = agent.role ? ((isRoleEnabled(agent.role) ? rolesRegistry.get(agent.role) : null) || null) : null;
                const { output: _rawOut, toolCalls: _wCalls } = await runWorkerTurn(agent.task, context, handle, agent.model || rotationSpec || null, role, forkBase);
                let output = _rawOut;
                let { status, note, footer } = parseWorkerStatus(output || '');
                if (footer) {
                    output = output.replace(footer, '').trim();
                }
                // Treat known failure sentinels as errors — show red badge, not green
                const FAILURE_RE = /^\*\((stall|loop detected|break|stopped:.*|max steps reached)\)\*$/i;
                const isFailed = FAILURE_RE.test((output || '').trim());
                // No footer and no failure sentinel: don't silently default to complete —
                // let the band check judge (fail-open: LLM unavailable keeps old behavior).
                if (!footer && !isFailed && output?.trim()
                    && typeof validateOutput === 'function') {
                    const _vc = await validateOutput(output, _WORKER_STATUS_CHECKS, { llm: callLLMComplete });
                    if (_vc) { status = 'partial'; note = note || 'no STATUS footer; output does not confirm completion'; }
                }
                handle.setOutput(output || '(done)');
                if (isFailed) {
                    handle.abort();
                } else {
                    handle.complete();
                }
                if (rotationSpec) _busyEndpointSpecs.delete(rotationSpec);
                const _agentStatus = isFailed ? 'blocked' : status;
                sessionRecordWorkerAgent?.(runId, {
                    id: agent.id, role: agent.role, model: agent.model || rotationSpec || null, task: agent.task,
                    output: output || '', error: isFailed ? output : null, status: _agentStatus, note,
                    startedAt: _agentStart, finishedAt: Date.now(),
                    staged: [...staging].map(([path, content]) => ({ path, content })),
                });
                return { id: agent.id, output: output || '', staging, error: isFailed ? output : null, status: _agentStatus, note, toolCalls: _wCalls };
            } catch (e) {
                lastError = e;
                // Permanent failures (bad auth, model discontinued, no tool support) — don't retry.
                const isPermanent = /HTTP 40[14]|no endpoints found|invalid model|model.*not.*exist|does not exist/i.test(e.message ?? '');
                if (attempt < MAX_RETRIES && !isPermanent) {
                    // Transient error (stream abort, network) — clear partial staging and retry
                    staging.clear();
                    handle.setOutput(`Error: ${e.message}\n[Retrying… attempt ${attempt + 2} of ${MAX_RETRIES + 1}]`);
                    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                }
            }
        }
        if (rotationSpec) _busyEndpointSpecs.delete(rotationSpec);
        const _isOverflow = /maximum context length/i.test(lastError.message || '');
        const _errMsg = _isOverflow
            ? `Context window overflow: workers read too much context to fit in the token limit. On the next run_workers call with the same tasks, use path_filter with repo_map, read specific line ranges (start_line/end_line), or split into smaller independent sub-tasks.`
            : lastError.message;
        handle.setOutput(`Error: ${_errMsg}`);
        handle.abort();
        sessionRecordWorkerAgent?.(runId, {
            id: agent.id, role: agent.role, model: agent.model || rotationSpec || null, task: agent.task,
            output: '', error: _errMsg, status: 'blocked', note: _errMsg,
            startedAt: _agentStart, finishedAt: Date.now(), staged: [],
        });
        return { id: agent.id, output: '', staging: new Map(), error: _errMsg, status: 'blocked', note: _errMsg, toolCalls: [] };
    }));

    const fileAuthors = new Map();
    for (const { id, staging } of agentResults) {
        for (const [path, content] of staging) {
            if (!fileAuthors.has(path)) fileAuthors.set(path, []);
            fileAuthors.get(path).push({ id, content });
        }
    }

    const clean = {}, conflicts = {};
    for (const [path, authors] of fileAuthors) {
        if (authors.length === 1) clean[path] = authors[0].content;
        else conflicts[path] = Object.fromEntries(authors.map(a => [a.id, a.content]));
    }

    for (const [path, content] of Object.entries(clean)) {
        if (content === null) { try { await agentDeleteFile(path); } catch {} }
        else await agentWriteFile(path, content);
    }

    let resolvedFiles: Record<string, any> = {};
    if (Object.keys(conflicts).length > 0) {
        const mergeHandle = ph.addToolStep(['resolving conflicts'])[0];
        mergeHandle.setPrompt(Object.keys(conflicts).join(', '));
        try {
            const { resolved, stats } = await resolveFileConflicts(conflicts, snapshot, mergeHandle);
            resolvedFiles = resolved;
            for (const [path, content] of Object.entries(resolved))
                await agentWriteFile(path, content);
            const parts = [];
            if (stats.auto > 0) parts.push(`auto: ${stats.auto}`);
            if (stats.llm  > 0) parts.push(`llm: ${stats.llm}`);
            mergeHandle.setOutput(`${Object.keys(resolved).join(', ')} (${parts.join(' · ')})`);
        } catch (e) {
            mergeHandle.setOutput(`Conflict resolution failed: ${e.message}`);
        }
        mergeHandle.complete();
    }

    renderFileList?.();

    const outputs    = agentResults.filter(r => !r.error && r.output?.trim()).map(r => ({ id: r.id, text: r.output }));
    const totalChars = outputs.reduce((s, o) => s + o.text.length, 0);

    let outputField: Record<string, any> = {};
    if (outputs.length > 0) {
        if (getAgentWorkerReduce() && totalChars > WORKER_REDUCE_THRESHOLD) {
            const reduceHandle = ph.addToolStep(['worker:synthesize:synthesize'])[0];
            reduceHandle.setPrompt(`${outputs.length} workers · ${Math.round(totalChars / 1000)}K chars → reducing`);
            try {
                const summary = await reduceWorkerOutputs(outputs, reduceHandle);
                if (summary?.trim()) {
                    reduceHandle.complete();
                    outputField = { summary };
                } else {
                    reduceHandle.setOutput('(empty — using raw outputs)');
                    reduceHandle.complete();
                    outputField = { outputs: Object.fromEntries(outputs.map(o => [o.id, o.text])) };
                }
            } catch (e) {
                reduceHandle.setOutput(`Reduce failed: ${e.message}`);
                reduceHandle.complete();
                outputField = { outputs: Object.fromEntries(outputs.map(o => [o.id, o.text])) };
            }
        } else {
            outputField = { outputs: Object.fromEntries(outputs.map(o => [o.id, o.text])) };
        }
    }

    const blocked = agentResults
        .filter(r => r.status === 'blocked')
        .map(r => ({ id: r.id, reason: r.note }));

    // Files written by blocked workers may be incomplete or wrong — keep separate from applied.
    const blockedFiles = new Set(
        agentResults.filter(r => r.status === 'blocked').flatMap(r => [...r.staging.keys()])
    );
    const applied    = Object.keys(clean).filter(p => !blockedFiles.has(p));
    const incomplete = Object.keys(clean).filter(p =>  blockedFiles.has(p));

    // If every worker blocked due to context overflow, record the call signature so the next
    // identical run_workers call is blocked immediately with a clear explanation.
    const _overflowBlocked = agentResults.filter(r => r.status === 'blocked' && /context window overflow/i.test(r.error || ''));
    if (_overflowBlocked.length === agentResults.length && agentResults.length > 0) {
        (executeWorkers as any)._lastOverflowSig = _callSig;
    }

    // Update stall counters: increment for incomplete files, reset for cleanly applied files.
    if (depth === 0) {
        for (const p of incomplete) _fileStallCounts.set(p, (_fileStallCounts.get(p) || 0) + 1);
        for (const p of applied)    _fileStallCounts.delete(p);
    }

    // Detect stall loops: files that have stalled 2+ times in a row.
    const loopFiles = incomplete.filter(p => (_fileStallCounts.get(p) || 0) >= 2);

    // Auto-read incomplete files so the director can see their current state without a separate step.
    let incompleteContents: Record<string, string> = {};
    if (incomplete.length > 0 && typeof agentReadFile === 'function') {
        await Promise.all(incomplete.map(async p => {
            try {
                const content = await agentReadFile(p);
                if (content != null) incompleteContents[p] = content.slice(0, 3000) + (content.length > 3000 ? '\n…[truncated]' : '');
            } catch {}
        }));
    }

    const result = {
        ...(loopFiles.length > 0
            ? { loop_warning: `${loopFiles.map(p => `"${p}"`).join(', ')} ${loopFiles.length === 1 ? 'has' : 'have'} stalled ${loopFiles.map(p => _fileStallCounts.get(p)).join('/')} times in a row. Do NOT spawn another worker for the same file. Read its current content (shown in incomplete_contents), decide what is wrong with it, and either write it directly or try a completely different approach.` }
            : blocked.length > 0
            ? { warning: `${blocked.length} worker(s) blocked — files in "incomplete" may be partially or incorrectly written. Current content shown in incomplete_contents — read it before deciding next step.` }
            : {}),
        agents:            agentResults
            .map(r => ({ id: r.id, error: r.error, wrote: [...r.staging.keys()], status: r.status, note: r.note,
                         ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}) })),
        applied,
        ...(incomplete.length > 0 ? { incomplete } : {}),
        ...(Object.keys(incompleteContents).length > 0 ? { incomplete_contents: incompleteContents } : {}),
        conflictsFound:    Object.keys(conflicts),
        conflictsResolved: Object.keys(resolvedFiles),
        blocked,
        ...outputField,
    };

    const _runStatus = blocked.length === agentResults.length && agentResults.length > 0
        ? 'blocked' : blocked.length > 0 ? 'partial' : 'complete';
    sessionFinishWorkerRun?.(runId, _runStatus);

    return result;
}

// Window bridge — classic scripts and tests access these as globals.
// setMainAgentRole here takes a role-NAME string (workers.js's API), overriding state.js's setter on window.
Object.assign(window, {
    splitLines, diffRegions, loadRoles, rolesRegistry,
    setMainAgentRole, clearMainAgentRole, restoreRoleForChat, takeWorkspaceSnapshot,
    buildWorkerSystemPrompt, _filterRoleBody,
    callLLMComplete,
    runWorkerTurn, executeWorkers,
});
