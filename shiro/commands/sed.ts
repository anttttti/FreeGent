import type { Command, CommandContext } from './index';
import { breToJs, ereToJs } from '../utils/posix-regex';
import { readFileText as sharedReadFileText } from './flags';

// GNU sed: a script parser and the pattern-space/hold-space machine. Supports addresses (N, $,
// /re/I, \cREc, first~step, addr,+N, addr,~N, 0,/re/, !), { } blocks and the commands
// s y d D p P n N g G h H x b t T : = a i c q Q l r w z F #. Output matches GNU sed, including
// a missing newline at the end of the input.

type Addr =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 'step'; first: number; step: number }
  | { kind: 're'; re: RegExp | null }        // null: the last regex used
  | { kind: 'plus'; n: number }              // addr2 only
  | { kind: 'mult'; n: number };             // addr2 only

interface Cmd {
  a1?: Addr; a2?: Addr; neg: boolean;
  name: string;
  // s
  re?: RegExp | null; repl?: ReplPart[]; global?: boolean; occurrence?: number; print?: boolean; wfile?: string;
  // y
  from?: string; to?: string;
  // a i c r w l q
  text?: string; file?: string; num?: number;
  label?: string; target?: number;           // b t T; '{' → index of its '}'
}

type ReplPart = { lit: string } | { group: number } | { caseOp: 'U' | 'L' | 'u' | 'l' | 'E' };

class SedError extends Error {}

