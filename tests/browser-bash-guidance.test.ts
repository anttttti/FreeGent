// The bash guidance in the browser says what the browser shell does: each execute_code call starts fresh, files carry over.
import '../skills.ts';
import { runBash } from '../exec-sandbox/bash-run.ts';

const W = globalThis as any;

describe('browser bash guidance', () => {
    let saved: any;
    beforeEach(() => { saved = { exec: W.nativeExec, avail: W.browserBashAvailable, prov: localStorage.getItem('fg_sandbox_provider') };
        delete W.nativeExec; W.browserBashAvailable = () => true; localStorage.setItem('fg_sandbox_provider', 'wasm'); });
    afterEach(() => { W.nativeExec = saved.exec; W.browserBashAvailable = saved.avail;
        if (saved.prov == null) localStorage.removeItem('fg_sandbox_provider'); else localStorage.setItem('fg_sandbox_provider', saved.prov); });

    it('says each call starts fresh, as the browser shell does', async () => {
        const body = W.BUILTIN_RULES.find((r: any) => r.name === 'bash').body_fn() as string;
        expect(body).toMatch(/### Environment \(browser shell\)/);
        expect(body).toMatch(/each call starts in a fresh browser shell in `\/workspace`/);
        expect(body).not.toMatch(/keeps functions, variables|applies to later calls/);
        await runBash('x=1; cd /tmp; echo kept > /tmp/fg-guidance.txt');
        const r = await runBash('echo "[$x]"; pwd; cat /tmp/fg-guidance.txt');
        expect(r.stdout).toBe('[]\n/workspace\nkept\n');
    });
});
