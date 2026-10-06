/**
 * patch — apply a diff (GNU patch behaviour): unified, context and normal diffs, file names from the
 * headers (or the FILE operand), offset and fuzz search for hunks that moved, reversed-patch
 * detection, .rej files for hunks that do not apply, --dry-run, -R, -pN, -o, -b, -i, -d, -N, -s.
 */
import type { Command } from './index';
import { readFileText } from './flags';
import { toLines } from './flags';

function splitLines(text: string): { lines: string[]; endsNl: boolean } { const { lines, lastNl } = toLines(text); return { lines, endsNl: lastNl }; }

interface HunkLine { op: ' ' | '+' | '-'; text: string }
interface Hunk {
  oldStart: number;                 // 1-based line in the old file (0 when the old side is empty)
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
  oldNoNl: boolean;                 // the old side's last line has no trailing newline
  newNoNl: boolean;
}
interface FilePatch {
  oldName: string | null;
  newName: string | null;
  indexName: string | null;
  hunks: Hunk[];
  creates: boolean;
  deletes: boolean;
  normal: boolean;                  // a normal diff names no files
}

// ── parsing ──────────────────────────────────────────────────────────

function parsePatch(text: string): FilePatch[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let index: string | null = null;
  let gitNew = false, gitDel = false;
  const fresh = (): FilePatch => ({ oldName: null, newName: null, indexName: index, hunks: [], creates: gitNew, deletes: gitDel, normal: false });
  const nameOf = (s: string) => s.replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1').replace(/ \d{4}-\d\d-\d\d .*$/, '');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('Index: ')) { index = l.slice(7).trim(); i++; continue; }
    if (l.startsWith('diff --git ')) { gitNew = gitDel = false; index = null; cur = null; i++; continue; }
    if (l.startsWith('new file mode')) { gitNew = true; i++; continue; }
    if (l.startsWith('deleted file mode')) { gitDel = true; i++; continue; }
    // unified header
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      cur = fresh();
      cur.oldName = nameOf(l.slice(4));
      cur.newName = nameOf(lines[i + 1].slice(4));
      if (cur.oldName === '/dev/null') cur.creates = true;
      if (cur.newName === '/dev/null') cur.deletes = true;
      out.push(cur);
      index = null; gitNew = gitDel = false;
      i += 2;
      continue;
    }
    // context header
    if (l.startsWith('*** ') && lines[i + 1]?.startsWith('--- ') && lines[i + 2]?.startsWith('***************')) {
      cur = fresh();
      cur.oldName = nameOf(l.slice(4));
      cur.newName = nameOf(lines[i + 1].slice(4));
      if (cur.oldName === '/dev/null') cur.creates = true;
      if (cur.newName === '/dev/null') cur.deletes = true;
      out.push(cur);
      index = null; gitNew = gitDel = false;
      i += 2;
      continue;
    }
    // unified hunk
    let m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && cur) {
      const h: Hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [], oldNoNl: false, newNoNl: false };
      let o = 0, n = 0;
      i++;
      while (i < lines.length && (o < h.oldCount || n < h.newCount || lines[i].startsWith('\\'))) {
        const t = lines[i];
        if (t.startsWith('\\')) {
          const prev = h.lines[h.lines.length - 1];
          if (prev) { if (prev.op !== '+') h.oldNoNl = true; if (prev.op !== '-') h.newNoNl = true; }
          i++; continue;
        }
        const op = t[0] === '+' || t[0] === '-' ? t[0] : ' ';
        if (t === '' ) { h.lines.push({ op: ' ', text: '' }); o++; n++; i++; continue; }   // blank context line whose space was stripped
        if (op === ' ') { o++; n++; } else if (op === '-') o++; else n++;
        h.lines.push({ op, text: t.slice(1) });
        i++;
      }
      cur.hunks.push(h);
      continue;
    }
    // context hunk
    if (l.startsWith('***************') && cur) {
      const mo = /^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*/.exec(lines[i + 1] ?? '');
      if (!mo) { i++; continue; }
      const oldStart = +mo[1], oldEnd = mo[2] === undefined ? +mo[1] : +mo[2];
      i += 2;
      const oldSide: HunkLine[] = [];
      const oldMark: string[] = [];
      while (i < lines.length && !/^--- (\d+)(?:,(\d+))? ----/.test(lines[i]) && !lines[i].startsWith('***************')) {
        const t = lines[i];
        if (t.startsWith('\\')) { i++; continue; }
        oldMark.push(t[0] ?? ' ');
        oldSide.push({ op: t[0] === '-' || t[0] === '!' ? '-' : ' ', text: t.slice(2) });
        i++;
      }
      const mn = /^--- (\d+)(?:,(\d+))? ----/.exec(lines[i] ?? '');
      if (!mn) { i++; continue; }
      const newStart = +mn[1], newEnd = mn[2] === undefined ? +mn[1] : +mn[2];
      i++;
      const newSide: HunkLine[] = [];
      while (i < lines.length && !lines[i].startsWith('***************') && !lines[i].startsWith('*** ') && !(lines[i].startsWith('diff ') || lines[i].startsWith('Index: '))) {
        const t = lines[i];
        if (t.startsWith('\\')) { i++; continue; }
        newSide.push({ op: t[0] === '+' || t[0] === '!' ? '+' : ' ', text: t.slice(2) });
        i++;
      }
      // merge: context lines are shared; a block of removals precedes the matching additions
      const merged: HunkLine[] = [];
      let a = 0, b = 0;
      const oldEmpty = oldEnd < oldStart || oldSide.every(x => x.op === ' ') && oldSide.length === 0;
      while (a < oldSide.length || b < newSide.length) {
        if (a < oldSide.length && oldSide[a].op === ' ' && b < newSide.length && newSide[b].op === ' ') { merged.push(oldSide[a]); a++; b++; continue; }
        let moved = false;
        while (a < oldSide.length && oldSide[a].op === '-') { merged.push(oldSide[a++]); moved = true; }
        while (b < newSide.length && newSide[b].op === '+') { merged.push(newSide[b++]); moved = true; }
        if (!moved) {
          // one side has no context lines listed (a hunk with only additions or only deletions)
          if (a < oldSide.length && oldSide[a].op === ' ' && b >= newSide.length) { merged.push(oldSide[a++]); continue; }
          if (b < newSide.length && newSide[b].op === ' ' && a >= oldSide.length) { merged.push(newSide[b++]); continue; }
          break;
        }
      }
      void oldEmpty;
      cur.hunks.push({
        oldStart, oldCount: merged.filter(x => x.op !== '+').length, newStart, newCount: merged.filter(x => x.op !== '-').length,
        lines: merged, oldNoNl: false, newNoNl: false,
      });
      void oldMark;
      continue;
    }
    // normal diff: 3c3,4 / 3a4 / 3,5d2 followed by < and > lines
    m = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(l);
    if (m) {
      if (!cur || !cur.normal) { cur = fresh(); cur.normal = true; out.push(cur); }
      const os = +m[1], oe = m[2] === undefined ? os : +m[2], kind = m[3], ns = +m[4], ne = m[5] === undefined ? ns : +m[5];
      i++;
      const hl: HunkLine[] = [];
      let nOld = kind === 'a' ? 0 : oe - os + 1, nNew = kind === 'd' ? 0 : ne - ns + 1;
      while (i < lines.length && (nOld > 0 || nNew > 0 || lines[i] === '---' || lines[i].startsWith('\\'))) {
        const t = lines[i];
        if (t === '---') { i++; continue; }
        if (t.startsWith('\\')) { i++; continue; }
        if (t.startsWith('< ') && nOld > 0) { hl.push({ op: '-', text: t.slice(2) }); nOld--; }
        else if (t.startsWith('> ') && nNew > 0) { hl.push({ op: '+', text: t.slice(2) }); nNew--; }
        else break;
        i++;
      }
      cur.hunks.push({
        oldStart: os, oldCount: hl.filter(x => x.op === '-').length,
        newStart: ns, newCount: hl.filter(x => x.op === '+').length,
        lines: hl, oldNoNl: false, newNoNl: false,
      });
      continue;
    }
    i++;
  }
  return out;
}

