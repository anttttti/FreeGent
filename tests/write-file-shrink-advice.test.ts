// write-file-shrink-advice.test.ts — the write_file shrink guard may only recommend tools the caller
// can actually call. v0.64: the headless Director had write_file but not replace_in_file or
// apply_patch, and the guard told it to use them (28 attempts in the SWE runs, all rejected; 77
// shrink rejections). The prompt's Write line also promised "edit, patch, or delete" for write_file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDirectorHeadlessTools } from '../workers.ts';
import { enabledTools } from '../config.ts';

const W = globalThis as any;

const BIG = Array.from({ length: 40 }, (_, i) => `def f${i}():\n    return ${i}   # padding to exceed the 600-char guard\n`).join('\n');
const role = (...tools: string[]) => ({ name: 'director', tools: new Set(tools) });

let files: Map<string, string>;
let orig: Record<string, any>;
let toolsBefore: string[];

beforeEach(() => {
    files = new Map([['big.py', BIG]]);
    // The advice follows the tools the schema offers, so the editing tools are enabled here (as --enable-tools does headless).
    toolsBefore = [...enabledTools];
    for (const t of ['replace_in_file', 'apply_patch', 'execute_code', 'write_file', 'read_file']) enabledTools.add(t);
    orig = { r: W.agentReadFile, w: W.agentWriteFile, d: W.agentDeleteFile, l: W.agentListFiles, role: W.mainAgentRole };
    W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
    W.agentDeleteFile = async (p: string) => { files.delete(p); };
    W.agentListFiles = async () => [...files.keys()];
});
afterEach(() => {
    W.agentReadFile = orig.r; W.agentWriteFile = orig.w; W.agentDeleteFile = orig.d; W.agentListFiles = orig.l;
    W.mainAgentRole = orig.role;
    enabledTools.clear(); for (const t of toolsBefore) enabledTools.add(t);
});

const shrink = async (context: any = null) => W.executeToolAsync('write_file', { path: 'big.py', content: 'def f0():\n    return 0\n' }, context);

describe('shrink advice follows the caller\'s tools', () => {
    it('headless Director (write_file + execute_code): points at execute_code, never at replace_in_file/apply_patch', async () => {
        W.mainAgentRole = role('read_file', 'write_file', 'execute_code', 'run_workers');
        const r = await shrink();
        expect(r.error).toMatch(/Content shrank from \d+ to \d+ chars/);
        expect(r.error).toContain('execute_code');
        expect(r.error).not.toMatch(/replace_in_file|apply_patch/);
        expect(files.get('big.py')).toBe(BIG);                       // the guard still protects the file
    });

    it('names replace_in_file when --enable-tools gave the Director it, and not apply_patch', async () => {
        W.mainAgentRole = role('write_file', 'replace_in_file', 'execute_code');
        const r = await shrink();
        expect(r.error).toContain('Use replace_in_file for targeted edits');
        expect(r.error).not.toContain('apply_patch');
    });

    it('with neither a surgical tool nor execute_code, only the rewrite-in-full advice remains', async () => {
        W.mainAgentRole = role('write_file');
        const r = await shrink();
        expect(r.error).toContain('include ALL existing sections');
        expect(r.error).not.toMatch(/replace_in_file|apply_patch|execute_code/);
    });

    it('keeps the original wording when the caller has no role restriction (WebUI)', async () => {
        W.mainAgentRole = null;
        const r = await shrink();
        expect(r.error).toContain('Use replace_in_file or apply_patch for targeted edits, or read the file first and include ALL existing sections in your write.');
    });

    it('a worker is advised from its own allowlist, not the main role\'s', async () => {
        W.mainAgentRole = role('write_file', 'replace_in_file', 'apply_patch', 'execute_code');
        const ctx = { staging: new Map(), snapshot: { get: async (p: string) => files.get(p) ?? null }, allowedTools: new Set(['write_file', 'apply_patch']) };
        const r = await shrink(ctx);
        expect(r.error).toContain('Use apply_patch for targeted edits');
        expect(r.error).not.toContain('replace_in_file');
    });
});

describe('shrink advice follows the enabled tools', () => {
    it('does not recommend replace_in_file/apply_patch once they are disabled, though the role ceiling allows them', async () => {
        W.mainAgentRole = role('write_file', 'replace_in_file', 'apply_patch', 'execute_code');
        enabledTools.delete('replace_in_file'); enabledTools.delete('apply_patch');
        const r = await shrink();
        expect(r.error).not.toMatch(/replace_in_file|apply_patch/);
        expect(r.error).toContain('execute_code');
    });
});

describe('replay: a shrink rejection leads to a successful change', () => {
    it('Director without surgical tools: rejection, then the full file with one change is accepted', async () => {
        W.mainAgentRole = role('write_file', 'execute_code');
        expect((await shrink()).error).toMatch(/shrank/);
        const edited = BIG.replace('return 7 ', 'return 700 ');
        const r = await W.executeToolAsync('write_file', { path: 'big.py', content: edited }, null);
        expect(r.success).toBe(true);
        expect(files.get('big.py')).toBe(edited);
        expect(files.get('big.py')!.length).toBe(BIG.length + 2);    // nothing else dropped
    });

    it('Director with replace_in_file: rejection, then a targeted edit leaves the rest of the file intact', async () => {
        W.mainAgentRole = role('write_file', 'replace_in_file', 'execute_code');
        expect((await shrink()).error).toContain('Use replace_in_file');
        const r = await W.executeToolAsync('replace_in_file', { path: 'big.py', old_string: 'return 7 ', new_string: 'return 700 ' }, null);
        expect(r.error).toBeUndefined();
        expect(files.get('big.py')).toBe(BIG.replace('return 7 ', 'return 700 '));
    });
});

