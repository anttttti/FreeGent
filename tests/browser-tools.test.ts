import { setMainAgentRole as setRoleObject } from '../state.ts';
const W: any = globalThis;
beforeEach(() => { W.setBrowserBridge(''); W.fetch.mockReset(); W.setMainAgentRole(null); W.setDisabledTools([]); });
afterEach(() => W.setBrowserBridge(''));

describe('configured text browser tools', () => {
    it('does not advertise unavailable tools and requires explicit enablement', () => {
        W.enabledTools.add('browser_snapshot');
        expect(W.activeTools().some(t => t.name === 'browser_snapshot')).toBe(false);
        W.setBrowserBridge('http://bridge:8080');
        expect(W.activeTools().some(t => t.name === 'browser_snapshot')).toBe(true);
        W.enabledTools.delete('browser_snapshot');
        expect(W.activeTools().some(t => t.name === 'browser_snapshot')).toBe(false);
    });
    it('honors role ceilings', () => {
        W.setBrowserBridge('http://bridge:8080'); W.enabledTools.add('browser_snapshot');
        setRoleObject({ name: 'reader', tools: new Set(['read_file']) });
        expect(W.activeTools().some(t => t.name.startsWith('browser_'))).toBe(false);
    });
    it('rejects credential-bearing or non-HTTP bridge URLs', () => {
        for (const url of ['file:///tmp/browser', 'http://user:secret@bridge/', 'http://bridge/?token=secret', 'http://bridge/#secret']) {
            expect(() => W.setBrowserBridge(url)).toThrow();
        }
    });
    it('dispatches observed refs without accepting arbitrary script operations', async () => {
        W.setBrowserBridge('http://bridge:8080/');
        W.fetch.mockResolvedValue(new Response(JSON.stringify({ url: 'http://shopping/', text: 'Cart updated' }), { status: 200 }));
        const result = await W.executeBrowserTool('browser_click', { ref: 'abc-1' });
        expect(result.text).toBe('Cart updated');
        expect(W.fetch.mock.calls[0][0]).toBe('http://bridge:8080/browser/click');
        expect(JSON.parse(W.fetch.mock.calls[0][1].body)).toEqual({ ref: 'abc-1' });
        expect(await W.executeBrowserTool('browser_eval', { code: '1+1' })).toEqual({ error: 'Unknown browser tool.' });
        expect(W.fetch).toHaveBeenCalledTimes(1);
    });
    it('preserves useful bridge errors and bounds them', async () => {
        W.setBrowserBridge('http://bridge');
        W.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Unknown ref; take a fresh snapshot' }), { status: 400 }));
        expect((await W.executeBrowserTool('browser_click', { ref: 'stale' })).error).toMatch('fresh snapshot');
    });
    it('truncates browser observations and consumes the shared step budget', () => {
        const budget = { remaining: 200 };
        const out = W.truncateResultForHistory('browser_snapshot', { url: 'http://shopping', text: 'x'.repeat(20_000) }, { stepBudget: budget });
        expect(out.truncated).toBe(true); expect(out.observation.length).toBeLessThanOrEqual(200);
        expect(budget.remaining).toBe(0);
    });
    it('registers every browser tool for validation and configuration', () => {
        expect(W.BROWSER_TOOL_NAMES).toHaveLength(9);
        for (const name of W.BROWSER_TOOL_NAMES) { expect(W.ALL_TOOL_NAMES).toContain(name); expect(W.AGENT_TOOL_NAMES).toContain(name); expect(W.OPT_IN_TOOLS.has(name)).toBe(true); }
    });
});
