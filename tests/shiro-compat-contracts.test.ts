// Host-reporting and tool-compat behaviour that scripts rely on, held to the contracts recorded for the
// exec-diff coverage cases (bench/dev-tests/log-replay): output a browser shell cannot make byte-identical
// to a native run (it has no real host) must still have the shape native output has.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../workspace', () => ({
    agentWriteFile: async () => {}, agentDeleteFile: async () => {},
    agentListFiles: async () => [], readWorkspaceFile: async () => null,
}));

import { getShell } from '../shiro/shell-singleton';
import { adaptUuidArgs } from '../shiro/wasi-packages';

let sh: any;
const run = async (cmd: string) => {
    const r = await sh.exec(cmd);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    return { out: lf(r.stdout), err: lf(r.stderr), code: r.exitCode ?? 0 };
};
beforeAll(async () => { sh = await getShell(); });

describe('uname reports the Linux/x86-64 userland', () => {
    it('matches what real bash prints for the same flags', async () => {
        expect((await run('uname -s')).out).toBe('Linux\n');
        expect((await run('uname -m')).out).toBe('x86_64\n');
        expect((await run('uname')).out).toBe('Linux\n');
        expect((await run('uname -o')).out).toBe('GNU/Linux\n');
        expect((await run('uname -sm')).out).toBe('Linux x86_64\n');
        expect((await run('uname --kernel-name --machine')).out).toBe('Linux x86_64\n');
    });
    it('-a prints every field, in the order uname does', async () => {
        const [sys, node, rel, , ...rest] = (await run('uname -a')).out.trim().split(' ');
        expect([sys, node, rel]).toEqual(['Linux', 'shiro', '0.1.0']);
        expect(rest.slice(-2)).toEqual(['x86_64', 'GNU/Linux']);
    });
});

describe('df -P is POSIX format', () => {
    it('uses 1024-blocks and Capacity; the default and -h formats are unchanged', async () => {
        expect((await run('df -P /workspace')).out).toMatch(/^Filesystem +1024-blocks +Used +Available +Capacity +Mounted on\n\S+ +\d+ +\d+ +\d+ +\d+% +\S+\n$/);
        expect((await run('df /workspace')).out).toMatch(/^Filesystem +1K-blocks +Used +Available +Use% +Mounted on\n/);
        expect((await run('df -h /workspace')).out).toMatch(/^Filesystem +Size +Used +Avail +Use% +Mounted on\n/);
    });
});

describe('pip install --no-index', () => {
    it('says what pip says when a bare name cannot be found, without loading an interpreter', async () => {
        for (const cmd of ['pip', 'pip3']) {
            const r = await run(`${cmd} install --no-index --no-deps missing-coverage-package`);
            expect(r.code).toBe(1);
            expect(r.out).toBe('');
            expect(r.err).toBe('ERROR: Could not find a version that satisfies the requirement missing-coverage-package (from versions: none)\n'
                + 'ERROR: No matching distribution found for missing-coverage-package\n');
        }
    });
    it('asks for a requirement when none is given', async () => {
        const r = await run('pip install --no-index');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/You must give at least one requirement/);
    });
});

describe('setopt (zsh)', () => {
    // GNU Bash has no setopt, so there is no Bash behaviour to match (coverage-setopt-01 is integration-only).
    it('is accepted and changes nothing', async () => {
        expect(await run('setopt')).toEqual({ out: '', err: '', code: 0 });
        expect(await run('setopt extendedglob; echo ok')).toEqual({ out: 'ok\n', err: '', code: 0 });
    });
});

describe('uuid argument adapter', () => {
    it('maps the OSSP uuid command line onto the packaged v4 generator', () => {
        expect(adaptUuidArgs(['-v', '4'])).toEqual(['-H']);
        expect(adaptUuidArgs(['-v4'])).toEqual(['-H']);
        expect(adaptUuidArgs([])).toEqual(['-H']);
        expect(adaptUuidArgs(['-v', '4', '-F', 'STR', '-n', '1'])).toEqual(['-H']);
    });
    it("leaves the packaged tool's own options alone", () => {
        for (const a of [['--urn'], ['-u'], ['-H', '-u'], ['--help'], ['-V']]) expect(adaptUuidArgs(a)).toEqual(a);
    });
    it('refuses what the packaged tool cannot do, rather than printing the wrong thing', () => {
        expect(() => adaptUuidArgs(['-v', '1'])).toThrow(/only 4/);
        expect(() => adaptUuidArgs(['-n', '5'])).toThrow(/count of 1/);
        expect(() => adaptUuidArgs(['-F', 'BIN'])).toThrow(/only STR/);
        expect(() => adaptUuidArgs(['--bogus'])).toThrow(/unrecognized option/);
    });
});
