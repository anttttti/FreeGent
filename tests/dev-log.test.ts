// tests/dev-log.test.ts — developer logging: off without a Developer key, batched POST /errlog with the session id, task log.
import { devLogEntry, flushDevLog, sendTaskLog, SESSION_ID, _resetDevLogForTest, _devLogQueueForTest } from '../dev-log.js';

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
});
