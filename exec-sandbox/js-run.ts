// exec-sandbox/js-run.ts — execute_code in JavaScript: the code runs as the body of an async
// function with Node-like console, process, Buffer, require('fs' | 'path' | 'buffer' | 'util') and
// the same /workspace as bash and Python (js-fs.ts). Output is what Node would print: console
// arguments formatted by Node's own util.format, process.stdout.write chunks as written.

import { format, inspect } from 'node-inspect-extracted';
import { createFakeBuffer } from '../shiro/node-compat/buffer';
import { nodeConsole } from '../shiro/node-compat/console';
import { createWorkspaceFs, path, WORKSPACE, type WorkspaceFileData } from './js-fs';

/** Thrown by process.exit to stop the code; carries the exit status. */
class ProcessExit { constructor(readonly code: number) {} }

/**
 * The text of a thrown value for stderr, as Node prints it: "Name: message" and then the stack.
 * V8's `stack` starts with that line; WebKit's (Safari, every iOS browser) holds only the frames, so
 * `String(e.stack)` alone printed "asyncFunctionResume@[native code] … fg-exec-sandbox.js:834:15"
 * with no error in it, and the model re-ran the same code (uploaded chat logs, 2026-10-08: 6 such
 * failures). The sandbox's own frames and native ones say nothing about the code and are dropped.
 */
export function formatThrown(e: any): string {
    const hasMessage = e != null && typeof e === 'object' && e.message != null;
    const head = hasMessage ? `${e.name || 'Error'}: ${e.message}` : String(e);
    const stack = typeof e?.stack === 'string' ? e.stack : '';
    const frames = stack.split('\n').filter(l => l.trim() && !/fg-exec-sandbox|\[native code\]|^anonymous$/.test(l.trim()));
    // V8: the stack's first line already is the head ("TypeError: msg"). WebKit and Firefox stacks hold frames only
    // ("draw@https://…"), and a frame can contain the message (a function or file named like it): only a first line shaped
    // like a head counts.
    const first = stack.split('\n', 1)[0] || '';
    const stackHasHead = hasMessage && (e.message === '' ? first.trim() === (e.name || 'Error')
        : /^[A-Za-z_$][\w$.]*: /.test(first) && first.includes(String(e.message).split('\n', 1)[0]));
    const body = stackHasHead ? frames : [head, ...frames];
    return body.join('\n');
}

// import() reaches the page's module loader, not the workspace: the three engines word the refusal differently and none says what to do instead
// (kanbanflow set 3: a model's `await import('./lib/list.mjs')` died with "Failed to resolve module specifier" and it tried again).
const _IMPORT_HINT = '\n(import() cannot load workspace files in the browser JS sandbox: read the file with require("fs") and run it with the bash tool: node file.mjs)';
const _IMPORT_FAILED_RE = /Failed to resolve module specifier|error loading dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported module|dynamic import callback/;
const thrownText = (e: any): string => formatThrown(e) + (_IMPORT_FAILED_RE.test(String(e?.message ?? e)) ? _IMPORT_HINT : '') + '\n';

export async function runJs(code: string, files: Record<string, WorkspaceFileData>) {
    const stdout: string[] = [], stderr: string[] = [];
    // Writes and deletions made before an error still apply, as they would in the shell.
    const Buffer = createFakeBuffer();
    const { fs, written, deleted } = createWorkspaceFs(files, Buffer);
    const util = { format, inspect };
    const require = (m: string) => {
        const name = m.replace(/^node:/, '');
        if (name === 'fs') return fs;
        if (name === 'fs/promises') return fs.promises;
        if (name === 'path') return path;
        if (name === 'buffer') return { Buffer };
        if (name === 'util') return util;
        throw new Error(`Cannot find module '${m}' — only 'fs', 'fs/promises', 'path', 'buffer' and 'util' are available in the browser JS sandbox`);
    };
    // One streaming decoder per stream: Node writes the bytes through untouched, so a multibyte
    // character split across two writes must come out whole, not as two U+FFFD.
    // Strings (and console output) go through the same decoder as bytes, in order: otherwise a
    // pending partial character is emitted after the text written later.
    const decoders = { out: new TextDecoder(), err: new TextDecoder() };
    const encoder = new TextEncoder();
    const text = (d: TextDecoder, c: any) =>
        ArrayBuffer.isView(c) ? d.decode(c, { stream: true })
            : d.decode(encoder.encode(typeof c === 'string' ? c : String(c)), { stream: true });
    const con = nodeConsole(t => { stdout.push(text(decoders.out, t)); }, t => { stderr.push(text(decoders.err, t)); });
    let exited: number | undefined;   // set by process.exit, also when it is thrown inside code nobody awaits
    const process = {
        env: {}, argv: ['node'], platform: 'linux', exitCode: undefined as number | undefined,
        cwd: () => WORKSPACE,
        exit: (c?: number) => { throw new ProcessExit(exited = c ?? process.exitCode ?? 0); },
        stdout: { write: (c: any) => { stdout.push(text(decoders.out, c)); return true; }, isTTY: false },
        stderr: { write: (c: any) => { stderr.push(text(decoders.err, c)); return true; }, isTTY: false },
    };
    const result = (exit_code: number, extra: Record<string, any> = {}) => {
        // A character still incomplete at exit is flushed (as U+FFFD), like Node's end of stream.
        stdout.push(decoders.out.decode()); stderr.push(decoders.err.decode());
        return { stdout: stdout.join(''), stderr: stderr.join(''), written, deleted: [...deleted], exit_code, failed: exit_code !== 0, ...extra };
    };
    // Node keeps running while timers are pending and a detached `(async () => { … process.exit(1) })()` still ends the process
    // with its code: the code waits for its own timers, and a late exit or throw is the result instead of an unhandled rejection
    // that dropped the output and reported exit 0 (a model's usual test wrapper; seen as a "ProcessExit" page error).
    let pending = 0, lateErr: any;
    const timeout = (f: any, ms?: number, ...a: any[]) => { pending++; return setTimeout(() => { pending--; f(...a); }, ms); };
    const onRejection = (ev: any) => {   // a browser event (preventDefault) or Node's (the reason itself)
        const reason = ev && 'reason' in ev ? ev.reason : ev;
        ev?.preventDefault?.();
        if (!(reason instanceof ProcessExit)) lateErr ??= reason;
    };
    const host = globalThis as any;
    host.addEventListener?.('unhandledrejection', onRejection); host.process?.on?.('unhandledRejection', onRejection);
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('fs', 'require', 'console', 'process', 'Buffer', 'setTimeout', `return (async()=>{ ${code}\n})()`);
        await fn(fs, require, con, process, Buffer, timeout);
        const end = Date.now() + 10000;
        for (let i = 0; i < 3 || (pending > 0 && Date.now() < end); i++) await new Promise(r => setTimeout(r, 0));
        if (exited !== undefined) return result(exited & 0xff);
        if (lateErr !== undefined) { stderr.push(thrownText(lateErr)); return result(1); }
        return result((process.exitCode ?? 0) & 0xff);
    } catch (e: any) {
        if (e instanceof ProcessExit) return result(e.code & 0xff);
        stderr.push(thrownText(e));
        return result(1);
    } finally { host.removeEventListener?.('unhandledrejection', onRejection); host.process?.off?.('unhandledRejection', onRejection); }
}
