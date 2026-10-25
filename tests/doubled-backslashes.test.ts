// A full rewrite that doubles the backslashes of an existing file is reported in the write result (bench/selfanalysis W7r2).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { doubledBackslashGrowth } from '../detectors.ts';
const W: any = window;
beforeAll(async () => { await import('../tools.ts'); });

describe('doubledBackslashGrowth', () => {
    it('counts new doubled escapes against the previous text', () => {
        const before = 'const re = /^fg_(\\d+)$/;\nconst t = `a\\nb`;';
        const after = 'const re = /^fg_(\\\\d+)$/;\nconst t = `a\\\\nb`;';
        expect(doubledBackslashGrowth(before, after)).toBe(2);
        expect(doubledBackslashGrowth(after, after)).toBe(0);       // a file that already had them keeps them without a warning
        expect(doubledBackslashGrowth('', 'plain text')).toBe(0);
    });
});

describe('write_file result', () => {
    let files: Map<string, string>;
    beforeEach(() => {
        W.mainAgentRole = null; files = new Map();
        W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
        W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error('File not found: ' + p); return files.get(p); };
        W.agentListFiles = async () => [...files.keys()].map(name => ({ name }));
    });
    const write = (path: string, content: string) => W.executeToolAsync('write_file', { path, content }, null);
    it('warns when a rewrite of an existing file doubles backslashes, not for a new file or an unchanged count', async () => {
        const original = 'const re = /^fg_(\\d+)$/;\nconst t = `a\\nb`;\nconst u = `c\\nd`;\n';
        files.set('s.ts', original);
        const bad = await write('s.ts', original.replace(/\\d/g, '\\\\d').replace(/\\n/g, '\\\\n'));
        expect(bad.success).toBe(true);
        expect(bad.escape_warning).toMatch(/added 3 doubled backslashes/);
        const fresh = await write('new.ts', 'const x = "\\\\n\\\\d\\\\s";\n');
        expect(fresh.escape_warning).toBeUndefined();
        files.set('t.ts', original);
        const same = await write('t.ts', original + '// more\n');
        expect(same.escape_warning).toBeUndefined();
    });
});

describe('over-escaped regular expression literals in a new file', () => {
    it('are counted when the backslashes are doubled, not when they are single or the regex is written inside a string', async () => {
        const { overEscapedRegexLiterals } = await import('../detectors.ts');
        expect(overEscapedRegexLiterals('const m = h.match(/^(\\\\d+)\\\\.(\\\\d+)\\\\.(\\\\d+)\\\\.(\\\\d+)$/);')).toBe(1);
        expect(overEscapedRegexLiterals('if (/^f\\\\d/.test(h)) return false;')).toBe(1);
        expect(overEscapedRegexLiterals('const m = h.match(/^(\\d+)\\.(\\d+)$/);')).toBe(0);
        expect(overEscapedRegexLiterals("const re = new RegExp('^(\\\\d+)$');")).toBe(0);       // a string handed to RegExp: doubled backslashes are right
        expect(overEscapedRegexLiterals('const p = "C:\\\\dir";')).toBe(0);
    });
    it('write_file warns for a new JS file with such a literal, and not for a .md file or a correct one', async () => {
        W.mainAgentRole = null; const files = new Map<string, string>();
        W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
        W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error('File not found: ' + p); return files.get(p); };
        W.agentListFiles = async () => [];
        const w = (p: string, c: string) => W.executeToolAsync('write_file', { path: p, content: c }, null);
        const bad = await w('out/t.mjs', 'const m = h.match(/^(\\\\d+)\\\\.(\\\\d+)$/);\n');
        expect(bad.escape_warning).toMatch(/1 regular expression literal in this file has doubled backslashes/);
        expect((await w('out/ok.mjs', 'const m = h.match(/^(\\d+)\\.(\\d+)$/);\n')).escape_warning).toBeUndefined();
        expect((await w('out/notes.md', 'const m = h.match(/^(\\\\d+)$/);\n')).escape_warning).toBeUndefined();
    });
});
