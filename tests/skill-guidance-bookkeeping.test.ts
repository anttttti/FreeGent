// Uploads review 2026-10-14: the code-fix definition of done fired after a write to the task card
// and demanded `git diff`, which the browser shell does not have.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _isBookkeepingWrite } from '../skill-guidance.js';

describe('_isBookkeepingWrite', () => {
    it('is true for task, memory and log files written with a write tool', () => {
        expect(_isBookkeepingWrite('write_file', { path: 'fg-tasks/current.md' }, {})).toBe(true);
        expect(_isBookkeepingWrite('replace_in_file', { path: './memory/log.md' }, {})).toBe(true);
        expect(_isBookkeepingWrite('append_file', { path: 'local/logs/x.md' }, {})).toBe(true);
    });
    it('is false for source files and for non-write tools', () => {
        expect(_isBookkeepingWrite('replace_in_file', { path: 'src/game.js' }, {})).toBe(false);
        expect(_isBookkeepingWrite('read_file', { path: 'fg-tasks/current.md' }, {})).toBe(false);
        expect(_isBookkeepingWrite('write_file', {}, { path: 'a.js' })).toBe(false);
    });
});

describe('code-fix-done text', () => {
    it('does not demand a git command', () => {
        const src = readFileSync(resolve(process.cwd(), 'skills.ts'), 'utf-8');
        const body = src.slice(src.indexOf("name: 'code-fix-done'"), src.indexOf("name: 'ops-verify'"));
        expect(body).not.toMatch(/git diff HEAD/);
        expect(body).toMatch(/read_file/);
    });
});
