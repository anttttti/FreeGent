// finish-summary.ts — what a finished headless run can say about the files it changed, from the tool log and the disk, not from
// the model's own account. The self-analysis runs had five runs that ended with a file emptied or unparseable and a
// final message that did not say so. The changed paths come from verification.ts (the same record that decides `verification`).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, extname } from 'node:path';

export interface ChangedFile { path: string; problem: string | null }

let _ts: any | undefined;
async function _typescript(): Promise<any | null> {
    if (_ts !== undefined) return _ts;
    try { _ts = (await import('typescript' as string)).default ?? (await import('typescript' as string)); } catch { _ts = null; }
    return _ts;
}

/** `null` when the file looks fine; otherwise what is wrong with it: gone, empty, or a syntax error. Only obvious breakage is reported. */
async function problemWith(abs: string): Promise<string | null> {
    if (!existsSync(abs)) return 'no longer exists';
    let st; try { st = statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    if (st.size === 0) return 'EMPTY (0 bytes)';
    if (st.size > 2_000_000) return null;
    const ext = extname(abs).toLowerCase();
    let text: string; try { text = readFileSync(abs, 'utf8'); } catch { return null; }
    if (ext === '.json') { try { JSON.parse(text); } catch (e: any) { return `invalid JSON (${String(e?.message ?? e).slice(0, 80)})`; } return null; }
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        const ts = await _typescript();
        if (!ts) return null;
        try {
            const out = ts.transpileModule(text, { reportDiagnostics: true, fileName: abs, compilerOptions: { allowJs: true, jsx: ts.JsxEmit?.Preserve } });
            const d = (out.diagnostics ?? []).find((x: any) => x.category === ts.DiagnosticCategory?.Error);
            if (!d) return null;
            const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
            return `syntax error${pos ? ` at line ${pos.line + 1}` : ''}: ${String(ts.flattenDiagnosticMessageText(d.messageText, ' ')).slice(0, 80)}`;
        } catch { return null; }
    }
    return null;
}

/** The files the run changed (workspace-relative where they are inside it), each with its problem or null. */
export async function checkChangedFiles(root: string, files: Iterable<string>): Promise<ChangedFile[]> {
    const seen = new Set<string>(), out: ChangedFile[] = [];
    for (const f of files) {
        const abs = isAbsolute(f) ? f : join(root, f);
        const rel = relative(root, abs);
        const shown = rel && !rel.startsWith('..') ? rel : abs;
        if (seen.has(shown)) continue;
        seen.add(shown);
        out.push({ path: shown, problem: await problemWith(abs) });
    }
    return out;
}

/** Lines for stderr at the end of a workflow run; empty when nothing was changed and the run completed. */
export function finishLines(finish: { signal: string; stopReason: string | null; timedOut: boolean; verification: string }, files: ChangedFile[]): string[] {
    const lines: string[] = [];
    const how = finish.signal === 'complete' ? 'complete' : `${finish.signal}${finish.stopReason ? ` (${finish.stopReason})` : finish.timedOut ? ' (time limit)' : ''}`;
    if (finish.signal !== 'complete' || files.length) lines.push(`[fg-run] finished: ${how}; verification: ${finish.verification}`);
    if (files.length) {
        const shown = files.slice(0, 20).map(f => f.problem ? `${f.path} [${f.problem}]` : f.path).join(', ');
        lines.push(`[fg-run] changed ${files.length} file${files.length === 1 ? '' : 's'}: ${shown}${files.length > 20 ? ', ...' : ''}`);
        const bad = files.filter(f => f.problem);
        if (bad.length) lines.push(`[fg-run] WARNING: ${bad.length} changed file${bad.length === 1 ? ' is' : 's are'} broken: ${bad.map(f => f.path).join(', ')}`);
    }
    return lines;
}
