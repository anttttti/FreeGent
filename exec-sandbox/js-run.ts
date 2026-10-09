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
    // V8: the stack's first line already is the head.
    const body = hasMessage && stack.includes(String(e.message)) ? frames : [head, ...frames];
    return body.join('\n');
}

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
    const process = {
        env: {}, argv: ['node'], platform: 'linux', exitCode: undefined as number | undefined,
        cwd: () => WORKSPACE,
        exit: (c?: number) => { throw new ProcessExit(c ?? process.exitCode ?? 0); },
        stdout: { write: (c: any) => { stdout.push(text(decoders.out, c)); return true; }, isTTY: false },
        stderr: { write: (c: any) => { stderr.push(text(decoders.err, c)); return true; }, isTTY: false },
    };
    const result = (exit_code: number, extra: Record<string, any> = {}) => {
        // A character still incomplete at exit is flushed (as U+FFFD), like Node's end of stream.
        stdout.push(decoders.out.decode()); stderr.push(decoders.err.decode());
        return { stdout: stdout.join(''), stderr: stderr.join(''), written, deleted: [...deleted], exit_code, failed: exit_code !== 0, ...extra };
    };
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('fs', 'require', 'console', 'process', 'Buffer', `return (async()=>{ ${code}\n})()`);
        await fn(fs, require, con, process, Buffer);
        return result((process.exitCode ?? 0) & 0xff);
    } catch (e: any) {
        if (e instanceof ProcessExit) return result(e.code & 0xff);
        stderr.push(formatThrown(e) + '\n');
        return result(1);
    }
}
