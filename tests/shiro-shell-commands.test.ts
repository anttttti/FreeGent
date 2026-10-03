// The browser shell (shiro/shell-singleton.ts) as the agent gets it: the commands the bash
// guidance promises are registered and run, against an in-memory workspace.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell } from '../shiro/shell-singleton';
import { setWasiWorkerFactory } from '../shiro/wasi-host';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
import { spin } from './helpers/wasm-assemble';

let sh: any;
// Line endings normalised as exec-sandbox/entry.ts does (shell.exec returns terminal output).
const run = async (cmd: string) => {
    const r = await sh.exec(cmd);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    return { out: lf(r.stdout), err: lf(r.stderr), code: r.exitCode ?? 0 };
};

beforeAll(async () => {
    files.set('a.txt', { content: 'one\ntwo\nthree\n', encoding: null });
    files.set('b.txt', { content: 'one\nTWO\nthree\n', encoding: null });
    files.set('data.json', { content: '{"items":[{"n":1},{"n":2}]}', encoding: null });
    sh = await getShell();
});

describe('browser shell commands', () => {
    it('registers every command the guidance lists', async () => {
        for (const c of ['curl', 'wget', 'npm', 'npx', 'diff', 'jq', 'rg', 'gzip', 'gunzip', 'mktemp',
                         'grep', 'sed', 'awk', 'find', 'sort', 'tar', 'xargs', 'python3', 'pytest', '7z', 'node'])
            expect((await run(`type ${c}`)).code, c).toBe(0);
    });

    it('diff', async () => {
        const r = await run('diff /workspace/a.txt /workspace/b.txt');
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/two/);
        expect(r.out).toMatch(/TWO/);
    });

    it('jq', async () => {
        expect((await run("jq '.items[].n' /workspace/data.json")).out.trim()).toBe('1\n2');
    });

    it('rg', async () => {
        expect((await run('rg -n thr /workspace/a.txt')).out).toMatch(/3:three/);
    });

    it('gzip round trip', async () => {
        const r = await run('cp /workspace/a.txt /workspace/c.txt && gzip /workspace/c.txt && gunzip -c /workspace/c.txt.gz');
        expect(r.out).toBe('one\ntwo\nthree\n');
    });

    it('mktemp', async () => {
        const r = await run('mktemp');
        expect(r.code).toBe(0);
        expect(r.out.trim()).toMatch(/tmp\./);
    });

    describe('timeout / nohup', () => {
        it('timeout runs the command and passes through output and exit status', async () => {
            expect(await run('timeout 5 echo hi')).toMatchObject({ out: 'hi\n', code: 0 });
            expect((await run('timeout 5 false')).code).toBe(1);
            expect((await run('timeout 5 nosuchcmd_xyz')).code).toBe(127);
            expect((await run("timeout 5 sh -c 'exit 3'")).code).toBe(3);
        });
        it('timeout quotes arguments and forwards piped stdin', async () => {
            expect((await run("timeout 5 echo 'a  b' 'c d'")).out).toBe('a  b c d\n');
            expect((await run('echo piped | timeout 5 cat')).out).toBe('piped\n');
        });
        it('timeout kills long commands with status 124', async () => {
            const t0 = Date.now();
            const r = await run('timeout 0.2 sleep 5');
            expect(r.code).toBe(124);
            expect(Date.now() - t0).toBeLessThan(2000);
            expect((await run('timeout -s KILL 0.2 sleep 5')).code).toBe(137);
            expect((await run('timeout --preserve-status 0.2 sleep 5')).code).toBe(143);
            expect((await run('timeout 0 echo nolimit')).out).toBe('nolimit\n');
        });
        it('timeout validates its arguments', async () => {
            expect((await run('timeout')).code).toBe(125);
            expect((await run('timeout abc echo')).code).toBe(125);
            expect((await run('timeout 5')).code).toBe(125);
        });
        it('nohup runs the command (stdout passes through when not a terminal)', async () => {
            expect(await run('nohup echo hello')).toMatchObject({ out: 'hello\n', code: 0 });
            expect((await run('nohup false')).code).toBe(1);
            expect((await run('nohup')).code).toBe(125);
        });
    });

    describe('xz / zstd', () => {
        for (const [tool, ext, cat] of [['xz', 'xz', 'xzcat'], ['zstd', 'zst', 'zstdcat'], ['bzip2', 'bz2', 'bzcat']] as const) {
            const un = tool === 'xz' ? 'unxz' : tool === 'zstd' ? 'unzstd' : 'bunzip2';
            it(`${tool}: compress, decompress and keep a file`, async () => {
                await run(`seq 1 500 > n_${tool}.txt`);
                expect((await run(`${tool} -k n_${tool}.txt`)).code).toBe(0);
                expect((await run(`ls n_${tool}.txt.${ext}`)).code).toBe(0);
                expect((await run(`wc -c < n_${tool}.txt.${ext}`)).out.trim()).not.toBe('');
                await run(`rm n_${tool}.txt`);
                expect((await run(`${un} n_${tool}.txt.${ext}`)).code).toBe(0);
                expect((await run(`cat n_${tool}.txt | wc -l`)).out.trim()).toBe('500');
                // xz and bzip2 delete their input unless -k; zstd keeps it unless --rm
                expect((await run(`ls n_${tool}.txt.${ext}`)).code).toBe(tool === 'zstd' ? 0 : 2);
            });
            it(`${tool}: pipes, ${cat}, -t and error handling`, async () => {
                expect((await run(`seq 1 300 | ${tool} -c | ${tool} -dc | tail -1`)).out.trim()).toBe('300');
                await run(`seq 1 300 | ${tool} -c > p_${tool}.${ext}`);
                expect((await run(`${cat} p_${tool}.${ext} | wc -l`)).out.trim()).toBe('300');
                expect((await run(`${tool} -t p_${tool}.${ext}`)).code).toBe(0);
                expect((await run(`echo notcompressed | ${tool} -dc`)).code).not.toBe(0);
                expect((await run(`${tool} -d nosuchfile.${ext}`)).code).toBe(1);
                await run(`echo x > bad_${tool}.txt`);
                expect((await run(`${tool} -d bad_${tool}.txt`)).err).toMatch(/unknown extension/);
            });
            it(`${tool}: refuses to overwrite without -f`, async () => {
                await run(`echo hi > o_${tool}.txt && ${tool} -k o_${tool}.txt`);
                expect((await run(`${tool} -k o_${tool}.txt`)).err).toMatch(/already exists/);
                expect((await run(`${tool} -kf o_${tool}.txt`)).code).toBe(0);
            });
        }
    });

    describe('quoting', () => {
        it('does not expand $(( )) inside single quotes (bash prints the text)', async () => {
            expect((await run("echo '$((1+2))'")).out).toBe('$((1+2))\n');
            expect((await run("echo 'a $((1+2)) b' \"$((1+2))\"")).out).toBe('a $((1+2)) b 3\n');
            expect((await run("x=5; echo $((x*2)) '$x'")).out).toBe('10 $x\n');
        });
    });

    describe('timeout cancels what it runs', () => {
        it('wakes a sleeping command promptly', async () => {
            const t0 = Date.now();
            const r = await run('timeout 0.2 sleep 5; echo status=$?');
            expect(r.out).toBe('status=124\n');
            expect(Date.now() - t0).toBeLessThan(2000);
        });
        it('stops the rest of a multi-statement command', async () => {
            const r = await run("timeout 0.3 sh -c 'sleep 5; echo late'; echo after");
            expect(r.out).toBe('after\n');
        });
        it('does not abort the enclosing script', async () => {
            const r = await run('timeout 0.1 sleep 5; echo one; timeout 5 echo two; echo three');
            expect(r.out).toBe('one\ntwo\nthree\n');
        });
        it('kills a WASM program that never returns', async () => {
            setWasiWorkerFactory(await nodeWorkerFactory());
            try {
                files.set('spin.wasm', { content: Buffer.from(spin()).toString('base64'), encoding: 'base64' });
                const t0 = Date.now();
                const r = await run('timeout 0.4 /workspace/spin.wasm; echo status=$?');
                expect(r.out).toBe('status=124\n');
                expect(Date.now() - t0).toBeLessThan(5000);
            } finally { setWasiWorkerFactory(null); }
        });
    });

    describe('pkg-config', () => {
        const pc = (n: string, body: string) => files.set(n, { content: body, encoding: null });
        beforeAll(() => {
            pc('pcx/foo.pc', 'prefix=/opt/foo\nlibdir=${prefix}/lib\nName: Foo\nDescription: d\nVersion: 1.2.10\nRequires: bar >= 2\nLibs: -L${libdir} -lfoo\nLibs.private: -lm\nCflags: -I${prefix}/include -DFOO\n');
            pc('pcx/bar.pc', 'Name: Bar\nDescription: b\nVersion: 2.1\nLibs: -lbar\n');
        });
        const env = 'PKG_CONFIG_PATH=/workspace/pcx';
        it('reads real .pc files, including Requires', async () => {
            expect((await run(`${env} pkg-config --cflags foo`)).out).toBe('-DFOO -I/opt/foo/include\n');
            expect((await run(`${env} pkg-config --libs foo`)).out).toBe('-L/opt/foo/lib -lfoo -lbar\n');
            expect((await run(`${env} pkg-config --libs --static foo`)).out).toBe('-L/opt/foo/lib -lfoo -lm -lbar\n');
            expect((await run(`${env} pkg-config --variable=libdir foo`)).out).toBe('/opt/foo/lib\n');
        });
        it('is honest about missing packages and versions', async () => {
            expect((await run(`${env} pkg-config --exists nope`)).code).toBe(1);
            expect((await run(`${env} pkg-config --atleast-version=1.2.9 foo`)).code).toBe(0);
            expect((await run(`${env} pkg-config --atleast-version=1.3 foo`)).code).toBe(1);
            expect((await run(`${env} pkg-config --modversion zlib`)).code).toBe(1);
        });
    });
});
