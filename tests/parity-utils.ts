// Shared by the browser sides of scripts/shell-diff.sh and scripts/exec-diff.sh: loading the
// fixtures as workspace records and reporting the files a case changed, in the same format as
// the scripts' file_changes (bash side).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** A workspace record as IndexedDB holds it: text, or binary as base64. */
export type WsRecord = { content: string; encoding: string | null };

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A file's bytes as the workspace stores them: UTF-8 text without NULs as text, else base64. */
export function toRecord(bytes: Uint8Array): WsRecord {
    if (!bytes.includes(0)) {
        try { return { content: strictUtf8.decode(bytes), encoding: null }; } catch { /* not UTF-8 */ }
    }
    return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
}

export function recordBytes(r: WsRecord): Buffer {
    return r.encoding === 'base64' ? Buffer.from(r.content, 'base64') : Buffer.from(r.content, 'utf8');
}

/** Every file under a directory, by relative path. */
export function readTree(dir: string, root = dir, out = new Map<string, Buffer>()) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) readTree(p, root, out);
        else out.set(relative(root, p), readFileSync(p));
    }
    return out;
}

/**
 * A real Pyodide (the npm build of the version the browser loads from the CDN). The tests run
 * under jsdom, where Pyodide would take itself for a web page and fetch its files over HTTP:
 * `window` is hidden while it starts, so it loads them from node_modules.
 */
export async function loadNodePyodide(): Promise<any> {
    const { loadPyodide } = await import('pyodide');
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
    try {
        return await loadPyodide();
    } finally {
        if (desc) Object.defineProperty(globalThis, 'window', desc); else delete (globalThis as any).window;
    }
}

const sha256 =(b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * The workspace changes a case made, as the bash side prints them: "file:./<path>\t<sha256>"
 * for each new or changed file, "file:./<path>\tdeleted" for each removed one, sorted by byte.
 */
export function fileChanges(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): string {
    const lines: string[] = [];
    for (const [name, bytes] of after) {
        const was = before.get(name);
        if (!was || sha256(was) !== sha256(bytes)) lines.push(`file:./${name}\t${sha256(bytes)}`);
    }
    for (const name of before.keys()) if (!after.has(name)) lines.push(`file:./${name}\tdeleted`);
    return lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(l => l + '\n').join('');
}
