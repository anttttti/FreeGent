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
}: {
    rawText: string;
    history?: any[];
    wsPaths?: string[];
    msgMedia?: Set<string>;
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
        isTaskCompletion: _isCompletionRequest(rawText),
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

    return [guidance, agentsCtxBlock].filter(Boolean).join('\n\n');
}

Object.assign(window, {
    _isCompletionRequest, buildWorkspaceIndex, collectWorkspacePaths,
    applyTurnTriggers, buildTurnPrelude,
});
