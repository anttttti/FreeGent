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

describe('runJs mixed string and byte writes (R12)', () => {
    it('keeps a pending partial character ahead of later text', async () => {
        const r = await runJs(`process.stdout.write(new Uint8Array([0xc3])); process.stdout.write('é');`, {});
        expect(r.stdout).toBe('�é');
    });
    it('orders console output after a split character the same way', async () => {
        const r = await runJs(`process.stdout.write(new Uint8Array([0xe2, 0x82])); console.log('x');`, {});
        expect(r.stdout).toBe('�x\n');
    });
});

// WebKit's Error.stack has frames only, no "Name: message" line.
import { formatThrown } from '../exec-sandbox/js-run';
describe('formatThrown', () => {
    const webkit = (name: string, message: string, stack: string) => Object.assign(new Error(message), { name, stack });
    it('puts the message in front of a stack that has none (Safari)', () => {
        const e = webkit('TypeError', "undefined is not an object (evaluating 'a.b')",
            'anonymous\nhttps://freegent.ai/fg-exec-sandbox.js:834:15\nasyncFunctionResume@[native code]\nrunJs@https://freegent.ai/fg-exec-sandbox.js:784:26\npromiseReactionJob@[native code]');
        expect(formatThrown(e)).toBe("TypeError: undefined is not an object (evaluating 'a.b')");
    });
    it('keeps frames of the code itself', () => {
        const e = webkit('ReferenceError', 'x is not defined', 'foo@eval code:3:9\nasyncFunctionResume@[native code]');
        expect(formatThrown(e)).toBe('ReferenceError: x is not defined\nfoo@eval code:3:9');
    });
    it('does not repeat the message when the stack (V8) starts with it', () => {
        const e = webkit('Error', 'boom', 'Error: boom\n    at <anonymous>:1:7');
        expect(formatThrown(e)).toBe('Error: boom\n    at <anonymous>:1:7');
    });
    it('formats thrown non-errors and runJs reports a thrown error', async () => {
        expect(formatThrown('plain')).toBe('plain');
        expect(formatThrown(42)).toBe('42');
        const r = await runJs(`throw new RangeError('too big')`, {});
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/^RangeError: too big/);
    });
});

// A model's usual test wrapper is `(async () => { … process.exit(1) })()` that nobody awaits: Node runs it to its end and exits with its code.
describe('runJs detached async code', () => {
    it('keeps the output of a timer and the exit code of a detached process.exit', async () => {
        const r = await runJs(`(async () => { await new Promise(r => setTimeout(r, 20)); console.log('late'); process.exit(3); })(); console.log('first');`, {});
        expect(r.stdout).toBe('first\nlate\n');
        expect(r.exit_code).toBe(3);
    });
    it('still ends at once on a plain process.exit', async () => {
        const r = await runJs(`console.log('a'); process.exit(2); console.log('b');`, {});
        expect([r.stdout, r.exit_code]).toEqual(['a\n', 2]);
    });
});

describe('runJs dynamic import', () => {
    it('says what to do instead when import() cannot load a workspace file', async () => {
        const r = await runJs(`await import('./lib/list.mjs');`, {});
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/import\(\) cannot load workspace files/);
    });
});

// review 2026-11-08 (CR20-05): a cancelled timer never fires, so the drain waited its whole deadline for it.
describe('runJs timers', () => {
    it('does not wait for a timer the program cancelled, nor for one that fired', async () => {
        const t0 = Date.now();
        const r = await runJs(`const t = setTimeout(() => console.log('never'), 100000); clearTimeout(t); clearTimeout(t); setTimeout(() => console.log('fired'), 20); console.log('done');`, {});
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.stdout).toBe('done\nfired\n');
    });
    it('waits for a timer the program left pending (a detached timer is part of the program)', async () => {
        const r = await runJs(`setTimeout(() => console.log('leaked'), 200); `, {});
        expect(r.stdout).toBe('leaked\n');
    });
});
