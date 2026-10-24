// scripts/code-index.mjs: function lengths, unused exports and import cycles from the syntax tree (self-analysis T02/T03/T14).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let dir: string;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fg-codeidx-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.ts'), [
        "import { bFn } from './b.js';",
        'export function longOne() {',
        "    const s = '} { not a brace for a regex scanner';   // } // {",
        '    function inner() {',
        '        return 1;',
        '    }',
        '    return inner() + bFn();',
        '}',
        'export const arrow = () => {',
        '    return 2;',
        '};',
        'export const neverUsed = 3;',
        'export const usedByTsx = 4;',
        'export const selfUsed = 5;',
        'export const twice = selfUsed + 1;',
    ].join('\n'));
    writeFileSync(join(dir, 'b.ts'), ["import { longOne } from './a.js';", 'export function bFn() { return longOne ? 1 : 0; }', 'export const twiceUsed = 1;'].join('\n'));
    writeFileSync(join(dir, 'ui.tsx'), ["import { usedByTsx } from './a.js';", 'export const View = () => <div>{usedByTsx}</div>;'].join('\n'));
    writeFileSync(join(dir, 'sub', 'c.ts'), "export function inSub() { return 1; }\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/code-index.mjs'), ...args, '--dir', dir], { encoding: 'utf8' });

describe('code-index', () => {
    it('functions: lengths come from the syntax tree (braces inside strings and comments do not matter; a nested function is its own row)', () => {
        const out = run('functions', '--top', '5').stdout.trim().split('\n');
        expect(out[0]).toMatch(/^\s*7\s+a\.ts:2\s+longOne$/);
        expect(out.some(l => /a\.ts:4\s+inner$/.test(l))).toBe(true);
        expect(run('functions', '--root-only').stdout).not.toContain('inSub');
        expect(run('functions').stdout).toContain('sub/c.ts:1');
    });
    it('exports --unused: counts users in .tsx files too, separates "self-only" from "no mention at all"', () => {
        const r = run('exports', '--unused');
        expect(r.stdout).toMatch(/UNUSED\s+a\.ts:12\s+neverUsed/);
        expect(r.stdout).toMatch(/self-only\s+a\.ts:14\s+selfUsed/);
        expect(r.stdout).not.toContain('usedByTsx');          // mentioned by ui.tsx
        expect(r.stderr).toMatch(/10 exports; 6 with no mention anywhere else.*; 1 mentioned only in their own file/);
    });
    it('cycles: a static import in both directions is a pair', () => {
        const r = run('cycles');
        expect(r.stdout.trim()).toBe('a.ts <-> b.ts');
        expect(r.stderr).toMatch(/1 two-module cycles/);
    });
});
