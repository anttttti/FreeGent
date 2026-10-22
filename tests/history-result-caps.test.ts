// opencode §14 and §15: a truncated read is not "already read in full", its continuation hint is true, and the main agent's result cap is its own.
import { describe, it, expect, beforeEach } from 'vitest';
import { truncateResultForHistory, resetSeenReadFiles } from '../history.ts';

beforeEach(() => { localStorage.clear(); resetSeenReadFiles?.(); });

describe('a cut read can be asked for again', () => {
    it('the same range read again after a truncation returns content, not "already read in full"', () => {
        localStorage.setItem('fg_agent_max_tool_result', '100');
        const big = 'A'.repeat(500);
        const first = truncateResultForHistory('read_file', { path: 'big.js', content: big });
        expect(first.content).toMatch(/not shown/);
        const again = truncateResultForHistory('read_file', { path: 'big.js', content: big });
        expect(again.note).toBeUndefined();
        expect(again.content.length).toBeGreaterThan(100);
    });
    it('a read that showed everything is still answered "already read"', () => {
        localStorage.setItem('fg_agent_max_tool_result', '100000');
        truncateResultForHistory('read_file', { path: 'a.js', content: 'small' });
        expect(truncateResultForHistory('read_file', { path: 'a.js', content: 'small' }).note).toMatch(/Already read/);
    });
    it('a cut inside the only line does not point at "lines 2–1"', () => {
        localStorage.setItem('fg_agent_max_tool_result', '100');
        const r = truncateResultForHistory('read_file', { path: 'one-line.js', content: 'B'.repeat(500), end_line: 50 });
        expect(r.content).not.toMatch(/lines \d+–\d+/);
        expect(r.content).toMatch(/more characters of line 1 not shown/);
    });
    it('a cut between lines still names the lines left out', () => {
        localStorage.setItem('fg_agent_max_tool_result', '100');
        const r = truncateResultForHistory('read_file', { path: 'multi.js', content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') });
        expect(r.content).toMatch(/lines \d+–100 not shown — use start_line=\d+ to read more/);
    });
});

describe('the main agent\'s result cap', () => {
    const out = (opts: any) => truncateResultForHistory('execute_code', { stdout: 'X'.repeat(5000) }, opts);
    it('caps a main-agent result at its own setting, whatever the worker setting is', () => {
        localStorage.setItem('fg_agent_max_tool_result', '100000'); localStorage.setItem('fg_director_max_tool_result', '1000');
        expect(out({ isDirector: true }).stdout.length).toBeLessThan(1200);
        expect(out({ isDirector: false }).stdout.length).toBe(5000);              // a worker keeps the worker setting
    });
    it('0 means no cap for the main agent', () => {
        localStorage.setItem('fg_agent_max_tool_result', '1000'); localStorage.setItem('fg_director_max_tool_result', '0');
        expect(out({ isDirector: true }).stdout.length).toBe(5000);
    });
});
