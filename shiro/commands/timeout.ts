import type { Command } from './index';
import { runSubcommand } from './run-subcommand';

const USAGE = 'Usage: timeout [OPTION] DURATION COMMAND [ARG]...\n';

function parseDuration(str: string): number | null {
  const m = str.match(/^(\d+(?:\.\d+)?|\.\d+)(s|m|h|d)?$/);
  if (!m) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's') as 's'];
  return parseFloat(m[1]) * mult;
}

const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, ALRM: 14, TERM: 15, CONT: 18 };

function parseSignal(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return SIGNALS[s.replace(/^SIG/, '').toUpperCase()] ?? null;
}

export const timeout: Command = {
  name: 'timeout',
  description: 'Run a command with a time limit',
  async exec(ctx) {
    const a = ctx.args;
    let signal = 15, killAfter = 0, preserve = false, verbose = false;
    let i = 0;
    for (; i < a.length && a[i].startsWith('-') && a[i] !== '-'; i++) {
      const o = a[i];
      if (o === '--') { i++; break; }
      if (o === '--preserve-status') preserve = true;
      else if (o === '--foreground') { /* no job control here: same thing */ }
      else if (o === '-v' || o === '--verbose') verbose = true;
      else if (o === '--help') { ctx.stdout += USAGE; return 0; }
      else if (o === '-s' || o === '--signal' || o.startsWith('--signal=') || o === '-k' || o === '--kill-after' || o.startsWith('--kill-after=')) {
        const isSig = o === '-s' || o.startsWith('--s');
        const val = o.includes('=') ? o.slice(o.indexOf('=') + 1) : a[++i];
        if (val === undefined) { ctx.stderr += `timeout: option requires an argument -- '${o.replace(/^-+/, '')[0]}'\n${USAGE}`; return 125; }
        if (isSig) {
          const n = parseSignal(val);
          if (n === null) { ctx.stderr += `timeout: ${val}: invalid signal\n`; return 125; }
          signal = n;
        } else {
          const d = parseDuration(val);
          if (d === null) { ctx.stderr += `timeout: invalid time interval '${val}'\n`; return 125; }
          killAfter = d;
        }
      } else { ctx.stderr += `timeout: invalid option -- '${o.replace(/^-+/, '')}'\n${USAGE}`; return 125; }
    }
    if (i >= a.length) { ctx.stderr += `timeout: missing operand\n${USAGE}`; return 125; }
    const duration = parseDuration(a[i]);
    if (duration === null) { ctx.stderr += `timeout: invalid time interval '${a[i]}'\n`; return 125; }
    const argv = a.slice(i + 1);
    if (argv.length === 0) { ctx.stderr += `timeout: missing operand after '${a[i]}'\n${USAGE}`; return 125; }

    let out = '', err = '';
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The command runs inside an abort scope and under a deadline: when time is up its remaining
    // statements are skipped, a pending sleep wakes, and a WASM program is terminated (wasi-host.ts).
    const scope = ctx.shell.pushAbortScope();
    if (duration > 0) ctx.shell.pushDeadline(Date.now() + duration * 1000);
    const deadline = new Promise<'timeout'>(resolve => {
      if (duration === 0) return; // 0 disables the limit
      timer = setTimeout(() => { expired = true; scope.abort(); resolve('timeout'); }, duration * 1000);
    });
    const run = runSubcommand(ctx, argv, s => { if (!expired) out += s; }, s => { if (!expired) err += s; })
      .catch((e: any) => { if (!expired) err += `timeout: ${e?.message ?? e}\n`; return 125; });

    let result: number | 'timeout';
    try {
      result = await Promise.race([run, deadline]);
      // give an aborted command a moment to wind down so it does not linger
      if (result === 'timeout') await Promise.race([run, new Promise(r => setTimeout(r, 1000))]);
    } finally {
      clearTimeout(timer);
      ctx.shell.popAbortScope(scope);
      if (duration > 0) ctx.shell.popDeadline();
    }
    ctx.stdout += out;
    ctx.stderr += err;
    if (result !== 'timeout') {
      // a WASM program killed by the deadline reports 124 itself; so does a command we aborted
      return result;
    }

    if (verbose) ctx.stderr += `timeout: sending signal ${Object.keys(SIGNALS).find(k => SIGNALS[k] === signal) ?? signal} to command '${argv[0]}'\n`;
    if (preserve) return 128 + signal;
    if (killAfter > 0 || signal === 9) return 137;
    return 124;
  },
};
