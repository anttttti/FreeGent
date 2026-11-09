// codex R410 (an options object without `passive` kept Chrome's passive default) and R412 (an uppercase </HEAD> put the shim before the doctype).
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';

const W = window as any;
beforeAll(async () => { await import('../tabs.ts'); });

let n = 0;
async function srcdocOf(html: string): Promise<string> {
    W.getEffectiveProxy = () => 'https://px.test';
    document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"></div>';
    await W.openArtifactTab(`t${++n}.html`, html);
    return (document.querySelector('iframe.artifact-iframe') as HTMLIFrameElement).srcdoc;
}

describe('preview shim', () => {
    it('an uppercase </HEAD> keeps the doctype first', async () => {
        const doc = await srcdocOf('<!DOCTYPE html><html><HEAD><title>x</title></HEAD><body>b</body></html>');
        expect(doc.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
        expect(doc).toContain('passive touch fix');
    });

    it('a root touch listener with an options object that omits passive becomes non-passive', async () => {
        const doc = await srcdocOf('<!DOCTYPE html><html><head></head><body></body></html>');
        const shim = doc.match(/<script>(?:(?!<\/script>)[\s\S])*passive touch fix[\s\S]*?<\/script>/)![0];
        const dom = new JSDOM(`<html><head></head><body></body></html>`, {
            runScripts: 'outside-only',
            beforeParse(win: any) {
                const orig = win.EventTarget.prototype.addEventListener;
                win.__seen = [];
                win.EventTarget.prototype.addEventListener = function (t: string, f: any, p: any) { win.__seen.push([t, p]); return orig.call(this, t, f, p); };
            },
        });
        dom.window.eval(shim.replace(/^<script>|<\/script>$/g, ''));
        dom.window.document.addEventListener('touchstart', () => {}, { capture: true });
        const seen = (dom.window as any).__seen.filter((s: any[]) => s[0] === 'touchstart');
        expect(seen.at(-1)[1]).toMatchObject({ capture: true, passive: false });
    });
});
