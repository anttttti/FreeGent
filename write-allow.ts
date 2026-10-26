// write-allow.ts — FreeGent: path allowlist for the file-writing tools (fg-run --write-allow).
//
// When a list is set, write_file, append_file, replace_in_file, apply_patch, delete_file and undo_write may only
// touch the listed files and directories; any other path is refused before anything is written, with a message
// that names the allowed paths so the model can send the call again. For runs whose task says "write only in out/":
// an analysis or test-writing run that rewrote a product file (self-analysis W7r2: a full write_file of
// storage-usage.ts with its backslashes doubled) is stopped at the call instead of being found by a diff afterwards.
//
// Like --fetch-allow this is request policy, not containment: execute_code can still write anywhere the process
// can. No list (the default) → the tools behave exactly as before.

let _allowed: string[] | null = null;

const _norm = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/^\/workspace\//, '').replace(/^\/+/, '');

/** Comma-separated workspace-relative files or directories ("out/", "notes/report.md"). Throws on an empty list or on `..` / absolute-looking entries that cannot be matched. */
export function parseWriteAllow(spec: string): string[] {
    const entries = spec.split(',').map(s => _norm(s.trim())).filter(Boolean);
    if (!entries.length) throw new Error('--write-allow: no paths given');
    for (const e of entries) if (e.split('/').includes('..')) throw new Error(`--write-allow: ".." is not allowed in ${e}`);
    return entries.map(e => e.replace(/\/+$/, ''));
}

export function setWriteAllow(entries: string[] | null): void { _allowed = entries; }
export function isWriteAllowActive(): boolean { return _allowed !== null; }

/** Error text when `path` is outside the allowed paths, else null. */
export function checkWriteAllowed(toolName: string, path: unknown): string | null {
    if (!_allowed) return null;
    const p = _norm(String(path ?? ''));
    if (!p || p.split('/').includes('..')) return `${toolName}: ${String(path)} is outside the paths this run may write. Allowed: ${_allowed.join(', ')}. Nothing was written.`;
    if (_allowed.some(a => p === a || p.startsWith(a + '/'))) return null;
    return `${toolName}: ${p} is outside the paths this run may write. Allowed: ${_allowed.join(', ')}. Nothing was written; send the call again with a path inside them.`;
}
