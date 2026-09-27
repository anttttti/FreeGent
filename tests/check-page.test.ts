// check_page (tools.ts / tabs.ts runPageCheck): browser-only page check. The page-running part is
// exercised in a real browser (jsdom does not run sandboxed srcdoc iframes); these cover the tool's
// guards and its registration.
import { describe, it, expect, afterEach } from 'vitest';

const W = window as any;

describe('check_page', () => {
    const prev = { nativeExec: W.nativeExec, runPageCheck: W.runPageCheck };
    afterEach(() => { W.nativeExec = prev.nativeExec; W.runPageCheck = prev.runPageCheck; });

    it('refuses in headless runs (nativeExec present)', async () => {
        W.nativeExec = async () => ({});
        W.runPageCheck = async () => ({ ok: true });
        const r = await W.executeToolAsync('check_page', { path: 'index.html' });
        // Refused either by the headless role ceiling or by the handler's own guard.
        expect(r.error).toMatch(/not available|needs the browser app/);
    });

    it('requires an .html path and passes actions/probes through', async () => {
        W.nativeExec = undefined;
        let got: any = null;
        W.runPageCheck = async (path: string, opts: any) => { got = { path, opts }; return { path, summary: 'ok' }; };
        expect((await W.executeToolAsync('check_page', { path: 'game.js' })).error).toMatch(/HTML page/);
        const r = await W.executeToolAsync('check_page', { path: 'index.html', actions: [{ click: '#start-btn' }], probes: ['gameState', 42], wait_ms: 500 });
        expect(r.summary).toBe('ok');
        expect(got).toEqual({ path: 'index.html', opts: { actions: [{ click: '#start-btn' }], probes: ['gameState', '42'], waitMs: 500 } });
    });

    it('is a default-on tool known to the pseudo-call detector', async () => {
        expect(W.ALL_TOOL_NAMES).toContain('check_page');
        expect(W.OPT_IN_TOOLS.has('check_page')).toBe(false);
        const { AGENT_TOOL_NAMES } = await import('../step-validator.ts');
        expect(AGENT_TOOL_NAMES).toContain('check_page');
    });
});
