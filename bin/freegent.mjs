#!/usr/bin/env node
// freegent — one command for the terminal UI and the command-line (pipeline) form. See route.mjs for which runs when.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, HELP } from './route.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = route(process.argv.slice(2), { stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY });

if (r.program === 'help') { console.log(HELP); process.exit(0); }
if (r.program === 'version') { console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version); process.exit(0); }

const entry = join(root, r.program === 'tui' ? 'fg-tui.tsx' : 'fg-run.ts');
// The TypeScript sources run through tsx; it is resolved from this package, not from the directory the command is run in.
let loader;
try { loader = import.meta.resolve('tsx'); }
catch { console.error('freegent: the "tsx" package is not installed here. Run `npm install` in ' + root); process.exit(1); }

const child = spawn(process.execPath, ['--import', loader, entry, ...r.args], {
    stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? '1' },
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1) : 1)));