function parseScript(script: string, extended: boolean) {
  const cmds: Cmd[] = [];
  const blocks: number[] = [];
  let i = 0;
  const n = script.length;
  const err = (msg: string): never => { throw new SedError(`-e expression #1, char ${i}: ${msg}`); };
  const skipWs = () => { while (i < n && (script[i] === ' ' || script[i] === '\t')) i++; };
  const toJs = (p: string) => extended ? ereToJs(p) : breToJs(p);

  // A delimited string: the regex of an address or s, or a part of s/y. \delim is the delimiter
  // itself (escaped again if it is special in the regex); \n is a newline.
  const readDelimited = (delim: string, isRegex: boolean): string => {
    let out = '';
    while (i < n && script[i] !== delim) {
      if (script[i] === '\\' && i + 1 < n) {
        const c = script[i + 1];
        if (c === delim) out += isRegex && /[.[\]*^$\\+?(){}|]/.test(c) ? '\\' + c : c;
        else if (c === 'n' && !isRegex) out += '\n';
        else out += '\\' + c;
        i += 2;
        continue;
      }
      if (script[i] === '\n' && !isRegex) { out += '\n'; i++; continue; }
      out += script[i++];
    }
    if (i >= n) err(`unterminated address regex`);
    i++;   // closing delimiter
    return out;
  };
  const makeRe = (src: string, flags: string): RegExp | null => {
    if (src === '') return null;
    try { return new RegExp(toJs(src), 's' + flags); } catch { return err('invalid regex'); }
  };
  const readNum = () => { const m = /^\d+/.exec(script.slice(i)); if (!m) return null; i += m[0].length; return parseInt(m[0], 10); };
  const readAddr = (second: boolean): Addr | undefined => {
    const c = script[i];
    if (c === '$') { i++; return { kind: 'last' }; }
    if (second && (c === '+' || c === '~')) { i++; const v = readNum() ?? 0; return c === '+' ? { kind: 'plus', n: v } : { kind: 'mult', n: v }; }
    if (/\d/.test(c ?? '')) {
      const v = readNum()!;
      if (script[i] === '~') { i++; return { kind: 'step', first: v, step: readNum() ?? 0 }; }
      return { kind: 'line', n: v };
    }
    if (c === '/' || c === '\\') {
      let delim = '/';
      if (c === '\\') { delim = script[i + 1]; i++; }
      i++;
      const src = readDelimited(delim, true);
      let flags = '';
      while (script[i] === 'I' || script[i] === 'M') { flags += script[i] === 'I' ? 'i' : 'm'; i++; }
      return { kind: 're', re: makeRe(src, flags) };
    }
    return undefined;
  };
  // Text of a, i, c: "a\" + newline + lines (\ + newline continues), or GNU one-liner "a text".
  const readText = (): string => {
    skipWs();
    if (script[i] === '\\') { i++; if (script[i] === '\n') i++; else skipWs(); }
    let out = '';
    while (i < n && script[i] !== '\n') {
      if (script[i] === '\\' && i + 1 < n) {
        if (script[i + 1] === '\n') { out += '\n'; i += 2; continue; }
        out += script[i + 1]; i += 2; continue;
      }
      out += script[i++];
    }
    return out;
  };
  const readToEol = () => { skipWs(); const s = i; while (i < n && script[i] !== '\n') i++; return script.slice(s, i); };
  const readLabel = () => { skipWs(); const s = i; while (i < n && !/[\n;}]/.test(script[i])) i++; return script.slice(s, i).trim(); };

  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] === '#') { while (i < n && script[i] !== '\n') i++; continue; }
    const cmd: Cmd = { name: '', neg: false };
    cmd.a1 = readAddr(false);
    if (cmd.a1 && script[i] === ',') { i++; skipWs(); cmd.a2 = readAddr(true) ?? err('unexpected `,\''); }
    skipWs();
    while (script[i] === '!') { cmd.neg = true; i++; skipWs(); }
    const c = script[i++];
    if (c === undefined) err('missing command');
    cmd.name = c;
    switch (c) {
      case '{': blocks.push(cmds.length); cmds.push(cmd); continue;
      case '}': {
        if (!blocks.length) err('unexpected `}\'');
        cmds[blocks.pop()!].target = cmds.length;
        cmds.push(cmd);
        continue;
      }
      case 's': {
        const delim = script[i++];
        const pat = readDelimited(delim, true);
        const rawRepl = readDelimited(delim, false);
        let flags = '';
        cmd.global = false; cmd.occurrence = 1; cmd.print = false;
        for (;;) {
          const f = script[i];
          if (f === 'g') { cmd.global = true; i++; }
          else if (f === 'p') { cmd.print = true; i++; }
          else if (f === 'i' || f === 'I') { flags += 'i'; i++; }
          else if (f === 'm' || f === 'M') { flags += 'm'; i++; }
          else if (f === 'e') { i++; }
          else if (f && /\d/.test(f)) { cmd.occurrence = readNum()!; }
          else if (f === 'w') { i++; cmd.wfile = readToEol(); break; }
          else break;
        }
        cmd.re = makeRe(pat, flags);
        cmd.repl = parseRepl(rawRepl);
        break;
      }
      case 'y': {
        const delim = script[i++];
        cmd.from = readDelimited(delim, false).replace(/\\\\/g, '\\');
        cmd.to = readDelimited(delim, false).replace(/\\\\/g, '\\');
        if ([...cmd.from].length !== [...cmd.to].length) err('strings for `y\' command are different lengths');
        break;
      }
      case 'a': case 'i': case 'c': cmd.text = readText(); break;
      case 'r': case 'R': case 'w': case 'W': cmd.file = readToEol(); break;
      case 'b': case 't': case 'T': cmd.label = readLabel(); break;
      case ':': { const l = readLabel(); if (!l) err('":" lacks a label'); cmd.label = l; break; }
      case 'q': case 'Q': case 'l': case 'L': skipWs(); cmd.num = readNum() ?? undefined; break;
      case '=': case 'd': case 'D': case 'p': case 'P': case 'n': case 'N': case 'g': case 'G':
      case 'h': case 'H': case 'x': case 'z': case 'F': break;
      default: err(`unknown command: \`${c}'`);
    }
    cmds.push(cmd);
  }
  if (blocks.length) err('unmatched `{\'');
  for (const cmd of cmds) {
    if ((cmd.name === 'b' || cmd.name === 't' || cmd.name === 'T')) {
      if (!cmd.label) cmd.target = cmds.length;
      else {
        const t = cmds.findIndex(c => c.name === ':' && c.label === cmd.label);
        if (t < 0) throw new SedError(`can't find label for jump to \`${cmd.label}'`);
        cmd.target = t;
      }
    }
  }
  return cmds;
}

