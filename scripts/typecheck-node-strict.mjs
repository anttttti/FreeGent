// Strict typecheck of the Node-only files (server, sandbox host, runner). The browser modules they import
// are not strict yet, so tsc's full output is filtered to the files listed here; any error in them fails.
// Add a file to STRICT when it is clean; do not add browser modules until they are.
import { spawnSync } from 'node:child_process';

const STRICT = ['dev-api', 'native-exec', 'node-fs-adapter', 'node-sqlite-adapter', 'secret-env', 'request-ledger',
    'dotenv', 'fg-run', 'headless-runner', 'bootstrap-jsdom', 'workspace-scan', 'loop-watch', 'tui-checkpoint', 'safe-log'];
const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.node-strict.json'], { encoding: 'utf8' });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
// "No diagnostic in my files" proves the files are clean only when the compiler ran and checked: a missing process, a signal, a configuration error before any file was
// checked, or a nonzero exit with nothing to explain it would otherwise read as success (codex R66).
if (r.error || r.signal || r.status === null) { console.error(`strict typecheck did not run: ${r.error?.message ?? r.signal ?? 'no exit status'}`); process.exit(1); }
const lines = out.split('\n');
const fileDiag = (l) => /^[^\s(][^(]*\(\d+,\d+\): error TS\d+/.test(l);
const globalDiag = lines.filter(l => /\berror TS\d+/.test(l) && !fileDiag(l));
if (globalDiag.length || (r.status !== 0 && !lines.some(fileDiag))) {
    console.error(globalDiag.length ? globalDiag.join('\n') : out.trim() || '(no output)');
    console.error(`\nstrict typecheck failed without checking the files (exit ${r.status})`); process.exit(1);
}
const mine = lines.filter(l => STRICT.some(f => l.startsWith(`${f}.ts(`)));
if (mine.length) { console.error(mine.join('\n')); console.error(`\n${mine.length} strict-mode error(s) in Node-only files`); process.exit(1); }
console.log(`strict typecheck: ${STRICT.length} Node-only files clean`);
