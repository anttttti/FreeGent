// codex R346: an older asynchronous preview rebuild must not overwrite a newer one.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../tabs.ts'); });

describe('artifact preview refresh ordering', () => {
    it('the newest rebuild wins when the older read finishes last', async () => {
        W.getEffectiveProxy = () => 'https://px.test';
        document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"></div>';
        await W.openArtifactTab('app.html', '<html><body>v0</body></html>');
        const iframe = () => document.querySelector('iframe.artifact-iframe') as HTMLIFrameElement;
        const pending: Array<(h: string) => void> = [];
        W.agentReadFile = vi.fn(() => new Promise<string>(r => pending.push(r)));
        vi.useFakeTimers();
        try {
            W.scheduleArtifactRefresh('app.html');
            await vi.advanceTimersByTimeAsync(900);      // first rebuild starts and waits for its read
            W.scheduleArtifactRefresh('app.html');
            await vi.advanceTimersByTimeAsync(900);      // second rebuild starts: it now owns the preview
            expect(pending).toHaveLength(2);
            pending[1]('<html><body>v2</body></html>');
            await vi.advanceTimersByTimeAsync(10);
            pending[0]('<html><body>v1</body></html>');  // the older read arrives last
            await vi.advanceTimersByTimeAsync(10);
        } finally { vi.useRealTimers(); }
        expect(iframe().srcdoc).toContain('v2');
        expect(iframe().srcdoc).not.toContain('v1');
    });
});
