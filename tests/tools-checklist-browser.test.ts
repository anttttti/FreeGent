// Settings → Tools lists the browser_* tools only when a browser bridge is configured: they need a
// Playwright bridge, which only headless runs set (headless-runner.ts), so in the WebUI they did nothing.
import { describe, it, expect, afterEach } from 'vitest';

const W: any = window;
const names = () => [...document.querySelectorAll('#settings-tools-list .model-item-name')].map(e => e.textContent || '');

describe('Tools checklist and the browser tools', () => {
    afterEach(() => { W.setBrowserBridge(''); document.getElementById('settings-tools-list')?.remove(); });

    it('hides browser_* without a bridge and lists them with one', async () => {
        await import('../browser-tools.ts');
        await import('../skills.ts');
        document.body.insertAdjacentHTML('beforeend', '<div id="settings-tools-list"></div>');
        W.renderToolsChecklist();
        expect(names().length).toBeGreaterThan(5);
        expect(names().some(n => /browser_/.test(n))).toBe(false);
        W.setBrowserBridge('http://127.0.0.1:9333');
        W.renderToolsChecklist();
        expect(names().some(n => /browser_navigate/.test(n))).toBe(true);
    });
});
