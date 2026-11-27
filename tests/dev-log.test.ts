// tests/dev-log.test.ts — developer logging: off without a Developer key, batched POST /errlog with the session id, task log.
import { devLogEntry, flushDevLog, sendTaskLog, describeDevice, SESSION_ID, _resetDevLogForTest, _devLogQueueForTest } from '../dev-log.js';

describe('dev-log', () => {
    let f: any;
    beforeEach(() => {
        localStorage.clear(); _resetDevLogForTest();
        f = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
        vi.stubGlobal('fetch', f); (window as any).fetch = f;
    });
    afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

    it('records nothing without a Developer key', async () => {
        devLogEntry('error', 'console', 'boom');
        expect(_devLogQueueForTest()).toHaveLength(0);
        await flushDevLog();
        expect(f).not.toHaveBeenCalled();
    });

    it('with a self-hosted Worker configured, the Developer key and the logs never go to FreeGent\'s Worker', async () => {
        localStorage.setItem('fg_dev_key', 'k1');
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.org');
        devLogEntry('error', 'console', 'boom');
        expect(_devLogQueueForTest()).toHaveLength(0);
        await flushDevLog();
        await sendTaskLog({ id: '1', title: 't', path: 'p' }, 'done', '', 'c1', async () => '{}');
        expect(f).not.toHaveBeenCalled();
    });

    it.each(['https://proxy.freegent.ai', 'proxy.freegent.ai/', 'https://proxy.freegent.ai/x'])('FreeGent\'s own Worker entered by hand (%s) still gets the logs', async v => {
        localStorage.setItem('fg_dev_key', 'k1');
        localStorage.setItem('fg_search_proxy', v);
        devLogEntry('error', 'console', 'boom');
        expect(_devLogQueueForTest()).toHaveLength(1);
    });

    it('batches entries with the session id and the key, and counts repeats', async () => {
        localStorage.setItem('fg_dev_key', 'k1');
        devLogEntry('warn', 'console', 'same'); devLogEntry('warn', 'console', 'same'); devLogEntry('error', 'console', 'other');
        await flushDevLog();
        const [url, init] = f.mock.calls[0];
        expect(url).toMatch(/\/errlog$/);
        expect(init.headers['X-FG-Dev-Key']).toBe('k1');
        const body = JSON.parse(init.body);
        expect(body.sessionId).toBe(SESSION_ID);
        expect(body.entries.map((e: any) => [e.level, e.text, e.count])).toEqual([['warn', 'same', 2], ['error', 'other', undefined]]);
    });

    it('after a failed send the queued entries get a delayed retry, a bounded number of times (review of 71928f3)', async () => {
        vi.useFakeTimers();
        try {
            localStorage.setItem('fg_dev_key', 'k1');
            f.mockRejectedValue(new Error('down'));
            devLogEntry('error', 'console', 'boom'); await flushDevLog();
            expect(f).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(61_000);
            expect(f).toHaveBeenCalledTimes(2);                  // retried once later, without any new entry
            for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(61_000);
            expect(f.mock.calls.length).toBeLessThanOrEqual(5);  // and then it stops
        } finally { vi.useRealTimers(); }
    });

    it('sends the device with each batch and task log', async () => {
        localStorage.setItem('fg_dev_key', 'k1');
        devLogEntry('error', 'console', 'x'); await flushDevLog();
        const dev = JSON.parse(f.mock.calls[0][1].body).device;
        expect(Object.keys(dev).sort()).toEqual(expect.arrayContaining(['browser', 'mobile', 'os', 'wasm']));
        await sendTaskLog({ id: '1', title: 't', path: 'p' }, 'done', '', 'c1', async () => '{}');
        expect(JSON.parse(f.mock.calls[1][1].body).device.os).toBe(dev.os);
    });

    it('describes the device coarsely, never as the user agent string', () => {
        const ua = {
            ipad12: 'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
            ipados: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
            chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
            android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
            firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
        };
        expect(describeDevice(ua.ipad12, 5, undefined, false)).toEqual({ browser: 'Safari 12', os: 'iPadOS 12', mobile: true, wasm: false });
        expect(describeDevice(ua.ipados, 5)).toMatchObject({ browser: 'Safari 17', os: 'iPadOS', mobile: true });
        expect(describeDevice(ua.ipados, 0)).toMatchObject({ os: 'macOS', mobile: false });
        expect(describeDevice(ua.chromeIos)).toMatchObject({ browser: 'Chrome 123', os: 'iOS 17', mobile: true });
        expect(describeDevice(ua.android, 5, 4)).toEqual({ browser: 'Chrome 124', os: 'Android 14', mobile: true, wasm: true, memGb: 4 });
        expect(describeDevice(ua.edge)).toMatchObject({ browser: 'Edge 124', os: 'Windows', mobile: false });
        expect(describeDevice(ua.firefox)).toMatchObject({ browser: 'Firefox 125', os: 'Linux', mobile: false });
        expect(JSON.stringify(describeDevice(ua.android))).not.toMatch(/Mozilla|AppleWebKit|Pixel/);
    });

    it('redacts other saved credentials from entries', () => {
        localStorage.setItem('fg_dev_key', 'k1');
        localStorage.setItem('some_api_key', 'plainsecretvalue123');
        devLogEntry('error', 'console', 'failed with plainsecretvalue123 in url');
        expect(_devLogQueueForTest()[0].text).not.toContain('plainsecretvalue123');
    });

    it('migrates the old fg_pass value', async () => {
        localStorage.setItem('fg_pass', 'legacy');
        devLogEntry('error', 'console', 'x');
        expect(_devLogQueueForTest()).toHaveLength(1);
        expect(localStorage.getItem('fg_dev_key')).toBe('legacy');
        expect(localStorage.getItem('fg_pass')).toBeNull();
    });

    it('sends a task chat log tagged with the session, only with a key', async () => {
        const build = vi.fn().mockResolvedValue('{"id":"c1","openaiHistory":[]}');
        await sendTaskLog({ id: '7', title: 'T', path: 'fg-tasks/7.md' }, 'failed', 'why', 'c1', build);
        expect(f).not.toHaveBeenCalled();
        localStorage.setItem('fg_dev_key', 'k1');
        await sendTaskLog({ id: '7', title: 'T', path: 'fg-tasks/7.md' }, 'failed', 'why', 'c1', build);
        const [url, init] = f.mock.calls[0];
        expect(url).toMatch(/\/log$/);
        const body = JSON.parse(init.body);
        expect(body.devSession).toBe(SESSION_ID);
        expect(body.task).toMatchObject({ id: '7', outcome: 'failed', reason: 'why' });
        expect(body.id).toBe('c1');
    });

    it('entries queued while a send is in flight are sent even when the timer fired meanwhile (N015)', async () => {
        vi.useFakeTimers();
        try {
            localStorage.setItem('fg_dev_key', 'k1');
            let release!: () => void;
            f.mockImplementationOnce(() => new Promise(r => { release = () => r({ ok: true }); }));
            f.mockResolvedValue({ ok: true });
            devLogEntry('error', 'console', 'first');
            await vi.advanceTimersByTimeAsync(3000);   // first send starts and waits
            devLogEntry('error', 'console', 'second');
            await vi.advanceTimersByTimeAsync(3000);   // its timer fires while the first send is active
            release();
            await vi.advanceTimersByTimeAsync(6000);
            expect(f).toHaveBeenCalledTimes(2);
            expect(_devLogQueueForTest()).toHaveLength(0);
        } finally { vi.useRealTimers(); }
    });

    it('does not send a task log when the key is removed while the chat is being built (N026)', async () => {
        localStorage.setItem('fg_dev_key', 'k1');
        const build = vi.fn(async () => { localStorage.removeItem('fg_dev_key'); return '{"id":"c1","openaiHistory":[]}'; });
        await sendTaskLog({ id: '7', title: 'T', path: 'fg-tasks/7.md' }, 'failed', 'why', 'c1', build);
        expect(f).not.toHaveBeenCalled();
    });

    it("redacts saved credentials from the task's own fields, not only the chat (codex CR-01: a crash reason quotes the code that ran)", async () => {
        localStorage.setItem('fg_dev_key', 'k1');
        localStorage.setItem('some_api_key', 'plainsecretvalue123');
        const build = async () => JSON.stringify({ id: 'c1', messages: [] });
        await sendTaskLog({ id: '', title: 'tool crash: exec(python): k = "plainsecretvalue123"', path: '' }, 'crashed',
            'session s: exec(python): k = "plainsecretvalue123" — running for 3 s', 'c1', build);
        const sent = String(f.mock.calls[0][1].body);
        expect(sent).not.toContain('plainsecretvalue123');
        expect(JSON.parse(sent).task.title).toMatch(/^tool crash: exec\(python\): k = /);   // the rest is kept
    });
});

describe('redaction with a malformed saved value (Sol 6.2 review of 47d0657)', () => {
    it('a credential with an unpaired surrogate does not make redactText throw, and is still removed', async () => {
        const { redactText } = await import('../secrets.ts');
        const bad = 'sk-abcdefgh\ud800ijklmnop';
        expect(redactText(`error ${bad} end`, [bad])).not.toContain('abcdefgh');
    });
});
