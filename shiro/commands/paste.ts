import type { Command } from './index';
import { toLines } from './flags';

// GNU paste: lines of the files side by side (or one file per line with -s), delimiters cycled
// from the -d list (\t \n \\ and \0 for none). Each "-" takes the next line of stdin in turn.
function delimList(spec: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '\\' && i + 1 < spec.length) {
      const c = spec[++i];
      out.push(c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '' : c === '\\' ? '\\' : c);
    } else out.push(spec[i]);
  }
  return out.length ? out : ['\t'];
}

export const paste: Command = {
  name: "paste",
  description: "Merge lines of files",
  async exec(ctx) {
    let delims = ['\t'], serial = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--serial') serial = true;
      else if (a.startsWith('--delimiters=')) delims = delimList(a.slice(13));
      else if (a.startsWith('-') && a !== '-') {
        // Bundled short options: -s, -d LIST (the rest of the argument or the next one), -z
        for (let j = 1; j < a.length; j++) {
          if (a[j] === 's') serial = true;
          else if (a[j] === 'd') { delims = delimList(j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? '')); break; }
        }
      } else files.push(a);
    }
    if (!files.length) files.push('-');
    const stdinLines = toLines(ctx.stdin).lines;
    let stdinPos = 0;
    const sources: { lines: string[] | null }[] = [];
    for (const f of files) {
      if (f === '-') { sources.push({ lines: null }); continue; }
      try { sources.push({ lines: toLines(await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string).lines }); }
      catch { ctx.stderr += `paste: ${f}: No such file or directory\n`; return 1; }
    }
    if (serial) {
      for (const s of sources) {
        const lines = s.lines ?? stdinLines.slice(stdinPos, (stdinPos = stdinLines.length));
        ctx.stdout += lines.map((l, k) => (k ? delims[(k - 1) % delims.length] : '') + l).join('') + '\n';
      }
      return 0;
    }
    const pos = sources.map(() => 0);
    for (;;) {
      const parts: (string | null)[] = sources.map((s, k) => {
        if (s.lines === null) return stdinPos < stdinLines.length ? stdinLines[stdinPos++] : null;
        return pos[k] < s.lines.length ? s.lines[pos[k]++] : null;
      });
      if (parts.every(p => p === null)) break;
      ctx.stdout += parts.map((p, k) => (k ? delims[(k - 1) % delims.length] : '') + (p ?? '')).join('') + '\n';
    }
    return 0;
  },
};
