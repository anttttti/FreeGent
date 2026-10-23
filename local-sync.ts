// local-sync.ts — pure planning for syncing the imported Local Folder snapshot (local/ records) with the Workspace.
// A browser without the File System Access API (Safari, Firefox) cannot watch a folder: the folder is imported as a
// snapshot, so reconciling is a diff of two path→hash maps against the state the last sync left (the base).

export type SyncAction = 'to-workspace' | 'to-local' | 'keep-both' | 'merge' | 'delete-workspace' | 'delete-local' | 'skip';
export type SyncKind =
    | 'new-in-local' | 'new-in-workspace'
    | 'changed-in-local' | 'changed-in-workspace'
    | 'conflict'
    | 'removed-from-local' | 'removed-from-workspace';

export interface SyncItem {
    path: string;
    kind: SyncKind;
    /** What happens unless the user picks another. Never deletes a file. */
    action: SyncAction;
    /** The actions the dialog offers for this row, default first. */
    choices: SyncAction[];
}

/** Fast 53-bit string hash (cyrb53): enough to tell two versions apart, not for security. */
export function hashContent(s: string): string {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}

/**
 * Diff the Workspace against the Local snapshot. Maps are relative path → content hash (no `local/` prefix).
 * `base` is the hash each path had when the two sides last agreed; without it (first sync) nothing counts as removed.
 * Defaults are non-destructive: a removal is answered by restoring the file, and a conflict keeps both versions.
 * `merges` holds the result of a three-way text merge per conflicting path: a clean one becomes the default for that file,
 * one with overlapping edits is offered but not chosen (it would put conflict markers into both sides).
 */
export function planSync(workspace: Record<string, string>, local: Record<string, string>, base: Record<string, string> = {}, merges: Record<string, { conflicts: boolean }> = {}): SyncItem[] {
    const out: SyncItem[] = [];
    const paths = new Set([...Object.keys(workspace), ...Object.keys(local)]);
    for (const path of [...paths].sort()) {
        const w = workspace[path], l = local[path], b = base[path];
        if (w !== undefined && l !== undefined) {
            if (w === l) continue;
            if (b === w) out.push({ path, kind: 'changed-in-local', action: 'to-workspace', choices: ['to-workspace', 'to-local', 'skip'] });
            else if (b === l) out.push({ path, kind: 'changed-in-workspace', action: 'to-local', choices: ['to-local', 'to-workspace', 'skip'] });
            else if (merges[path] && !merges[path].conflicts) out.push({ path, kind: 'conflict', action: 'merge', choices: ['merge', 'keep-both', 'to-local', 'to-workspace', 'skip'] });
            else if (merges[path]) out.push({ path, kind: 'conflict', action: 'keep-both', choices: ['keep-both', 'merge', 'to-local', 'to-workspace', 'skip'] });
            else out.push({ path, kind: 'conflict', action: 'keep-both', choices: ['keep-both', 'to-local', 'to-workspace', 'skip'] });
        } else if (w !== undefined) {
            if (b === undefined) out.push({ path, kind: 'new-in-workspace', action: 'to-local', choices: ['to-local', 'skip'] });
            else out.push({ path, kind: 'removed-from-local', action: 'to-local', choices: ['to-local', 'delete-workspace', 'skip'] });
        } else if (l !== undefined) {
            if (b === undefined) out.push({ path, kind: 'new-in-local', action: 'to-workspace', choices: ['to-workspace', 'skip'] });
            else out.push({ path, kind: 'removed-from-workspace', action: 'to-workspace', choices: ['to-workspace', 'delete-local', 'skip'] });
        }
    }
    return out;
}

/** The name a conflicting local version is kept under in the workspace: `a/b.txt` → `a/b (local).txt`. */
export function keepBothName(path: string, taken: (name: string) => boolean, tag = 'local'): string {
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash + 1), file = path.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : '';
    let name = `${dir}${stem} (${tag})${ext}`;
    for (let n = 2; taken(name); n++) name = `${dir}${stem} (${tag} ${n})${ext}`;
    return name;
}

/** The base after applying a plan: paths both sides agree on at their hash; a path left unresolved keeps the base it had, so it is still read correctly next time. */
export function nextBase(workspace: Record<string, string>, local: Record<string, string>, prev: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {};
    for (const p of new Set([...Object.keys(workspace), ...Object.keys(local)])) {
        if (workspace[p] !== undefined && workspace[p] === local[p]) base[p] = workspace[p];
        else if (prev[p] !== undefined) base[p] = prev[p];
    }
    return base;
}

/** Local paths that differ from the folder as imported (new or edited): what has to travel back to the folder. */
export function changedSinceImport(local: Record<string, string>, imported: Record<string, string>): string[] {
    return Object.keys(local).filter(p => imported[p] !== local[p]).sort();
}
