// hermes C10: the transcript log is private to the user and never written through a symlink.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logAppend, defaultLogPath } from '../safe-log.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fg-log-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('logAppend', () => {
    it('creates the file private to the user (0600) and appends', () => {
        const d = tmp(), p = join(d, 'a.log');
        logAppend(p, 'one\n'); logAppend(p, 'two\n');
        expect(readFileSync(p, 'utf8')).toBe('one\ntwo\n');
        expect(statSync(p).mode & 0o777).toBe(0o600);
    });
    it('refuses to write through a symlink planted at the path, and the target is untouched', () => {
        const d = tmp(), victim = join(d, 'bashrc'), p = join(d, 'fg-agent.log');
        writeFileSync(victim, '# victim file\n'); symlinkSync(victim, p);
        expect(() => logAppend(p, '{"prompt":"secret"}\n')).toThrow();
        expect(readFileSync(victim, 'utf8')).toBe('# victim file\n');
    });
});
describe('defaultLogPath', () => {
    it('is in a directory of the user, not at a fixed name in /tmp', () => {
        const p = defaultLogPath('fg-tui.log');
        expect(p).not.toBe('/tmp/fg-tui.log');
        expect(p.endsWith('fg-tui.log')).toBe(true);
        expect(existsSync(p.replace(/\/fg-tui\.log$/, ''))).toBe(true);
    });
});
