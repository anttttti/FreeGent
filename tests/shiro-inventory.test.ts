import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const invoke = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/shiro-inventory.mjs', ...args], {cwd:root, encoding:'utf8'});
const snapshot = () => Object.fromEntries([
    ...readdirSync(join(root,'docs/shiro')).map(name => `docs/shiro/${name}`),
    'docs/shiro-commands-v0.61.md',
    'docs/shiro-commands-v0.61-historical.md',
].map(path => [path, {bytes:readFileSync(join(root,path)).toString('base64'),mtime:statSync(join(root,path)).mtimeMs}]));

describe('Shiro inventory CLI', () => {
    it('shows help without changing artifact bytes or modification times', () => {
        const before = snapshot();
        const result = invoke('--help');
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Usage:');
        expect(result.stdout).not.toContain('artifact identities:');
        expect(snapshot()).toEqual(before);
    });
    it.each([[], ['--wat'], ['--check','--update-note'], ['--help','--check'], ['unexpected-directory']])('rejects invalid arguments %j without writing', (...args) => {
        const before = snapshot();
        const result = invoke(...args);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage:');
        expect(snapshot()).toEqual(before);
    });
    it('retains every route name and consistent capability scope in the rendered inventory', () => {
        const data = JSON.parse(readFileSync(join(root,'docs/shiro/command-matrix.json'),'utf8'));
        const markdown = readFileSync(join(root,'docs/shiro/command-inventory.md'),'utf8');
        const groupTable = markdown.split('## Names grouped by current default route')[1].split('## Current routing checks')[0];
        for (const row of data.commands) expect(groupTable).toContain('`'+row.name+'`');
        for (const name of ['make','chown','ln','col','ulimit']) expect(data.commands.find((row:any)=>row.name===name).parityScope).toBe('capability-only');
        expect(data.artifacts).toHaveLength(29);
        const version = data.artifacts.find((row:any)=>row.name==='hexdump').version;
        expect(markdown).toContain(`| util-linux | hexdump | hexdump@${version} / hexdump |`);
    });
    it('checks the committed note and matrix without writing', () => {
        const before = snapshot();
        const result = invoke('--check');
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('no files written');
        expect(snapshot()).toEqual(before);
    }, 30000);
    it('detects stale and missing matrices without repairing them or creating directories', () => {
        const temp = mkdtempSync(join(tmpdir(),'shiro-inventory-'));
        try {
            for (const name of ['command-matrix.md','command-matrix.json','command-inventory.md','command-coverage.json']) copyFileSync(join(root,'docs/shiro',name),join(temp,name));
            expect(invoke('--check','--output-dir',temp).status).toBe(0);
            writeFileSync(join(temp,'command-matrix.md'),'stale\n');
            const before = snapshot();
            const stale = invoke('--check','--output-dir',temp);
            expect(stale.status).toBe(1);
            expect(stale.stderr).toContain('command-matrix.md');
            expect(readFileSync(join(temp,'command-matrix.md'),'utf8')).toBe('stale\n');
            const missing = invoke('--check','--output-dir',join(temp,'missing'));
            expect(missing.status).toBe(1);
            expect(readdirSync(temp)).not.toContain('missing');
            expect(snapshot()).toEqual(before);
        } finally { rmSync(temp,{recursive:true,force:true}); }
    }, 30000);
});