// ── applying ─────────────────────────────────────────────────────────

interface Applied { text: string; results: { ok: boolean; at: number; offset: number; fuzz: number }[]; failed: Hunk[] }


function sides(h: Hunk, reverse: boolean) {
  const oldL = h.lines.filter(x => (reverse ? x.op !== '-' : x.op !== '+')).map(x => x.text);
  const newL = h.lines.filter(x => (reverse ? x.op !== '+' : x.op !== '-')).map(x => x.text);
  return { oldL, newL, oldNoNl: reverse ? h.newNoNl : h.oldNoNl, newNoNl: reverse ? h.oldNoNl : h.newNoNl };
}

function applyHunks(original: string, hunks: Hunk[], reverse: boolean, maxFuzz = 2, ignoreWs = false): Applied {
  let { lines, endsNl } = splitLines(original);
  const results: Applied['results'] = [];
  const failed: Hunk[] = [];
  let shift = 0;                                   // how far earlier hunks moved the line numbers / were found displaced
  const norm = (s: string) => (ignoreWs ? s.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '') : s);
  for (const h of hunks) {
    const { oldL, newL, oldNoNl, newNoNl } = sides(h, reverse);
    const startLine = (reverse ? h.newStart : h.oldStart);
    // leading / trailing context count (lines that are context at the edges)
    const ops = h.lines.map(x => x.op);
    let pre = 0; while (pre < ops.length && ops[pre] === ' ') pre++;
    let suf = 0; while (suf < ops.length - pre && ops[ops.length - 1 - suf] === ' ') suf++;
    const expected = (oldL.length === 0 ? startLine : startLine - 1) + shift;
    let placed = false;
    for (let fuzz = 0; fuzz <= maxFuzz && !placed; fuzz++) {
      const dropPre = Math.min(fuzz, pre), dropSuf = Math.min(fuzz, suf);
      const core = oldL.slice(dropPre, oldL.length - dropSuf);
      const coreNew = newL.slice(dropPre, newL.length - dropSuf);
      const base = expected + dropPre;
      const fits = (pos: number) => {
        if (pos < 0 || pos + core.length > lines.length) return false;
        for (let k = 0; k < core.length; k++) if (norm(lines[pos + k]) !== norm(core[k])) return false;
        // a hunk that reaches the end of the old side must also agree about the missing final newline
        if (!oldNoNl && !endsNl && pos + core.length === lines.length && dropSuf === 0 && core.length) return false;
        return true;
      };
      for (let d = 0; d <= lines.length + core.length && !placed; d++) {
        for (const dir of d === 0 ? [0] : [1, -1]) {
          const pos = base + dir * d;
          if (!fits(pos)) continue;
          const at = pos - dropPre;
          lines.splice(pos, core.length, ...coreNew);
          if (pos + coreNew.length === lines.length) endsNl = !newNoNl;
          const offset = pos - base;
          shift += offset;       // later hunks are searched around where this one landed
          results.push({ ok: true, at: at + 1, offset, fuzz });
          placed = true;
          break;
        }
      }
    }
    if (!placed) { results.push({ ok: false, at: expected + 1, offset: 0, fuzz: 0 }); failed.push(h); }
    else shift += newL.length - oldL.length;
  }
  const text = lines.length === 0 ? '' : lines.join('\n') + (endsNl ? '\n' : '');
  return { text, results, failed };
}

