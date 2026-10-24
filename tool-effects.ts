// tool-effects.ts — FreeGent: which tools change workspace files, in one place.
//
// Approval ("All writes"), the per-turn result cache, history pruning and the role-refusal message
// each kept their own list of write tools, and they drifted: append_file wrote without approval
// and left cached reads stale because two of the lists lacked it. Every such list is built from
// these. A new file-writing tool is added here once.
//
// Pure data, no imports: safe to load from any module.

/** Tools that write or delete the file named by their `path` argument. */
export const FILE_WRITE_TOOLS = ['write_file', 'append_file', 'apply_patch', 'replace_in_file', 'delete_file'] as const;

/** Tools that change a named workspace file, including restoring an earlier version. */
export const WORKSPACE_WRITE_TOOLS = [...FILE_WRITE_TOOLS, 'undo_write'] as const;

/** Tools after which workspace files may differ: the above, and code that can write anything.
 *  (run_workers changes files only through its workers and is handled by its callers.) */
export const MAY_WRITE_TOOLS = [...WORKSPACE_WRITE_TOOLS, 'execute_code', 'deep_research'] as const;   // deep_research saves its report under research/ (codex R122)

export const isFileWriteTool = (name: string): boolean => (FILE_WRITE_TOOLS as readonly string[]).includes(name);
