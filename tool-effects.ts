// tool-effects.ts — FreeGent: the built-in tools, one row each, and every list derived from them.
//
// Each module kept its own list of tool names (the UI order, the opt-in set, the write tools for approval, the result
// cache, history pruning and verification, the names a pseudo-call may use, the tools whose argument is a path or file
// content) and they drifted: append_file wrote without approval and left cached reads stale because two of the lists
// lacked it, and two "must stay in sync" comments disagreed with the code. A tool is added here once; everything else
// reads these. (Per-tool schemas are in tool-schemas.ts, role ceilings in workers.ts: they say what a tool *is for*, not what it *is*.)
//
// Pure data, no imports: safe to load from any module.

type Effect = 'file' | 'undo' | 'code' | 'files-by-workers';
interface ToolRow {
    name: string;
    /** Off until the person enables it in Settings → Tools; never added by roles, skills or the classifier. */
    optIn?: true;
    /** What the tool changes in the workspace: a named file (`file`), a named file by restoring an earlier version (`undo`), anything (`code`). */
    writes?: Effect;
    /** Its `content` / `new_string` / `patch` argument is file content (a generated payload is legitimately periodic and long). */
    contentArg?: true;
    /** It takes a workspace path in `path`. */
    pathArg?: true;
}

// Order: default-on tools first (shown checked on a fresh install), opt-in tools after (the Settings list order).
const TOOLS: readonly ToolRow[] = [
    { name: 'list_files', pathArg: true }, { name: 'read_file', pathArg: true }, { name: 'search_workspace' },
    { name: 'execute_code', writes: 'code' },
    { name: 'web_search' }, { name: 'fetch_url' },
    { name: 'run_workers', writes: 'files-by-workers' },
    { name: 'generate_image' },
    { name: 'check_page', pathArg: true },
    // Opt-in: filesystem writes (bash does file I/O by default; read_file and search_workspace are default-on for their dedup and compaction-survival benefits).
    { name: 'write_file', optIn: true, writes: 'file', contentArg: true, pathArg: true },
    { name: 'replace_in_file', optIn: true, writes: 'file', contentArg: true, pathArg: true },
    { name: 'apply_patch', optIn: true, writes: 'file', contentArg: true, pathArg: true },
    { name: 'append_file', optIn: true, writes: 'file', contentArg: true, pathArg: true },
    { name: 'delete_file', optIn: true, writes: 'file', pathArg: true },
    { name: 'undo_write', optIn: true, writes: 'undo', pathArg: true },
    // Opt-in: specialist or narrow.
    { name: 'deep_research', optIn: true, writes: 'code' },   // saves its report under research/ (codex R122)
    { name: 'academic_search', optIn: true }, { name: 'package_search', optIn: true }, { name: 'context7_docs', optIn: true },
    { name: 'repo_map', optIn: true }, { name: 'run_git', optIn: true }, { name: 'ast_query', optIn: true, pathArg: true },
    { name: 'update_task_status', optIn: true, pathArg: true },
    ...['navigate', 'snapshot', 'click', 'type', 'select', 'scroll', 'back', 'tabs', 'done'].map(n => ({ name: `browser_${n}`, optIn: true as const })),
];

const names = (keep: (t: ToolRow) => boolean): string[] => TOOLS.filter(keep).map(t => t.name);

/** Every built-in tool, in Settings order. Also the names a pseudo-call (text that is a tool call) may use. */
export const ALL_TOOL_NAMES: string[] = names(() => true);
export const OPT_IN_TOOLS = new Set(names(t => !!t.optIn));

/** Tools that write or delete the file named by their `path` argument. */
export const FILE_WRITE_TOOLS = names(t => t.writes === 'file') as readonly string[];
/** Tools that change a named workspace file, including restoring an earlier version. */
export const WORKSPACE_WRITE_TOOLS = names(t => t.writes === 'file' || t.writes === 'undo') as readonly string[];
/** Tools after which workspace files may differ: the above, and code that can write anything.
 *  (run_workers changes files only through its workers and is handled by its callers.) */
export const MAY_WRITE_TOOLS = [...WORKSPACE_WRITE_TOOLS, ...names(t => t.writes === 'code')] as readonly string[];
/** Tools whose argument is file content, not a short instruction. */
export const CONTENT_ARG_TOOLS = new Set(names(t => !!t.contentArg));
/** Tools whose `path` argument names a workspace file or directory. */
export const PATH_ARG_TOOLS = new Set(names(t => !!t.pathArg));

export const isFileWriteTool = (name: string): boolean => FILE_WRITE_TOOLS.includes(name);
