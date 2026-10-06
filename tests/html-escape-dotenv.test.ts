import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { escapeHtml } from '../html-escape.js';
import { parseDotenvFile } from '../dotenv.js';

describe('escapeHtml', () => {
    it('escapes text and attribute-breaking characters', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
    });
    it('treats null/undefined as empty and stringifies numbers', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(5)).toBe('5');
    });
});

describe('parseDotenvFile', () => {
    it('loads keys, strips quotes, never overrides the shell, ignores missing files', () => {
        const f = join(mkdtempSync(join(tmpdir(), 'fg-env-')), '.env');
        writeFileSync(f, '# c\nFG_T_A=1\nFG_T_B="two"\nFG_T_C=\'three\'\nFG_T_SET=file\nbad line\n');
        process.env.FG_T_SET = 'shell';
        parseDotenvFile(f);
        parseDotenvFile(f + '.missing');
        expect([process.env.FG_T_A, process.env.FG_T_B, process.env.FG_T_C, process.env.FG_T_SET])
            .toEqual(['1', 'two', 'three', 'shell']);
    });
});
