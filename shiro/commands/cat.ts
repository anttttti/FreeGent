import type { Command } from './index';
import { readOperands } from './flags';

// GNU cat: -n / -b numbering (continuing across files), -s squeeze blank lines, -E "$" at line
// ends, -T "^I" for tabs, -v "^X"/"M-" for other non-printables, -A = -vET, -e = -vE, -t = -vT.
function showNonprinting(s: string, tabs: boolean): string {
  let out = '';
  for (const ch of new TextEncoder().encode(s)) {
    let c = ch;
    let pre = '';
    if (c >= 128) { pre = 'M-'; c -= 128; }
    if (c === 9 && !tabs && !pre) { out += '\t'; continue; }
    if (c < 32) out += pre + '^' + String.fromCharCode(c + 64);
    else if (c === 127) out += pre + '^?';
    else out += pre + String.fromCharCode(c);
  }
  return out;
}

export const cat: Command = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(ctx) {
    let number = false, nonblank = false, squeeze = false, ends = false, tabs = false, nonprint = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a === '-' || !a.startsWith('-')) { files.push(a); continue; }
      const long: Record<string, string> = { '--number': 'n', '--number-nonblank': 'b', '--squeeze-blank': 's',
        '--show-ends': 'E', '--show-tabs': 'T', '--show-nonprinting': 'v', '--show-all': 'A' };
      for (const ch of a.startsWith('--') ? (long[a] ?? '') : a.slice(1)) {
        if (ch === 'n') number = true;
        else if (ch === 'b') nonblank = true;
        else if (ch === 's') squeeze = true;
        else if (ch === 'E') ends = true;
        else if (ch === 'T') tabs = true;
        else if (ch === 'v') nonprint = true;
        else if (ch === 'A') { nonprint = tabs = ends = true; }
        else if (ch === 'e') { nonprint = ends = true; }
        else if (ch === 't') { nonprint = tabs = true; }
      }
    }
    const inputs = await readOperands(ctx, 'cat', files);
    const plain = !number && !nonblank && !squeeze && !ends && !tabs && !nonprint;
    let lineNo = 0;
    let prevBlank = false;
    let atLineStart = true;
    for (const { text } of inputs) {
      if (plain) { ctx.stdout += text; continue; }
      // Process line by line; a line without a final newline continues into the next file.
      const parts = text.split('\n');
      parts.forEach((line, k) => {
        const hasNl = k < parts.length - 1;
        if (!hasNl && line === '') return;
        const blank = atLineStart && line === '' && hasNl;
        if (squeeze && blank && prevBlank) return;
        let out = nonprint ? showNonprinting(line, tabs) : tabs ? line.replace(/\t/g, '^I') : line;
        if (atLineStart && ((nonblank && line !== '') || (number && !nonblank))) out = `${String(++lineNo).padStart(6)}\t` + out;
        if (hasNl) out += (ends ? '$' : '') + '\n';
        ctx.stdout += out;
        if (atLineStart) prevBlank = blank;
        atLineStart = hasNl;
      });
    }
    return inputs.failed ? 1 : 0;
  },
};
