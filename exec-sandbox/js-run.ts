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
    const decoders = { out: new TextDecoder(), err: new TextDecoder() };
    const text = (d: TextDecoder, c: any) =>
        typeof c === 'string' ? c : ArrayBuffer.isView(c) ? d.decode(c, { stream: true }) : String(c);
    const con = nodeConsole(t => { stdout.push(t); }, t => { stderr.push(t); });
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
        stderr.push(String(e?.stack || e?.message || e) + '\n');
        return result(1);
    }
}