function rejText(oldName: string, newName: string, hunks: Hunk[]): string {
  let s = `--- ${oldName}\n+++ ${newName}\n`;
  for (const h of hunks) {
    s += `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n`;
    for (const l of h.lines) s += l.op + l.text + '\n';
  }
  return s;
}

// ── file name selection (GNU best_name) ──────────────────────────────

function strip(name: string, n: number): string {
  if (n < 0) return name;
  let s = name;
  for (let k = 0; k < n; k++) {
    const i = s.search(/\/+/);
    if (i < 0) return s.slice(s.length);
    s = s.slice(s.indexOf('/', i) + s.slice(i).match(/^\/+/)![0].length);
  }
  return s;
}

export const patch: Command = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(ctx) {
    const a = ctx.args;
    let stripN = -1, reverse = false, dry = false, silent = false, forward = false, backup = false, ignoreWs = false, force = false;
    let input: string | null = null, output: string | null = null, dir: string | null = null, rejFile: string | null = null;
    let fuzzMax = 2, removeEmpty = false;
    const operands: string[] = [];
    const bad = (m: string) => { ctx.stderr += `patch: **** ${m}\n`; return 2; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      if (x === '-R' || x === '--reverse') reverse = true;
      else if (x === '--dry-run') dry = true;
      else if (x === '-s' || x === '--silent' || x === '--quiet') silent = true;
      else if (x === '-N' || x === '--forward') forward = true;
      else if (x === '-b' || x === '--backup') backup = true;
      else if (x === '-l' || x === '--ignore-whitespace') ignoreWs = true;
      else if (x === '-f' || x === '--force' || x === '-t' || x === '--batch') force = true;
      else if (x === '-E' || x === '--remove-empty-files') removeEmpty = true;
      else if (x === '--no-backup-if-mismatch' || x === '--backup-if-mismatch' || x === '-u' || x === '--unified' || x === '-c' || x === '--context' || x === '-n' || x === '--normal' || x === '--binary' || x === '-g0' || x === '--posix') { /* accepted */ }
      else if (x.startsWith('-p') && x.length > 2) stripN = parseInt(x.slice(2), 10);
      else if (x === '-p') stripN = parseInt(a[++i], 10);
      else if (x.startsWith('--strip=')) stripN = parseInt(x.slice(8), 10);
      else if (x === '-i' || x === '--input') input = a[++i] ?? null;
      else if (x.startsWith('--input=')) input = x.slice(8);
      else if (x.startsWith('-i') && x.length > 2) input = x.slice(2);
      else if (x === '-o' || x === '--output') output = a[++i] ?? null;
      else if (x.startsWith('--output=')) output = x.slice(9);
      else if (x.startsWith('-o') && x.length > 2) output = x.slice(2);
      else if (x === '-d' || x === '--directory') dir = a[++i] ?? null;
      else if (x.startsWith('--directory=')) dir = x.slice(12);
      else if (x === '-r' || x === '--reject-file') rejFile = a[++i] ?? null;
      else if (x.startsWith('--reject-file=')) rejFile = x.slice(14);
      else if (x.startsWith('-F') && x.length > 2) fuzzMax = parseInt(x.slice(2), 10);
      else if (x === '-F') fuzzMax = parseInt(a[++i], 10);
      else if (x.startsWith('--fuzz=')) fuzzMax = parseInt(x.slice(7), 10);
      else if (x.startsWith('-') && x.length > 1) return bad(`unrecognized option '${x}'`);
      else operands.push(x);
    }
    const base = dir ? ctx.fs.resolvePath(dir, ctx.cwd) : ctx.cwd;
    const say = (s: string) => { if (!silent) ctx.stdout += s + '\n'; };

    // the patch text and the file operand (old-style: patch ORIGFILE < diff)
    let text: string;
    try {
      text = input ? await readFileText(ctx.fs, ctx.fs.resolvePath(input, ctx.cwd)) : ctx.stdin;
    } catch { return bad(`Can't open patch file ${input}: No such file or directory`); }
    const patches = parsePatch(text);
    if (patches.length === 0) { ctx.stderr += 'patch: **** Only garbage was found in the patch input.\n'; return 2; }
    const operandFile = operands[0] ?? null;

    const exists = async (p: string) => { try { return !!(await ctx.fs.stat(ctx.fs.resolvePath(p, base))); } catch { return false; } };
    let status = 0;
    for (const fp of patches) {
      // which file: the operand, else the best of the header names that exists
      let target: string | null = operandFile;
      if (!target) {
        const names = [fp.oldName, fp.newName, fp.indexName].filter((n): n is string => !!n && n !== '/dev/null').map(n => strip(n, stripN < 0 ? 0 : stripN));
        const present: string[] = [];
        for (const n of names) if (n && await exists(n)) present.push(n);
        const pool = present.length ? present : names;
        const rank = (n: string) => [n.split('/').length, n.split('/').pop()!.length, n.length];
        target = pool.slice().sort((p, q) => { const rp = rank(p), rq = rank(q); for (let k = 0; k < 3; k++) if (rp[k] !== rq[k]) return rp[k] - rq[k]; return 0; })[0] ?? null;
      }
      if (!target) { ctx.stderr += `patch: **** Can't find file to patch at input line ${1}\n`; status = Math.max(status, 1); continue; }
      const full = ctx.fs.resolvePath(target, base);
      let original = '';
      let present = true;
      try { original = await readFileText(ctx.fs, full); } catch { present = false; }
      if (!present && !(fp.creates || fp.hunks.every(h => h.oldCount === 0)) ) {
        ctx.stderr += `patch: **** Can't open file ${target} : No such file or directory\n`;
        status = Math.max(status, 1);
        continue;
      }
      const outName = output ?? target;
      say(`${dry ? 'checking' : 'patching'} file ${outName}${output ? ` (read from ${target})` : ''}`);

      let rev = reverse;
      let res = applyHunks(original, fp.hunks, rev, fuzzMax, ignoreWs);
      // every hunk fails forward but all fit in reverse: the patch is already applied (or reversed)
      if (res.failed.length === fp.hunks.length && fp.hunks.length > 0 && !(fp.creates && !present)) {
        const back = applyHunks(original, fp.hunks, !rev, fuzzMax, ignoreWs);
        if (back.failed.length === 0) {
          if (forward) {
            say('Reversed (or previously applied) patch detected!  Skipping patch.');
            say(`${fp.hunks.length} out of ${fp.hunks.length} hunk${fp.hunks.length > 1 ? 's' : ''} ignored`);
            status = Math.max(status, 1);
            continue;
          }
          say(`${rev ? 'Unreversed' : 'Reversed'} (or previously applied) patch detected!  Assume -R? [${force ? 'y' : 'n'}] ${force ? '' : ''}`);
          if (force) { rev = !rev; res = back; }
          else {
            say('Apply anyway? [n] ');
            say('Skipping patch.');
            const rej = rejFile ?? `${outName}.rej`;
            say(`${fp.hunks.length} out of ${fp.hunks.length} hunk${fp.hunks.length > 1 ? 's' : ''} ignored -- saving rejects to file ${rej}`);
            if (!dry) await ctx.fs.writeFile(ctx.fs.resolvePath(rej, base), rejText(fp.oldName ?? target, fp.newName ?? target, fp.hunks));
            status = Math.max(status, 1);
            continue;
          }
        }
      }
      fp.hunks.forEach((h, idx) => {
        const r = res.results[idx];
        if (r.ok) {
          if (r.offset !== 0 || r.fuzz) {
            const parts = [`succeeded at ${r.at}`];
            if (r.fuzz) parts.push(`with fuzz ${r.fuzz}`);
            if (r.offset !== 0) parts.push(`(offset ${r.offset} line${Math.abs(r.offset) === 1 ? '' : 's'})`);
            say(`Hunk #${idx + 1} ${parts.join(' ')}.`);
          }
        } else say(`Hunk #${idx + 1} FAILED at ${r.at}.`);
      });
      if (res.failed.length) {
        const rej = rejFile ?? `${outName}.rej`;
        say(`${res.failed.length} out of ${fp.hunks.length} hunk${fp.hunks.length > 1 ? 's' : ''} FAILED -- saving rejects to file ${rej}`);
        if (!dry) await ctx.fs.writeFile(ctx.fs.resolvePath(rej, base), rejText(fp.oldName ?? target, fp.newName ?? target, res.failed));
        status = Math.max(status, 1);
      }
      if (dry) continue;
      const outPath = ctx.fs.resolvePath(outName, base);
      if (backup && present && !output) await ctx.fs.writeFile(ctx.fs.resolvePath(target + '.orig', base), original);
      if ((fp.deletes && !rev || (fp.creates && rev)) && res.text === '' && present && !res.failed.length) {
        try { await ctx.fs.unlink(outPath); } catch { /* already gone */ }
      } else if (removeEmpty && res.text === '' && present && !output) {
        try { await ctx.fs.unlink(outPath); } catch { /* already gone */ }
      } else {
        const slash = outPath.lastIndexOf('/');
        if (slash > 0) { try { await ctx.fs.mkdir(outPath.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
        await ctx.fs.writeFile(outPath, res.text);
      }
    }
    return status;
  },
};
