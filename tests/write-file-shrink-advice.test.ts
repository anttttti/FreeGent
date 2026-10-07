// write-file-shrink-advice.test.ts — the write_file shrink guard may only recommend tools the caller
// can actually call. v0.64: the headless Director had write_file but not replace_in_file or
// apply_patch, and the guard told it to use them (28 attempts in the SWE runs, all rejected; 77
// shrink rejections). The prompt's Write line also promised "edit, patch, or delete" for write_file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDirectorHeadlessTools } from '../workers.ts';

const W = globalThis as any;

const BIG = Array.from({ length: 40 }, (_, i) => `def f${i}():\n    return ${i}   # padding to exceed the 600-char guard\n`).join('\n');
const role = (...tools: string[]) => ({ name: 'director', tools: new Set(tools) });

let files: Map<string, string>;
let orig: Record<string, any>;

beforeEach(() => {
    files = new Map([['big.py', BIG]]);
    orig = { r: W.agentReadFile, w: W.agentWriteFile, d: W.agentDeleteFile, l: W.agentListFiles, role: W.mainAgentRole };
    W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
    W.agentDeleteFile = async (p: string) => { files.delete(p); };
    W.agentListFiles = async () => [...files.keys()];
});
afterEach(() => {
    W.agentReadFile = orig.r; W.agentWriteFile = orig.w; W.agentDeleteFile = orig.d; W.agentListFiles = orig.l;
    W.mainAgentRole = orig.role;
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
        // headless-runner enables the edit tools for the coder workers; the Director's ceiling still has only write_file
        added = ['write_file', 'replace_in_file', 'apply_patch'].filter(t => !W.enabledTools.has(t));
        added.forEach(t => W.enabledTools.add(t));
    });
    afterEach(() => { W.nativeExec = origExec; setDirectorHeadlessTools([]); added.forEach(t => W.enabledTools.delete(t)); });

    it('does not promise edit/patch/delete when write_file is the only write tool', () => {
        const line = W.rolesRegistry.get('director').body_fn().split('\n').find((l: string) => l.includes('**Write**'));
        expect(line).toBeDefined();
        expect(line).toContain('write_file');
        expect(line).not.toMatch(/edit, patch, or delete/);
        expect(line).toContain('execute_code');
    });

    it('keeps the general wording when the Director has more write tools', () => {
        setDirectorHeadlessTools(['replace_in_file']);
        const line = W.rolesRegistry.get('director').body_fn().split('\n').find((l: string) => l.includes('**Write**'));
        expect(line).toContain('replace_in_file');
        expect(line).toMatch(/create, edit, patch, or delete files/);
    });
});
