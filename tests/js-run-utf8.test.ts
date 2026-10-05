// process.stdout.write receives bytes; a multibyte character split across writes must survive.
import { runJs } from '../exec-sandbox/js-run';

describe('runJs stdout/stderr byte writes', () => {
    it('reassembles a UTF-8 character split across two writes', async () => {
        const r = await runJs(`const b = Buffer.from('é€😀');
            process.stdout.write(b.subarray(0, 1)); process.stdout.write(b.subarray(1, 4));
            process.stderr.write(new Uint8Array([0xe2, 0x82])); process.stderr.write(new Uint8Array([0xac]));
            process.stdout.write(b.subarray(4));`, {});
        expect(r.stdout).toBe('é€😀');
        expect(r.stderr).toBe('€');
    });
    it('flushes a character left incomplete at exit as U+FFFD', async () => {
        const r = await runJs(`process.stdout.write(new Uint8Array([0xe2, 0x82]));`, {});
        expect(r.stdout).toBe('�');
    });
});
