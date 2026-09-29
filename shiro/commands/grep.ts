import type { Command, CommandContext } from './index';
import { breToJs, ereToJs } from '../utils/posix-regex';

// GNU grep: BRE by default (-E extended, -F fixed strings, -P Perl-like = JavaScript regex).
// Output, file-name prefixes, context separators and exit status (0 match, 1 none, 2 error) match
// GNU grep.

/** Lines of a file or stream; a final newline ends the last line rather than starting another. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

const LONG_FLAGS: Record<string, string> = {
  '--ignore-case': 'i', '--invert-match': 'v', '--line-number': 'n', '--count': 'c',
  '--files-with-matches': 'l', '--files-without-match': 'L', '--recursive': 'r',
  '--dereference-recursive': 'r', '--only-matching': 'o', '--word-regexp': 'w',
  '--line-regexp': 'x', '--fixed-strings': 'F', '--extended-regexp': 'E', '--basic-regexp': 'G',
  '--perl-regexp': 'P', '--quiet': 'q', '--silent': 'q', '--no-messages': 's',
  '--with-filename': 'H', '--no-filename': 'h',
};
const LONG_VALUES: Record<string, string> = {
  '--regexp': 'e', '--file': 'f', '--max-count': 'm', '--after-context': 'A', '--before-context': 'B', '--context': 'C',
};

export const grepCmd: Command = {
  name: 'grep',
  description: 'Search for patterns in files',
  async exec(ctx: CommandContext) {
    const f = new Set<string>();
    const patterns: string[] = [];
    let maxCount = -1, before = 0, after = 0;
    let color = false;
    const files: string[] = [];
    const include: string[] = [], exclude: string[] = [], excludeDir: string[] = [];
    let optionsDone = false;

    const patternFiles: string[] = [];
    const setValue = (opt: string, v: string) => {
      if (opt === 'e') patterns.push(v);
      else if (opt === 'f') { patternFiles.push(v); f.add('patternGiven'); }
      else if (opt === 'm') maxCount = parseInt(v, 10);
      else if (opt === 'A') after = parseInt(v, 10) || 0;
      else if (opt === 'B') before = parseInt(v, 10) || 0;
      else if (opt === 'C') before = after = parseInt(v, 10) || 0;
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (optionsDone || a === '-' || !a.startsWith('-')) {
        if (!patterns.length && !f.has('patternGiven')) { patterns.push(a); f.add('patternGiven'); }
        else files.push(a);
        continue;
      }
      if (a === '--') { optionsDone = true; continue; }
      if (a.startsWith('--')) {
        const [name, val] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        if (LONG_FLAGS[name]) { f.add(LONG_FLAGS[name]); continue; }
        if (LONG_VALUES[name]) { setValue(LONG_VALUES[name], val ?? args[++i] ?? ''); if (name === '--regexp') f.add('patternGiven'); continue; }
        if (name === '--include') { include.push(val ?? args[++i]); continue; }
        if (name === '--exclude') { exclude.push(val ?? args[++i]); continue; }
        if (name === '--exclude-dir') { excludeDir.push(val ?? args[++i]); continue; }
        if (name === '--color' || name === '--colour') { color = val === undefined || val === 'always'; continue; }
        ctx.stderr += `grep: unrecognized option '${a}'\n`;
        return 2;
      }
      // Short options, possibly bundled (-in, -A3, -e PATTERN, -m1)
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('eABCmf'.includes(ch)) {
          const rest = a.slice(j + 1);
          setValue(ch, rest !== '' ? rest : (args[++i] ?? ''));
          if (ch === 'e') f.add('patternGiven');
          break;
        }
        if (/\d/.test(ch)) { before = after = parseInt(a.slice(j), 10); break; }   // -2 = -C2
        f.add(ch);
      }
    }
    // -f FILE: one pattern per line (an empty file matches nothing).
    let noPatterns = false;
    for (const pf of patternFiles) {
      let text: string;
      try { text = pf === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(pf, ctx.cwd), 'utf8') as string; }
      catch { ctx.stderr += `grep: ${pf}: No such file or directory\n`; return 2; }
      const lines = splitLines(text);
      patterns.push(...lines);
      if (!lines.length && !patterns.length) noPatterns = true;
    }
    if (noPatterns) return 1;
    if (!patterns.length) { ctx.stderr += 'Usage: grep [OPTION]... PATTERNS [FILE]...\n'; return 2; }

    const ignoreCase = f.has('i'), invert = f.has('v'), lineNumbers = f.has('n'), countOnly = f.has('c');
    const listMatching = f.has('l'), listNonMatching = f.has('L'), onlyMatching = f.has('o');
    const quiet = f.has('q'), noMessages = f.has('s'), recursive = f.has('r') || f.has('R');

    // One pattern per line of each -e; all are alternatives.
    const toJs = (p: string) => f.has('F') ? p.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
      : f.has('E') ? ereToJs(p) : f.has('P') ? p : breToJs(p);
    const parts = patterns.flatMap(p => p.split('\n')).map(p => {
      let src = toJs(p);
      if (f.has('w')) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
      if (f.has('x')) src = `^(?:${src})$`;
      return src;
    });
    let regex: RegExp;
    try {
      regex = new RegExp(parts.length === 1 ? parts[0] : parts.map(p => `(?:${p})`).join('|'), 'g' + (ignoreCase ? 'i' : ''));
    } catch {
      ctx.stderr += `grep: Invalid regular expression\n`;
      return 2;
    }
    const matches = (line: string) => { regex.lastIndex = 0; return regex.test(line); };

    const multi = recursive || files.length > 1;
    const showName = (f.has('H') || multi) && !f.has('h');
    let anySelected = false, anyListed = false, error = false;

    // Returns true to stop everything (-q found a match).
    const searchText = (text: string, name: string): boolean => {
      const lines = splitLines(text);
      const prefix = (sep: string) => (showName ? name + sep : '');
      const selected: number[] = [];
      for (let ln = 0; ln < lines.length; ln++) {
        if (maxCount >= 0 && selected.length >= maxCount) break;
        if (matches(lines[ln]) !== invert) selected.push(ln);
      }
      if (selected.length) anySelected = true;
      if (quiet) return selected.length > 0;
      if (listMatching || listNonMatching) {
        if ((selected.length > 0) === listMatching) { ctx.stdout += name + '\n'; anyListed = true; }
        return false;
      }
      if (countOnly) { ctx.stdout += prefix(':') + selected.length + '\n'; return false; }
      const hl = (s: string) => color ? s.replace(regex, m => `\x1b[01;31m\x1b[K${m}\x1b[m\x1b[K`) : s;
      if (onlyMatching) {
        if (invert) return false;
        for (const ln of selected) {
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(lines[ln])) !== null) {
            if (m[0] === '') { regex.lastIndex++; continue; }
            ctx.stdout += prefix(':') + (lineNumbers ? `${ln + 1}:` : '') + m[0] + '\n';
          }
        }
        return false;
      }
      // Selected lines plus context, "--" between non-adjacent groups.
      const sel = new Set(selected);
      const shown = new Set<number>();
      for (const ln of selected) {
        for (let k = Math.max(0, ln - before); k <= Math.min(lines.length - 1, ln + after); k++) shown.add(k);
      }
      let last = -1;
      for (const ln of [...shown].sort((a, b) => a - b)) {
        if ((before || after) && last >= 0 && ln > last + 1) ctx.stdout += '--\n';
        const sep = sel.has(ln) ? ':' : '-';
        ctx.stdout += prefix(sep) + (lineNumbers ? `${ln + 1}${sep}` : '') + (sel.has(ln) ? hl(lines[ln]) : lines[ln]) + '\n';
        last = ln;
      }
      return false;
    };

    const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const inc = include.map(globRe), exc = exclude.map(globRe), excDir = excludeDir.map(globRe);
    const wanted = (base: string) => (!inc.length || inc.some(r => r.test(base))) && !exc.some(r => r.test(base));

    const readText = async (display: string, path: string): Promise<string | null> => {
      try {
        return await ctx.fs.readFile(path, 'utf8') as string;
      } catch {
        if (!noMessages) ctx.stderr += `grep: ${display}: No such file or directory\n`;
        error = true;
        return null;
      }
    };

    // Recursive search: names shown as reached from the argument ("src/a.js", "./src/a.js").
    const walk = async (display: string, path: string): Promise<boolean> => {
      let entries: string[];
      try { entries = await ctx.fs.readdir(path); } catch { return false; }
      for (const e of entries.sort()) {
        const childPath = path === '/' ? `/${e}` : `${path}/${e}`;
        const childDisplay = display === '' ? e : display.endsWith('/') ? display + e : `${display}/${e}`;
        const st = await ctx.fs.stat(childPath).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) {
          if (excDir.some(r => r.test(e))) continue;
          if (await walk(childDisplay, childPath)) return true;
        } else if (wanted(e)) {
          const text = await readText(childDisplay, childPath);
          if (text !== null && !text.includes('\0') && searchText(text, childDisplay)) return true;
        }
      }
      return false;
    };

    if (!files.length && recursive) {
      await walk('', ctx.cwd);
    } else if (!files.length) {
      searchText(ctx.stdin, '(standard input)');
    } else {
      for (const file of files) {
        if (file === '-') { if (searchText(ctx.stdin, '(standard input)')) break; continue; }
        const path = ctx.fs.resolvePath(file, ctx.cwd);
        const st = await ctx.fs.stat(path).catch(() => null);
        if (st?.isDirectory()) {
          if (recursive) { if (await walk(file, path)) break; continue; }
          if (!noMessages) ctx.stderr += `grep: ${file}: Is a directory\n`;
          continue;
        }
        const text = await readText(file, path);
        if (text === null) continue;
        if (text.includes('\0')) {
          if (matches(text) && !quiet && !countOnly && !listMatching) ctx.stdout += `Binary file ${file} matches\n`;
          continue;
        }
        if (searchText(text, file)) break;
      }
    }
    if (quiet && anySelected) return 0;
    if (error) return 2;
    // -L succeeds when it lists a file; everything else when a line was selected.
    return (listNonMatching ? anyListed : anySelected) ? 0 : 1;
  },
};
