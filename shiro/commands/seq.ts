import type { Command } from './index';
import { sprintf } from './awk';

// GNU seq: [FIRST [INCREMENT]] LAST, -s separator (the last number ends with a newline), -w equal
// width (zero padded), -f printf format. Decimal places follow the widest of the operands.
export const seq: Command = {
  name: "seq",
  description: "Print a sequence of numbers",
  async exec(ctx) {
    let sep = '\n', equal = false, format: string | null = null;
    const nums: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '--separator') sep = args[++i];
      else if (a.startsWith('--separator=')) sep = a.slice(12);
      else if (a.startsWith('-s') && a.length > 2) sep = a.slice(2);
      else if (a === '-w' || a === '--equal-width') equal = true;
      else if (a === '-f' || a === '--format') format = args[++i];
      else if (a.startsWith('--format=')) format = a.slice(9);
      else if (a.startsWith('-f') && a.length > 2) format = a.slice(2);
      else nums.push(a);
    }
    if (!nums.length || nums.length > 3) { ctx.stderr += `seq: ${nums.length ? 'extra operand' : 'missing operand'}\n`; return 1; }
    for (const n of nums) if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(n)) { ctx.stderr += `seq: invalid floating point argument: '${n}'\n`; return 1; }
    const [first, step, last] = nums.length === 1 ? ['1', '1', nums[0]] : nums.length === 2 ? [nums[0], '1', nums[1]] : nums;
    const decimals = (s: string) => /e/i.test(s) ? 0 : (s.split('.')[1] ?? '').length;
    const prec = Math.max(decimals(first), decimals(step));
    const a = parseFloat(first), d = parseFloat(step), z = parseFloat(last);
    if (d === 0) { ctx.stderr += `seq: invalid Zero increment value: '${step}'\n`; return 1; }
    const values: string[] = [];
    for (let k = 0; ; k++) {
      const v = a + k * d;
      if (d > 0 ? v > z + 1e-10 : v < z - 1e-10) break;
      values.push(format ? sprintf(format, [v]) : v.toFixed(prec));
    }
    let out = values;
    if (equal && !format) {
      const w = Math.max(...values.map(v => v.replace('-', '').length));
      out = values.map(v => v.startsWith('-') ? '-' + v.slice(1).padStart(w, '0') : v.padStart(w, '0'));
    }
    ctx.stdout += out.length ? out.join(sep) + '\n' : '';
    return 0;
  },
};
