import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, writeFileSync, statSync, rmSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const repository = resolve(import.meta.dirname, '..');
let root: string;
beforeAll(() => {
    // Test write behavior in an isolated source snapshot: editors and parallel
    // generators must not change the files whose modification times we assert.
    root = mkdtempSync(join(tmpdir(),'shiro-inventory-source-'));
    for (const entry of readdirSync(repository,{withFileTypes:true})) {
        if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) copyFileSync(join(repository,entry.name),join(root,entry.name));
    }
    for (const path of ['shiro','exec-sandbox','docs/shiro']) cpSync(join(repository,path),join(root,path),{recursive:true});
    mkdirSync(join(root,'scripts')); copyFileSync(join(repository,'scripts/shiro-inventory.mjs'),join(root,'scripts/shiro-inventory.mjs'));
    for (const name of ['shiro-commands-v0.61.md','shiro-commands-v0.61-historical.md']) copyFileSync(join(repository,'docs',name),join(root,'docs',name));
    copyFileSync(join(repository,'package.json'),join(root,'package.json'));
    symlinkSync(join(repository,'node_modules'),join(root,'node_modules'),'dir');
});
afterAll(() => { if (root) rmSync(root,{recursive:true,force:true}); });
const invoke = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/shiro-inventory.mjs', ...args], {cwd:root, encoding:'utf8'});
const snapshot = () => Object.fromEntries([
    ...readdirSync(join(root,'docs/shiro')).map(name => `docs/shiro/${name}`),
    'docs/shiro-commands-v0.61.md',
    'docs/shiro-commands-v0.61-historical.md',
].map(path => [path, {sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex'),mtime:statSync(join(root,path)).mtimeMs}]));

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
        expect(new Set(data.artifacts.map((row:any)=>`${row.name}@${row.version}:${row.pin.sha256}`)).size).toBe(data.artifacts.length);
        expect(markdown).toContain(`${data.artifacts.length} WASI artifact identities`);
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
    it('detects stale notes without rewriting them', () => {
        const path = join(root,'docs/shiro-commands-v0.61.md');
        const previous = readFileSync(path);
        try {
            writeFileSync(path,'stale note\n');
            const before = snapshot();
            const result = invoke('--check');
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('shiro-commands-v0.61.md');
            expect(snapshot()).toEqual(before);
        } finally { writeFileSync(path,previous); }
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