function parseRepl(s: string): ReplPart[] {
  const parts: ReplPart[] = [];
  let lit = '';
  const flush = () => { if (lit) { parts.push({ lit }); lit = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') { flush(); parts.push({ group: 0 }); continue; }
    if (c === '\\' && i + 1 < s.length) {
      const d = s[++i];
      if (/\d/.test(d)) { flush(); parts.push({ group: parseInt(d, 10) }); }
      else if ('ULulE'.includes(d)) { flush(); parts.push({ caseOp: d as any }); }
      else if (d === 'n') lit += '\n';
      else if (d === 't') lit += '\t';
      else lit += d;
      continue;
    }
    lit += c;
  }
  flush();
  return parts;
}

function applyRepl(parts: ReplPart[], m: RegExpExecArray): string {
  let out = '';
  let mode: 'U' | 'L' | null = null;
  let once: 'u' | 'l' | null = null;
  const add = (t: string) => {
    if (!t) return;
    if (mode === 'U') t = t.toUpperCase(); else if (mode === 'L') t = t.toLowerCase();
    if (once) { t = (once === 'u' ? t[0].toUpperCase() : t[0].toLowerCase()) + t.slice(1); once = null; }
    out += t;
  };
  for (const p of parts) {
    if ('lit' in p) add(p.lit);
    else if ('group' in p) add(m[p.group] ?? '');
    else if (p.caseOp === 'E') { mode = null; once = null; }
    else if (p.caseOp === 'U' || p.caseOp === 'L') mode = p.caseOp;
    else once = p.caseOp;
  }
  return out;
}

// `l`: escapes, octal for other non-printables, lines wrapped with "\" at the width, "$" at the end.
function listLine(s: string, width: number): string {
  const esc: Record<string, string> = { '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };
  let out = '', col = 0;
  for (const ch of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(ch);
    const piece = esc[c] ?? (ch < 32 || ch >= 127 ? '\\' + ch.toString(8).padStart(3, '0') : c);
    if (width > 1 && col + piece.length > width - 1) { out += '\\\n'; col = 0; }
    out += piece; col += piece.length;
  }
  return out + '$\n';
}

interface Input { lines: string[]; lastHasNewline: boolean; name: string; path?: string }

export const sedCmd: Command = {
  name: 'sed',
  description: 'Stream editor for filtering and transforming text',
  async exec(ctx: CommandContext) {
    let quiet = false, extended = false, separate = false, nullData = false;
    let inPlace: string | null = null;
    const scripts: string[] = [];
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        if (k === '--quiet' || k === '--silent') quiet = true;
        else if (k === '--regexp-extended') extended = true;
        else if (k === '--separate') separate = true;
        else if (k === '--null-data') nullData = true;
        else if (k === '--in-place') inPlace = v ?? '';
        else if (k === '--expression') scripts.push(v ?? args[++i]);
        else if (k === '--file') scripts.push(await readFileText(ctx, v ?? args[++i]));
        else if (k === '--posix' || k === '--debug' || k === '--sandbox') { /* no-op */ }
        else { ctx.stderr += `sed: unknown option -- '${a}'\n`; return 1; }
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'n') quiet = true;
          else if (c === 'E' || c === 'r') extended = true;
          else if (c === 's') separate = true;
          else if (c === 'z') nullData = true;
          else if (c === 'i') { inPlace = a.slice(j + 1); break; }
          else if (c === 'e') { scripts.push(a.slice(j + 1) || args[++i]); break; }
          else if (c === 'f') { scripts.push(await readFileText(ctx, a.slice(j + 1) || args[++i])); break; }
          else if (c === 'u' || c === 'l') { if (c === 'l' && j === a.length - 1) i++; }
          else { ctx.stderr += `sed: invalid option -- '${c}'\n`; return 1; }
        }
        continue;
      }
      if (!scripts.length) scripts.push(a); else files.push(a);
    }
    if (!scripts.length) { ctx.stderr += 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'; return 1; }
    const script = scripts.join('\n');
    // A script whose first line is exactly "#n" acts like -n.
    if (scripts.length === 1 && (script === '#n' || script.startsWith('#n\n'))) quiet = true;

    let cmds: Cmd[];
    try { cmds = parseScript(script, extended); }
    catch (e: any) { ctx.stderr += `sed: ${e.message}\n`; return 1; }

    const sep = nullData ? '\0' : '\n';
    const toInput = (text: string, name: string, path?: string): Input => {
      const lines = text === '' ? [] : text.split(sep);
      const lastHasNewline = text.endsWith(sep);
      if (lastHasNewline) lines.pop();
      return { lines, lastHasNewline, name, path };
    };
    const inputs: Input[] = [];
    let status = 0;
    if (!files.length) inputs.push(toInput(ctx.stdin, '-'));
    for (const f of files) {
      if (f === '-') { inputs.push(toInput(ctx.stdin, '-')); continue; }
      const path = ctx.fs.resolvePath(f, ctx.cwd);
      try { inputs.push(toInput(await ctx.fs.readFile(path, 'utf8') as string, f, path)); }
      catch { ctx.stderr += `sed: can't read ${f}: No such file or directory\n`; status = 2; }
    }

    // Files read by r / R, and files written by w and s///w (truncated first, as GNU does).
    const rFiles = new Map<string, string[]>();
    for (const c of cmds) {
      if ((c.name === 'r' || c.name === 'R') && c.file && !rFiles.has(c.file)) {
        const t = c.file === '/dev/stdin' ? ctx.stdin : await readFileText(ctx, c.file).catch(() => null);
        rFiles.set(c.file, t === null ? [] : toInput(t, c.file).lines);
      }
    }
    const wOut = new Map<string, string>();
    for (const c of cmds) for (const w of [c.name === 'w' || c.name === 'W' ? c.file : undefined, c.wfile]) if (w) wOut.set(w, '');

    const run = (group: Input[]): { out: string; exit: number | null } => {
      let out = '';
      let missingNewline = false;
      const emit = (text: string, newline = true) => {
        if (missingNewline) { out += sep; missingNewline = false; }
        out += text;
        if (newline) out += sep; else missingNewline = true;
      };
      const all: { text: string; input: Input; last: boolean }[] = [];
      group.forEach((inp, k) => inp.lines.forEach((t, j) => all.push({ text: t, input: inp, last: k === group.length - 1 && j === inp.lines.length - 1 })));
      // Last line of the whole group (GNU treats later empty inputs as not adding lines).
      let pos = 0, lineNo = 0;
      let ps = '', hs = '';
      let curNewline = true;
      let lastRe: RegExp | null = null;
      const rState = new Map<Cmd, { active: boolean; end?: number }>();
      const rCursor = new Map<string, number>();
      let exit: number | null = null;

      const next = (): boolean => {
        if (pos >= all.length) return false;
        const r = all[pos++];
        ps = r.text; lineNo++;
        curNewline = !r.last || r.input.lastHasNewline;
        return true;
      };
      const isLast = () => pos >= all.length;
      const reOf = (re: RegExp | null) => { const r = re ?? lastRe; if (!r) throw new SedError('no previous regular expression'); lastRe = r; return r; };
      const matchOne = (a: Addr): boolean => {
        switch (a.kind) {
          case 'line': return lineNo === a.n;
          case 'last': return isLast();
          case 'step': return a.step <= 0 ? lineNo === a.first : lineNo >= a.first && (lineNo - a.first) % a.step === 0;
          case 're': { const r = reOf(a.re); r.lastIndex = 0; return r.test(ps); }
          default: return false;
        }
      };
      const selected = (c: Cmd): boolean => {
        if (!c.a1) return true;
        let hit: boolean;
        if (!c.a2) hit = matchOne(c.a1);
        else {
          const st = rState.get(c) ?? { active: false };
          rState.set(c, st);
          if (!st.active) {
            const zeroStart = c.a1.kind === 'line' && c.a1.n === 0;
            hit = zeroStart ? lineNo === 1 || false : matchOne(c.a1);
            if (zeroStart && lineNo === 1) {
              hit = true;
              if (c.a2.kind === 're' && matchOne(c.a2)) { /* range ends on line 1 */ } else st.active = true;
            } else if (hit) {
              const a2 = c.a2;
              if (a2.kind === 'line') st.active = a2.n > lineNo;
              else if (a2.kind === 'plus') { st.end = lineNo + a2.n; st.active = a2.n > 0; }
              else if (a2.kind === 'mult') { st.active = a2.n > 0 && lineNo % a2.n !== 0; }
              else if (a2.kind === 'last') st.active = !isLast();
              else st.active = true;
            }
          } else {
            hit = true;
            const a2 = c.a2;
            if (a2.kind === 'line') { if (lineNo >= a2.n) st.active = false; }
            else if (a2.kind === 'plus') { if (lineNo >= st.end!) st.active = false; }
            else if (a2.kind === 'mult') { if (lineNo % a2.n === 0) st.active = false; }
            else if (a2.kind === 'last') { if (isLast()) st.active = false; }
            else if (matchOne(a2)) st.active = false;
          }
        }
        return hit !== c.neg;
      };
      const rangeEnded = (c: Cmd) => !c.a2 || !rState.get(c)?.active;

      let appendQueue: string[] = [];
      const flushAppend = () => { for (const t of appendQueue) emit(t); appendQueue = []; };

      while (exit === null && next()) {
        let subst = false;
        let restart = false;           // D with a newline: next cycle without reading input
        cycle: do {
          restart = false;
          let pc = 0;
          let deleted = false;
          while (pc < cmds.length) {
            const c = cmds[pc];
            if (c.name === '}' || c.name === ':') { pc++; continue; }
            if (!selected(c)) { pc = c.name === '{' ? c.target! + 1 : pc + 1; continue; }
            switch (c.name) {
              case '{': break;
              case '=': emit(String(lineNo)); break;
              case 'a': appendQueue.push(c.text!); break;
              case 'i': emit(c.text!); break;
              case 'c':
                if (rangeEnded(c) || c.neg) emit(c.text!);
                deleted = true; break;
              case 'd': deleted = true; break;
              case 'D': {
                const nl = ps.indexOf('\n');
                if (nl < 0) { deleted = true; break; }
                ps = ps.slice(nl + 1);
                flushAppend();
                restart = true;
                continue cycle;
              }
              case 'p': emit(ps); break;
              case 'P': emit(ps.split('\n')[0]); break;
              case 'l': emit(listLine(ps, c.num ?? 70).slice(0, -1)); break;
              case 'F': emit(all[pos - 1]?.input.name ?? '-'); break;
              case 'z': ps = ''; break;
              case 'g': ps = hs; break;
              case 'G': ps += '\n' + hs; break;
              case 'h': hs = ps; break;
              case 'H': hs += '\n' + ps; break;
              case 'x': [ps, hs] = [hs, ps]; break;
              case 'y': {
                const from = [...c.from!], to = [...c.to!];
                ps = [...ps].map(ch => { const k = from.indexOf(ch); return k >= 0 ? to[k] : ch; }).join('');
                break;
              }
              case 's': {
                const r = reOf(c.re!);
                const re = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g');
                let result = '', last = 0, count = 0, did = false;
                let m: RegExpExecArray | null;
                while ((m = re.exec(ps)) !== null) {
                  count++;
                  if (count >= c.occurrence! && (c.global || count === c.occurrence)) {
                    result += ps.slice(last, m.index) + applyRepl(c.repl!, m);
                    last = m.index + m[0].length;
                    did = true;
                    if (!c.global) break;
                  }
                  if (m[0] === '') re.lastIndex++;
                }
                if (did) {
                  ps = result + ps.slice(last);
                  subst = true;
                  if (c.print) emit(ps);
                  if (c.wfile) wOut.set(c.wfile, wOut.get(c.wfile)! + ps + '\n');
                }
                break;
              }
              case 'b': pc = c.target!; continue;
              case 't': if (subst) { subst = false; pc = c.target!; continue; } break;
              case 'T': if (!subst) { pc = c.target!; continue; } subst = false; break;
              case 'n':
                if (!quiet) emit(ps, curNewline);
                // No next line: GNU sed ends without running the rest of the script.
                if (isLast()) { flushAppend(); deleted = true; break; }
                flushAppend();
                next(); subst = false;
                break;
              case 'N':
                if (isLast()) { pc = cmds.length; break; }   // GNU prints the pattern space and ends
                flushAppend();
                { const keep = ps; next(); ps = keep + '\n' + ps; }
                break;
              case 'q':
                exit = c.num ?? 0; pc = cmds.length; continue;
              case 'Q':
                exit = c.num ?? 0; deleted = true; pc = cmds.length; continue;
              case 'r': appendQueue.push(...(rFiles.get(c.file!) ?? [])); break;
              case 'R': {
                const lines = rFiles.get(c.file!) ?? [];
                const k = rCursor.get(c.file!) ?? 0;
                if (k < lines.length) { appendQueue.push(lines[k]); rCursor.set(c.file!, k + 1); }
                break;
              }
              case 'w': wOut.set(c.file!, wOut.get(c.file!)! + ps + '\n'); break;
              case 'W': wOut.set(c.file!, wOut.get(c.file!)! + ps.split('\n')[0] + '\n'); break;
            }
            if (deleted) break;
            pc++;
          }
          if (!deleted && !quiet) emit(ps, curNewline);
          flushAppend();
        } while (restart);
      }
      return { out, exit };
    };

    const writeOut = async () => {
      for (const [f, text] of wOut) {
        if (f === '/dev/stdout') ctx.stdout += text;
        else if (f === '/dev/stderr') ctx.stderr += text;
        else await ctx.fs.writeFile(ctx.fs.resolvePath(f, ctx.cwd), text);
      }
    };

    try {
      if (inPlace !== null) {
        for (const inp of inputs) {
          if (!inp.path) continue;
          const { out, exit } = run([inp]);
          if (inPlace) await ctx.fs.writeFile(inp.path + inPlace, (await ctx.fs.readFile(inp.path, 'utf8')) as string);
          await ctx.fs.writeFile(inp.path, out);
          if (exit !== null) { await writeOut(); return exit || status; }
        }
      } else if (separate) {
        for (const inp of inputs) {
          const { out, exit } = run([inp]);
          ctx.stdout += out;
          if (exit !== null) { await writeOut(); return exit || status; }
        }
      } else {
        const { out, exit } = run(inputs);
        ctx.stdout += out;
        if (exit !== null) { await writeOut(); return exit || status; }
      }
    } catch (e: any) {
      if (e instanceof SedError) { ctx.stderr += `sed: ${e.message}\n`; return 4; }
      throw e;
    }
    await writeOut();
    return status;
  },
};

async function readFileText(ctx: CommandContext, f: string): Promise<string> {
  return sharedReadFileText(ctx.fs, ctx.fs.resolvePath(f, ctx.cwd));
}
