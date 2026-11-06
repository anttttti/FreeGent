import { beforeEach, afterEach, expect, it } from 'vitest';
import { executeToolAsync, resetLookalikeRefusals } from '../tools.ts';
import { enabledTools } from '../config.ts';
const W = window as any;
let role: any, tools: string[];
const args = { path: 'review-report.md', content: 'short replacement\n' };
const context = () => ({ snapshot: new Map([[args.path, 'Original report section.\n'.repeat(100)]]), staging: new Map(), allowedTools: new Set(['write_file']), depth: 0 });
beforeEach(() => { role = W.mainAgentRole; W.mainAgentRole = null; tools = [...enabledTools]; enabledTools.add('write_file'); resetLookalikeRefusals(); });
afterEach(() => { W.mainAgentRole = role; enabledTools.clear(); tools.forEach(t => enabledTools.add(t)); resetLookalikeRefusals(); });
it('positive control: the same worker can confirm its own identical shrink', async () => {
  const ctx = context();
  expect((await executeToolAsync('write_file', args, ctx)).error).toMatch(/shrank/);
  expect((await executeToolAsync('write_file', args, ctx)).success).toBe(true);
  expect(ctx.staging.get(args.path)).toBe(args.content);
});
it('does not treat another workers first call as confirmation of an unrelated refusal', async () => {
  const a = context(), b = context();
  expect((await executeToolAsync('write_file', args, a)).error).toMatch(/shrank/);
  const firstCallByB = await executeToolAsync('write_file', args, b);
  expect(b.staging.has(args.path)).toBe(false);
  expect(firstCallByB.error).toMatch(/shrank/);
});