describe('Director prompt Write line', () => {
    let origExec: any, added: string[];
    beforeEach(() => {
        origExec = W.nativeExec; W.nativeExec = () => {};                          // headless branch
        // headless-runner enables the edit tools for the coder workers; the Director's ceiling has write_file and replace_in_file
        added = ['write_file', 'replace_in_file', 'apply_patch'].filter(t => !W.enabledTools.has(t));
        added.forEach(t => W.enabledTools.add(t));
    });
    afterEach(() => { W.nativeExec = origExec; setDirectorHeadlessTools([]); added.forEach(t => W.enabledTools.delete(t)); });

    it('does not promise edit/patch/delete when write_file is the only write tool', () => {
        W.enabledTools.delete('replace_in_file');   // e.g. --disable-tools replace_in_file
        const line = W.rolesRegistry.get('director').body_fn().split('\n').find((l: string) => l.includes('**Write**'));
        expect(line).toBeDefined();
        expect(line).toContain('write_file');
        expect(line).not.toMatch(/edit, patch, or delete/);
        expect(line).not.toContain('replace_in_file');
        expect(line).toContain('execute_code');
    });

    it('tells the Director to edit existing files with replace_in_file, not sed or a script', () => {
        const line = W.rolesRegistry.get('director').body_fn().split('\n').find((l: string) => l.includes('**Write**'));
        expect(line).toContain('replace_in_file: edit an existing file');
        expect(line).toMatch(/instead of sed or a script/);
        expect(line).not.toContain('apply_patch');
    });

    it('keeps the general wording when the Director has more write tools', () => {
        setDirectorHeadlessTools(['apply_patch']);
        const line = W.rolesRegistry.get('director').body_fn().split('\n').find((l: string) => l.includes('**Write**'));
        expect(line).toContain('apply_patch');
        expect(line).toMatch(/create, edit, patch, or delete files/);
    });
});

describe('fg-tasks/current.md is the scratch task and may be replaced by a shorter one', () => {
    it('is overwritten without a shrink error, while any other large file is still guarded', async () => {
        W.mainAgentRole = role('read_file', 'write_file', 'execute_code');
        const old = '---\nid: 036\nstatus: done\n---\n' + BIG;
        files.set('fg-tasks/current.md', old);
        const r = await W.executeToolAsync('write_file', { path: 'fg-tasks/current.md', content: '---\nid: current\nstatus: in-progress\n---\n# New request\n' }, null);
        expect(r.error).toBeUndefined();
        expect(files.get('fg-tasks/current.md')).toContain('# New request');
        files.set('fg-tasks/036-t.md', old);
        const r2 = await W.executeToolAsync('write_file', { path: 'fg-tasks/036-t.md', content: '# short\n' }, null);
        expect(r2.error).toMatch(/Content shrank/);
    });
});

describe('execute_code with the script inside the language value', () => {
    it('runs it instead of answering "No code provided"', async () => {
        W.mainAgentRole = role('execute_code');
        const r = await W.executeToolAsync('execute_code', { language: 'bash">\necho hi', code: '' }, null);
        expect(r.error ?? '').not.toMatch(/No code provided/);
    });
});

describe('abbreviated-history writes: escalation', () => {
    it('names the loop from the third refusal on', async () => {
        const { resetLookalikeRefusals } = await import('../tools.ts');
        resetLookalikeRefusals();
        W.mainAgentRole = role('read_file', 'write_file', 'replace_in_file', 'execute_code');
        files.set('srv.py', BIG);
        const call = () => W.executeToolAsync('write_file', { path: 'srv.py', content: '--- srv.py\n+++ srv.py\n@@ -1,2 +1,2 @@\n-a\n+b\n', _contentCompressed: true }, null);
        const r1 = await call(); const r2 = await call(); const r3 = await call();
        expect(r1.error).toMatch(/NOT changed/); expect(r1.error).not.toMatch(/3rd time/);
        expect(r2.error).not.toMatch(/3rd time/);
        expect(r3.error).toMatch(/3rd time[\s\S]*replace_in_file with only the lines that differ/);
        expect(files.get('srv.py')).toBe(BIG);
    });
});

describe('execute_code timeout_s', () => {
    it('clamps a requested timeout and falls back to 120 s', async () => {
        const { execTimeoutMs, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MAX_MS } = await import('../exec-limits.ts');
        expect(execTimeoutMs(undefined)).toBe(EXEC_TIMEOUT_MS);
        expect(execTimeoutMs('abc')).toBe(EXEC_TIMEOUT_MS);
        expect(execTimeoutMs(300)).toBe(300_000);
        expect(execTimeoutMs(99999)).toBe(EXEC_TIMEOUT_MAX_MS);
        expect(execTimeoutMs(-5)).toBe(EXEC_TIMEOUT_MS);
    });
});
