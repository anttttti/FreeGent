// Strict typecheck of the Node-only files (server, sandbox host, runner). The browser modules they import
// are not strict yet, so tsc's full output is filtered to the files listed here; any error in them fails.
// Add a file to STRICT when it is clean; do not add browser modules until they are.
import { spawnSync } from 'node:child_process';

const STRICT = ['dev-api', 'native-exec', 'node-fs-adapter', 'node-sqlite-adapter', 'secret-env', 'request-ledger',
    'dotenv', 'fg-run', 'headless-runner', 'bootstrap-jsdom', 'workspace-scan', 'loop-watch', 'tui-checkpoint', 'safe-log'];
const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.node-strict.json'], { encoding: 'utf8' });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const mine = out.split('\n').filter(l => STRICT.some(f => l.startsWith(`${f}.ts(`)));
if (mine.length) { console.error(mine.join('\n')); console.error(`\n${mine.length} strict-mode error(s) in Node-only files`); process.exit(1); }
console.log(`strict typecheck: ${STRICT.length} Node-only files clean`);
