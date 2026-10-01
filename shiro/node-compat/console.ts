import type { CommandContext } from '../commands/index';
import type { SharedState } from './types';
import * as nodeInspect from 'node-inspect-extracted';
const { format, inspect } = nodeInspect;
// Display width (wide CJK characters count 2); exported at runtime but missing from the package's types.
const getStringWidth: (s: string) => number = (nodeInspect as any).getStringWidth ?? ((s: string) => [...s].length);

/**
 * Create the fake console object for the Node.js compat layer.
 * Writes to stdoutBuf/stderrBuf (raw chunks, each line with its newline) and optionally streams
 * to terminal. Arguments are formatted by Node's own util.format / util.inspect.
 */
export function createFakeConsole(
  ctx: CommandContext,
  stdoutBuf: string[],
  stderrBuf: string[],
  _st: SharedState,
): any {
  const out = (s: string) => {
    stdoutBuf.push(s);
    if (ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n')); }
  };
  const err = (s: string) => { stderrBuf.push(s); };
  const fakeConsole: any = {
    ...nodeConsole(out, err),
    clear: () => { if (ctx.terminal) ctx.terminal.writeOutput('\x1b[2J\x1b[H'); },
  };

  // Console constructor — Node.js API: new console.Console(stdout, stderr)
  class FakeConsoleClass {
    _stdout: any; _stderr: any;
    constructor(stdoutOrOpts?: any, stderr?: any) {
      if (stdoutOrOpts && typeof stdoutOrOpts === 'object' && stdoutOrOpts.stdout) {
        this._stdout = stdoutOrOpts.stdout;
        this._stderr = stdoutOrOpts.stderr || stdoutOrOpts.stdout;
      } else {
        this._stdout = stdoutOrOpts || _st.fakeProcess?.stdout;
        this._stderr = stderr || stdoutOrOpts || _st.fakeProcess?.stderr;
      }
    }
    log(...args: any[]) { const s = format(...args) + '\n'; if (this._stdout?.write) this._stdout.write(s); else out(s); }
    info(...args: any[]) { this.log(...args); }
    warn(...args: any[]) { const s = format(...args) + '\n'; if (this._stderr?.write) this._stderr.write(s); else err(s); }
    error(...args: any[]) { this.warn(...args); }
    dir(obj: any) { this.log(obj); }
    debug(...args: any[]) { this.log(...args); }
    trace(...args: any[]) { this.log(...args); }
    assert(val: any, ...args: any[]) { if (!val) this.error('Assertion failed:', ...args); }
    time() {} timeEnd() {} timeLog() {}
    count() {} countReset() {}
    group() {} groupEnd() {} groupCollapsed() {}
    clear() { fakeConsole.clear(); }
    table(...args: any[]) { this.log(...args); }
  }
  fakeConsole.Console = FakeConsoleClass;

  return fakeConsole;
}

/**
 * Node's console methods over two writers (stdout, stderr): output as Node prints it — util.format
 * for arguments, group indentation, count / time labels, assert, table. Used by the shell's node and
 * by execute_code JavaScript (exec-sandbox/js-run.ts).
 */
export function nodeConsole(out: (s: string) => void, err: (s: string) => void) {
  let indent = '';
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const line = (s: string) => (indent ? s.split('\n').map(l => indent + l).join('\n') : s) + '\n';
  const ms = (label: string) => {
    const t = now() - (timers.get(label) ?? now());
    return t < 1000 ? `${+t.toFixed(3)}ms` : `${+(t / 1000).toFixed(3)}s`;
  };
  const c: any = {
    log: (...a: any[]) => out(line(format(...a))),
    info: (...a: any[]) => out(line(format(...a))),
    debug: (...a: any[]) => out(line(format(...a))),
    warn: (...a: any[]) => err(line(format(...a))),
    error: (...a: any[]) => err(line(format(...a))),
    dir: (o: any, opts?: any) => out(line(inspect(o, { customInspect: false, ...opts }))),
    dirxml: (...a: any[]) => out(line(format(...a))),
    trace: (...a: any[]) => err(line('Trace' + (a.length ? ': ' + format(...a) : ''))),
    assert: (v: any, ...a: any[]) => { if (!v) err(line('Assertion failed' + (a.length ? ': ' + format(...a) : ''))); },
    count: (label = 'default') => { const n = (counts.get(String(label)) ?? 0) + 1; counts.set(String(label), n); out(line(`${label}: ${n}`)); },
    countReset: (label = 'default') => { counts.set(String(label), 0); },
    group: (...a: any[]) => { if (a.length) out(line(format(...a))); indent += '  '; },
    groupCollapsed: (...a: any[]) => c.group(...a),
    groupEnd: () => { indent = indent.slice(0, -2); },
    time: (label = 'default') => { timers.set(String(label), now()); },
    timeLog: (label = 'default', ...a: any[]) => out(line(`${label}: ${ms(String(label))}` + (a.length ? ' ' + format(...a) : ''))),
    timeEnd: (label = 'default') => { out(line(`${label}: ${ms(String(label))}`)); timers.delete(String(label)); },
    table: (data: any, columns?: string[]) => out(line(table(data, columns))),
  };
  return c;
}

/** console.table as Node 22 draws it (left-aligned cells, values shown by util.inspect). */
function table(data: any, only?: string[]): string {
  if (data === null || typeof data !== 'object') return format(data);
  const show = (v: any) => inspect(v, { depth: 1, breakLength: Infinity, compact: true });
  const isMap = data instanceof Map;
  const entries: [any, any][] = isMap ? [...data.entries()] : data instanceof Set ? [...data].map((v, i) => [i, v]) : Object.entries(data);
  const keys: string[] = [];
  let hasValues = false;
  const rows = entries.map(([k, v]) => {
    const cells: Record<string, string> = {};
    if (v !== null && typeof v === 'object' && !Array.isArray(v) || Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v)) {
        if (only && !only.includes(ck)) continue;
        if (!keys.includes(ck)) keys.push(ck);
        cells[ck] = show(cv);
      }
    } else { hasValues = true; cells['\u0000v'] = show(v); }
    return { index: isMap ? show(k) : String(k), cells };
  });
  const head = [isMap ? '(iteration index)' : '(index)', ...(isMap ? ['Key'] : []), ...(only ?? keys), ...(hasValues ? ['Values'] : [])];
  const body = rows.map((r, i) => [isMap ? String(i) : r.index, ...(isMap ? [r.index] : []), ...(only ?? keys).map(k => r.cells[k] ?? ''), ...(hasValues ? [r.cells['\u0000v'] ?? ''] : [])]);
  const widths = head.map((h, i) => Math.max(getStringWidth(h), ...body.map(r => getStringWidth(r[i]))) + 2);
  const cell = (s: string, w: number) => ' ' + s + ' '.repeat(w - getStringWidth(s) - 1);
  const rule = (l: string, m: string, r: string) => l + widths.map(w => '─'.repeat(w)).join(m) + r;
  return [rule('┌', '┬', '┐'), '│' + head.map((h, i) => cell(h, widths[i])).join('│') + '│', rule('├', '┼', '┤'),
    ...body.map(r => '│' + r.map((v, i) => cell(v, widths[i])).join('│') + '│'), rule('└', '┴', '┘')].join('\n');
}
