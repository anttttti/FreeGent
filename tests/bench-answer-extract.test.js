// Tests for bench/lib/answer-extract.js — shared final-answer extraction for the
// AgentBench and InterCode runners (previously two drifted hand-copies).
import { describe, it, expect } from 'vitest';
import { extractFinalAnswer, stripFencedBlocks } from '../bench/lib/answer-extract.js';

describe('extractFinalAnswer', () => {
    it('takes the last non-empty line', () => {
        expect(extractFinalAnswer('working…\nsome output\n42\n')).toBe('42');
    });
    it('skips framework sentinels trailing the real answer', () => {
        expect(extractFinalAnswer('the answer is\n42\nCOMPLETED')).toBe('42');
        expect(extractFinalAnswer('42\n*(break)*')).toBe('42');
        expect(extractFinalAnswer('42\n*(loop detected)*\n*(stopped: max steps)*')).toBe('42');
        expect(extractFinalAnswer('42\nCONTINUING')).toBe('42');
    });
    it('skips leaked reasoning tags (AgentBench OS #25: "</thinking" was the whole answer)', () => {
        expect(extractFinalAnswer('42\n</thinking')).toBe('42');
        expect(extractFinalAnswer('42\n<think>')).toBe('42');
        expect(extractFinalAnswer('</thinking')).toBe('');
    });
    it('unwraps fenced blocks so the closing ``` is never the answer', () => {
        expect(extractFinalAnswer('```sql\nSELECT 1;\n```\nCOMPLETED')).toBe('SELECT 1;');
    });
    it('extraSentinels filter benchmark-specific banners case-insensitively', () => {
        expect(extractFinalAnswer('42\nmysqld is alive', { extraSentinels: ['mysqld is alive'] })).toBe('42');
        expect(extractFinalAnswer('42\nMYSQLD IS ALIVE', { extraSentinels: ['mysqld is alive'] })).toBe('42');
    });
    it('empty/sentinel-only output → empty string', () => {
        expect(extractFinalAnswer('')).toBe('');
        expect(extractFinalAnswer('COMPLETED\n*(break)*')).toBe('');
    });
    it('filters JSON tool-call lines (D2: model wrote {"name":"execute_code",...} as text)', () => {
        // Pure JSON tool-call answer → empty (never a valid benchmark answer)
        expect(extractFinalAnswer('{"name":"execute_code","arguments":{"language":"bash","code":"ls"}}\nCOMPLETED')).toBe('');
        // JSON tool-call after a real answer → real answer survives
        expect(extractFinalAnswer('42\n{"name":"execute_code","arguments":{}}\nCOMPLETED')).toBe('42');
        // "function" key variant also filtered
        expect(extractFinalAnswer('{"function":"web_search","args":{}}\nCOMPLETED')).toBe('');
        // Valid JSON that is NOT a tool call is preserved (e.g. a JSON answer)
        expect(extractFinalAnswer('{"result":42}\nCOMPLETED')).toBe('{"result":42}');
    });
});

describe('extractFinalAnswer bash block extension', () => {
    it('extends backwards from "done" to include the whole while loop', () => {
        // Use String.raw to avoid template literal $() substitution confusion
        const raw = [
            'find /system/folder1 -name "*special*" | while read -r file; do',
            '    new_name=$(echo "$file" | sed \'s/special/regular/g\')',
            '    mv "$file" "$new_name"',
            'done',
            'COMPLETED',
        ].join('\n');
        const result = extractFinalAnswer(raw);
        expect(result).toContain('while read -r file');
        expect(result).toContain('done');
        expect(result).not.toBe('done');
    });
    it('extends backwards from "fi" to include the whole if block', () => {
        const raw = 'if [ -d /system/folder1 ]; then\n    echo "yes"\nfi\nCOMPLETED';
        const result = extractFinalAnswer(raw);
        expect(result).toContain('if [ -d');
        expect(result).toContain('fi');
    });
    it('does NOT change single-line commands', () => {
        expect(extractFinalAnswer('ls -la /system\nCOMPLETED')).toBe('ls -la /system');
    });
    it('does NOT include prose before the block opener', () => {
        // Prose on earlier lines should NOT be included — block starts at the opener
        const raw = 'I will rename the files using find:\nfind /x | while read f; do mv "$f" new; done\nCOMPLETED';
        const result = extractFinalAnswer(raw);
        expect(result).toContain('while read');
        expect(result).not.toContain('I will rename');
    });
});

describe('stripFencedBlocks', () => {
    it('unwraps content and leaves unfenced text alone', () => {
        expect(stripFencedBlocks('a\n```py\nx = 1\n```\nb')).toBe('a\nx = 1\nb');
        expect(stripFencedBlocks('no fences here')).toBe('no fences here');
    });
});
