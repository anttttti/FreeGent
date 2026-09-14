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

describe('stripFencedBlocks', () => {
    it('unwraps content and leaves unfenced text alone', () => {
        expect(stripFencedBlocks('a\n```py\nx = 1\n```\nb')).toBe('a\nx = 1\nb');
        expect(stripFencedBlocks('no fences here')).toBe('no fences here');
    });
});
