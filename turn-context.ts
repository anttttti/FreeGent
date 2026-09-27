// turn-context.ts — FreeGent: per-turn context evaluation shared by every entry point.
//
// Skill-trigger evaluation, tool-group gating, and guidance composition used to live inline
// in agentSend — the DOM send path. Headless runs (benchmarks, the TUI, agent-loop) call
// runAgentTurn directly, so none of it ever ran: currentTurnSkills stayed empty for the
// whole run, so buildTriggeredGuidance() returned '' at its size guard and the turn-start
// half of the trigger table (trigger, trigger_on_filetype/_event/_media/_file_present/
// _message_pattern/_history_tool/_turn) was dead. currentTurnToolExtras never got the
// '_ready' sentinel either, so _inGroup() short-circuited true and every tool group was
// permanently on — while context7, which gates the other way on extras.has('context7'),
// was permanently unreachable. Benchmarks were measuring a different agent than the UI.
//
// Same bug class as the payload-builder split: two call sites, one missing the logic.
// Follows the payload-builder/step-validator pattern: ES module, exports, window bridge.

import {
    currentTurnSkills, setCurrentTurnSkills,
    mainAgentRole, pendingAgentsContextInject,
    setPendingAgentsContextInject,
} from './state.js';

// ── Task-intent detection ──────────────────────────────────────────────────
// True when the user's message asks the agent to complete/work on tasks. Feeds the
// trigger table's `isTaskCompletion` input, which activates the director role and the
// Kanban process.
export function _isCompletionRequest(text: string): boolean {
    // Explicit task file path or ID reference (e.g. "fg-tasks/038-...", "#038", "task 38")
    if (/(?:fg-)?tasks\/\d+|#\s*\d{2,}|\btask\s+\d+/i.test(text)) return true;
    // Action verb + "task(s)" — exclude short ambiguous verbs ("do", "run") that produce false triggers
    if (/\b(complet\w*|work\s+on|process\w*|execut\w*|implement\w*|finish\w*|handl\w*|pick\s+up|tackl\w*)\b.{0,60}\btasks?\b/i.test(text)) return true;
    if (/\btasks?\b.{0,60}\b(complet\w*|work\s+on|process\w*|execut\w*|implement\w*|finish\w*|handl\w*|tackl\w*)/i.test(text)) return true;
    // Natural phrasings
    if (/\bnext\s+task\b|\bopen\s+task\b|\bpending\s+task\b|\bwork\s+through\b/i.test(text)) return true;
    // The agent loop's own prompt prefix — already handled, but guard anyway
    if (text.startsWith('Process this task file')) return true;
    return false;
}

// Three-band version (step-validator.ts) for interactive turns. The regex above fires; a message
// with no task vocabulary at all passes (most messages — no model call); a message that mentions
// tasks/backlog/tickets/#N without matching goes to a yes/no model call. The regex alone missed
// phrasings like "start on the backlog", "do #3 next" or "clear the remaining tickets".
const _TASK_VOCAB_RE = /\b(?:tasks?|backlog|tickets?|to-?dos?|kanban|fg-tasks)\b|#\s*\d+/i;
const _TASK_INTENT_CHECKS = [{
    name: 'task_completion_request',
    max: Infinity,
    re_fail: (t: string) => _isCompletionRequest(t),
    re_pass: (t: string) => !_TASK_VOCAB_RE.test(t),
    llmPrompt: 'The message below was sent by a user to an AI agent that keeps a task list (a backlog of task files). Does the message ask the agent to work on, continue, complete, or process items from that task list or backlog — as opposed to a general request that merely mentions the word "task"? Answer YES or NO.',
}];
export async function isTaskCompletionRequest(text: string, llm: any = typeof callLLMComplete === 'function' ? callLLMComplete : null): Promise<boolean> {
    const t = String(text ?? '');
    if (typeof validateOutput !== 'function') return _isCompletionRequest(t);
    return !!(await validateOutput(t, _TASK_INTENT_CHECKS, { llm, maxTokens: 200 }));
}

// ── Workspace index ────────────────────────────────────────────────────────
// Derive the trigger-matching index from a list of workspace paths. Pure: the caller
// supplies the paths, so this stays testable and free of DOM/adapter concerns.
export function buildWorkspaceIndex(paths: string[]): {
    wsExts: Set<string>; wsNames: Set<string>; wsAllPaths: Set<string>;
} {
    const wsExts = new Set<string>(), wsNames = new Set<string>(), wsAllPaths = new Set<string>();
    for (const raw of paths) {
        const full = String(raw ?? '').toLowerCase();
        if (!full) continue;
        wsAllPaths.add(full);
        const n = full.split('/').pop() as string;
        wsNames.add(n);                                   // basename (Makefile, package.json)
        const d1 = n.lastIndexOf('.');
        if (d1 >= 0) {
            wsExts.add(n.slice(d1));                      // e.g. ".js"
            const d2 = n.lastIndexOf('.', d1 - 1);
            if (d2 >= 0) wsExts.add(n.slice(d2));         // e.g. ".test.js"
        }
    }
    return { wsExts, wsNames, wsAllPaths };
}

// Workspace paths for trigger matching.
// Prefers agentListFilesInDir('') over agentListFiles() — the former skips stat()
// calls on each file (halves I/O on slow/mounted filesystems).
// Result is cached for 30 s: skill-trigger matching only needs file extensions and
// names, so a brief stale view is fine and avoids repeating the walk every turn.
let _pathCache: { paths: string[]; at: number } | null = null;
const _PATH_CACHE_MS = 30_000;
export async function collectWorkspacePaths(): Promise<string[]> {
    const now = Date.now();
    if (_pathCache && now - _pathCache.at < _PATH_CACHE_MS) return _pathCache.paths;
    // agentListFilesNoStat() walks the whole workspace, skips stat() syscalls, and
    // applies the standard exclusion list (node_modules, dist, .git, …).
    // agentListFilesInDir('') has NO exclusion list and would walk node_modules,
    // burying the event loop in thousands of callbacks on large projects.
    try {
        const files: Array<{ name: string }> =
            typeof agentListFilesNoStat === 'function' ? await agentListFilesNoStat()
            : typeof agentListFiles     === 'function' ? await agentListFiles()
            : [];
        const paths = files.map((f: any) => f.name);
        _pathCache = { paths, at: now };
        return paths;
    } catch { return []; }
}

// ── Per-turn trigger evaluation ────────────────────────────────────────────
// Sets currentTurnSkills for the turn about to run. Call before pushing the user message.
export function applyTurnTriggers({
    rawText,
    history   = [] as any[],
    wsPaths   = [] as string[],
    msgMedia  = new Set<string>(),
    isTaskCompletion = null as boolean | null,
}: {
    rawText: string;
    history?: any[];
    wsPaths?: string[];
    msgMedia?: Set<string>;
    // Precomputed by the caller (await isTaskCompletionRequest); null → the regex decides.
    isTaskCompletion?: boolean | null;
}): void {
    const { wsExts, wsNames, wsAllPaths } = buildWorkspaceIndex(wsPaths);

    // Tool names seen anywhere in history (for trigger_on_history_tool).
    const histTools = new Set<string>();
    for (const msg of history)
        for (const tc of (msg?.tool_calls || []))
            if (tc.function?.name) histTools.add(tc.function.name);

    // In Cowork mode the tasks skill is always active — the keyword "task" need not appear.
    // Build an augmented seed so evaluateSkillTriggers starts with it already fired.
    const _coworkSeed = (typeof getMode === 'function' && getMode() === 'cowork' && skillsRegistry.has('tasks'))
        ? new Set([...activeSkills, 'tasks'])
        : activeSkills;
    setCurrentTurnSkills(evaluateSkillTriggers(skillsRegistry, _coworkSeed, {
        roleName:         mainAgentRole?.name?.toLowerCase() ?? null,
        lowerText:        rawText.toLowerCase(),
        rawText,
        firstMsg:         history.length === 0,
        isTaskCompletion: isTaskCompletion ?? _isCompletionRequest(rawText),
        turn:             Math.floor(history.length / 2),
        wsExts, wsNames, wsAllPaths, msgMedia, histTools,
    }));
}

// ── Turn prelude ───────────────────────────────────────────────────────────
// Guidance + context blocks prepended to the user message stored in history (never to the
// system prompt, which stays byte-stable for the vLLM prefix cache). Returns '' when
// nothing fired. Call after applyTurnTriggers — it reads currentTurnSkills.
export async function buildTurnPrelude({
    text,
    isFirstTurn,
    fileNames = [] as string[],
}: {
    text: string;
    isFirstTurn: boolean;
    fileNames?: string[];
}): Promise<string> {
    const guidance = buildTriggeredGuidance();

    const agentsCtxBlock = (isFirstTurn || pendingAgentsContextInject) && agentsContext
        ? `<project_instructions>\n${agentsContext}\n</project_instructions>` : '';
    if (agentsCtxBlock) setPendingAgentsContextInject(false);

    // First turn, every mode (chat, Cowork, runner, headless benchmarks): inject a compact
    // workspace listing so the agent knows what exists without spending a step on list_files.
    // Benchmark logs (v0.55) showed the model opening ~70–100% of file-based tasks with a
    // listing call (a full LLM round trip), and the listing coming back empty on API-style
    // suites (TAC, AutomationBench) and fresh Cowork chats.
    let wsFilesBlock = '';
    if (isFirstTurn) {
        try {
            const inContainer = typeof fgTargetContainer !== 'undefined' && !!fgTargetContainer;
            wsFilesBlock = formatWorkspaceListing(await collectWorkspacePaths(), { inContainer });
        } catch {}
    }

    return [wsFilesBlock, agentsCtxBlock, guidance].filter(Boolean).join('\n\n');
}

// Budget for the first-turn listing. The full listing of a SWE-bench repo is ~20K chars; past
// the budget the listing collapses to per-directory file counts.
const _WS_LIST_MAX_PATHS = 60;
const _WS_LIST_MAX_CHARS = 3000;

// Render workspace paths as a <workspace_files> block: the full sorted list when small,
// otherwise directories with file counts (expanded one level at a time while within budget)
// plus the root-level files. Returns '' when nothing reliable can be said.
//   inContainer: paths come from `find` inside a task container — an empty result there can
//   mean the listing failed, so it is not reported as an empty workspace.
export function formatWorkspaceListing(rawPaths: string[], { inContainer = false } = {}): string {
    const raw = (rawPaths || []).filter(p => typeof p === 'string' && p);
    // Adapter notes ("[listing truncated at 500 entries — …]") are not paths, but say the
    // listing is incomplete.
    const truncated = raw.some(p => p.startsWith('[') && /truncat/i.test(p));
    const sorted = [...new Set(raw.filter(p => !p.startsWith('[')).map(p => p.replace(/\/+$/, '')))].sort();
    // `find` (container adapter) also emits each directory as an entry: drop entries that
    // are a parent of the next one, so only files remain.
    const paths = sorted.filter((p, i) => !(sorted[i + 1]?.startsWith(p + '/')));
    const wrap = (body: string) => `<workspace_files>\n${body}\n</workspace_files>`;
    const count = `${paths.length}${truncated ? '+' : ''} file${paths.length === 1 && !truncated ? '' : 's'}${truncated ? ' (listing truncated)' : ''}`;
    if (!paths.length) {
        return inContainer ? '' : wrap('(empty — the workspace has no files yet)');
    }
    const full = paths.join('\n');
    if (paths.length <= _WS_LIST_MAX_PATHS && full.length <= _WS_LIST_MAX_CHARS) {
        return wrap(`${count}:\n${full}`);
    }

    // Collapse to directories at increasing depth, keeping the deepest rendering that fits.
    const lead = paths[0].startsWith('/') ? 1 : 0;   // absolute container paths: skip the '' segment
    const render = (depth: number): string[] => {
        const dirs = new Map<string, number>();
        const files: string[] = [];
        for (const p of paths) {
            const segs = p.split('/');
            if (segs.length - lead <= depth) { files.push(p); continue; }
            const d = segs.slice(0, lead + depth).join('/') + '/';
            dirs.set(d, (dirs.get(d) ?? 0) + 1);
        }
        return [
            ...[...dirs].map(([d, n]) => `${d} (${n} file${n === 1 ? '' : 's'})`),
            ...files,
        ].sort();
    };
    let lines = render(1);
    for (let depth = 2; depth <= 4; depth++) {
        const next = render(depth);
        if (next.length > _WS_LIST_MAX_PATHS || next.join('\n').length > _WS_LIST_MAX_CHARS) break;
        lines = next;
    }
    let body = lines.join('\n');
    if (body.length > _WS_LIST_MAX_CHARS) {
        const kept: string[] = [];
        let len = 0;
        for (const l of lines) { if (len + l.length + 1 > _WS_LIST_MAX_CHARS) break; kept.push(l); len += l.length + 1; }
        body = `${kept.join('\n')}\n… ${lines.length - kept.length} more entries`;
    }
    return wrap(`${count} — directories shown with file counts; use list_files with a path filter for details:\n${body}`);
}

Object.assign(window, {
    _isCompletionRequest, isTaskCompletionRequest, buildWorkspaceIndex, collectWorkspacePaths,
    applyTurnTriggers, buildTurnPrelude,
});
