// WASM packages (pkg install) run through the WASI runtime in the agent shell.
//  - extraction of the module from a .webc container (offline)
//  - end to end installs and runs against the real CDN (opt in: FG_NET_TESTS=1)
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { extractWasmFromWebc } from '../shiro/wasi-packages';
import { compileWasm, memoryImports } from '../shiro/wasm-module';
import { setWasiWorkerFactory } from '../shiro/wasi-host';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
import { getShell } from '../shiro/shell-singleton';

describe('extractWasmFromWebc', () => {
    // minimal valid module: header + empty type section + empty data section
    const module = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x0b, 0x01, 0x00];

    it('cuts the module at its real end even when the bytes after it look like sections', () => {
        // a Table section after the Data section violates section order: it is not part of the module
        const trailing = [0x04, 0x01, 0x00, 0x03, 0x02, 0x01, 0x00, 0x07, 0xff, 0xee];
        const webc = new Uint8Array([...Buffer.from('\0webc002'), 9, 9, 9, ...module, ...trailing]);
        const out = new Uint8Array(extractWasmFromWebc(webc.buffer)!);
        expect([...out]).toEqual(module);
        expect(WebAssembly.validate(out)).toBe(true);
    });

    it('keeps trailing custom sections (name section etc.)', () => {
        const custom = [0x00, 0x05, 0x04, 0x6e, 0x61, 0x6d, 0x65];
        const webc = new Uint8Array([1, 2, 3, ...module, ...custom, 0xff, 0xff]);
        const out = new Uint8Array(extractWasmFromWebc(webc.buffer)!);
        expect([...out]).toEqual([...module, ...custom]);
    });

    it('returns null when there is no module', () => {
        expect(extractWasmFromWebc(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer)).toBeNull();
    });
});

describe('compileWasm', () => {
    // (module (import "env" "memory" (memory 1 2 shared)))
    const sharedMemImport = [
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x02,
    ];

    it('rewrites an imported shared memory into an ordinary one the host can provide', async () => {
        const bytes = new Uint8Array(sharedMemImport);
        const mod = await compileWasm(bytes);
        expect(memoryImports.get(mod)).toEqual({ module: 'env', name: 'memory', initial: 1, maximum: 2, wasShared: true });
        // a plain (non-shared) memory now links, so no SharedArrayBuffer / cross-origin isolation is needed
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
        await expect(WebAssembly.instantiate(mod, { env: { memory } })).resolves.toBeDefined();
        expect(bytes[bytes.length - 3]).toBe(0x03);   // the caller's bytes are untouched
    });

    it('leaves modules without a memory import alone', async () => {
        const mod = await compileWasm(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
        expect(memoryImports.get(mod)).toBeUndefined();
    });
});

describe.skipIf(!process.env.FG_NET_TESTS)('pkg install: real packages (network)', () => {
    let sh: any;
    const run = async (cmd: string) => {
        const r = await sh.exec(cmd);
        const lf = (s: string) => s.replace(/\r\n/g, '\n');
        return { out: lf(r.stdout), err: lf(r.stderr), code: r.exitCode ?? 0 };
    };

    beforeAll(async () => {
        vi.unstubAllGlobals();   // tests/setup.js stubs fetch
        if (typeof fetch !== 'function') {
            (globalThis as any).fetch = async (url: string) => {
                const buf = execFileSync('curl', ['-sSL', '--fail', url], { maxBuffer: 1 << 28 });
                return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
            };
        }
        // run the packages the way the sandbox does: in a Worker, file changes applied afterwards
        setWasiWorkerFactory(await nodeWorkerFactory());
        sh = await getShell();
    });
    afterAll(() => setWasiWorkerFactory(null));

    const install = async (name: string) => expect((await run(`pkg install ${name}`)).code, `pkg install ${name}`).toBe(0);

    it('cowsay (wasi_snapshot_preview1)', async () => {
        await install('cowsay');
        expect((await run('cowsay moo')).out).toMatch(/< moo >/);
    }, 60000);

    it('quickjs (wasi_unstable): -e, script files, utf-8', async () => {
        await install('quickjs');
        expect((await run("qjs -e 'console.log(2**10)'")).out).toBe('1024\n');
        await run("echo 'console.log(6*7)' > t.js");
        expect((await run('qjs t.js')).out).toBe('42\n');
        expect((await run('qjs -e \'console.log("h\\u00e9llo")\'')).out).toBe('héllo\n');
    }, 60000);

    it('sqlite (wasi_unstable): files persist between runs', async () => {
        await install('sqlite');
        expect((await run("sqlite3 :memory: 'select 6*7'")).out).toBe('42\n');
        expect((await run("sqlite3 /workspace/t.db 'create table t(a); insert into t values (1),(2),(3);'")).code).toBe(0);
        expect((await run("sqlite3 /workspace/t.db 'select sum(a) from t'")).out).toBe('6\n');
    }, 60000);

    it('openssl: digest of stdin and of a file', async () => {
        await install('openssl');
        const sha = '98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4';   // sha256("hi\n")
        expect((await run('echo hi | openssl dgst -sha256')).out).toContain(sha);
        await run('echo hi > h.txt');
        expect((await run('openssl dgst -sha256 h.txt')).out).toContain(sha);
    }, 60000);

    it('brotli: binary data survives pipes', async () => {
        await install('brotli');
        expect((await run('seq 1 2000 | brotli | brotli -d | tail -1')).out).toBe('2000\n');
        expect((await run('seq 1 2000 | brotli | wc -c')).out.trim()).not.toBe('0');
    }, 60000);

    it('ruby: runs CRuby', async () => {
        await install('ruby');
        expect((await run("ruby -e 'puts [3,1,2].sort.inspect'")).out).toBe('[1, 2, 3]\n');
    }, 120000);

    // ── WASIX packages (wasix_32v1: shared imported memory, futex, getcwd, setjmp via asyncify …)
    it('grep (WASIX): GNU grep, relative paths, -r, -c', async () => {
        await install('grep');
        await run('echo hello > g.txt');
        expect((await run('/usr/local/bin/grep -n ell g.txt')).out).toBe('1:hello\n');
        expect((await run('echo abc | /usr/local/bin/grep -o b')).out).toBe('b\n');
        expect((await run('/usr/local/bin/grep --version | head -1')).out).toContain('GNU grep');
    }, 120000);

    it('sed (WASIX): GNU sed', async () => {
        await install('sed');
        expect((await run('echo abc | /usr/local/bin/sed s/b/X/')).out).toBe('aXc\n');
        await run('echo hello > g.txt');
        await run("/usr/local/bin/sed -i s/hello/HELLO/ g.txt");
        expect((await run('cat g.txt')).out).toBe('HELLO\n');
    }, 120000);

    it('coreutils (WASIX): applet aliases and real filesystem changes', async () => {
        await install('coreutils');
        await run('echo hello > g.txt');
        expect((await run('/usr/local/bin/gcat g.txt')).out).toBe('hello\n');
        expect((await run('echo hi | /usr/local/bin/gbase64')).out).toBe('aGkK\n');
        expect((await run('/usr/local/bin/gwc -c g.txt')).out).toBe('6 g.txt\n');
        await run('/usr/local/bin/coreutils mkdir -p d/e');
        expect((await run('ls d')).out).toBe('e\n');
        await run('/usr/local/bin/coreutils mv g.txt d/e/m.txt');
        expect((await run('cat d/e/m.txt')).out).toBe('hello\n');
        await run('/usr/local/bin/coreutils rm d/e/m.txt');
        expect((await run('ls d/e')).out).toBe('');
    }, 120000);

    it('dash and bash (WASIX): scripts, functions, arithmetic, cwd', async () => {
        await install('dash');
        await install('bash');
        await run("echo 'echo hi; pwd' > s.sh");
        expect((await run('/usr/local/bin/dash s.sh')).out).toBe('hi\n/workspace\n');
        expect((await run('/usr/local/bin/bash s.sh')).out).toBe('hi\n/workspace\n');
        expect((await run("/usr/local/bin/dash -c 'x=5; echo $((x*2)); f() { echo f$1; }; f 9'")).out).toBe('10\nf9\n');
        expect((await run("/usr/local/bin/bash -c 'a=(1 2 3); echo ${a[1]} ${#a[@]}; cd /; pwd'")).out).toBe('2 3\n/\n');
    }, 180000);

    it('php (WASIX): runs PHP 8.3 and reads and writes files', async () => {
        await install('php');
        expect((await run('/usr/local/bin/php -r \'echo json_encode([1,2,[3]]);\'')).out).toBe('[1,2,[3]]');
        await run("echo '<?php file_put_contents(\"o.txt\", \"php wrote\\n\");' > t.php");
        await run('/usr/local/bin/php t.php');
        expect((await run('cat o.txt')).out).toBe('php wrote\n');
    }, 300000);

    // ── processes: fork and exec in the WASIX shells (run in a Worker; the commands they exec run on the host)
    it('bash (WASIX): pipelines, command substitution, subshells and exit statuses', async () => {
        await install('bash');
        const bash = (script: string) => run(`/usr/local/bin/bash -c '${script}'`);
        expect((await bash('echo hello | tr a-z A-Z')).out).toBe('HELLO\n');
        expect((await bash('x=$(echo cap); echo got:$x')).out).toBe('got:cap\n');
        expect((await bash('for i in 1 2 3; do echo n$i; done | sort -r | head -2')).out).toBe('n3\nn2\n');
        expect((await bash('(exit 7); echo rc=$?')).out).toBe('rc=7\n');
        expect((await bash('ls nosuch 2>/dev/null; echo rc=$?')).out).toBe('rc=2\n');
        expect((await bash('nosuchcmd_xyz 2>/dev/null; echo rc=$?')).out).toBe('rc=127\n');
        expect((await bash('x=1; (x=2; echo in:$x); echo out:$x')).out).toBe('in:2\nout:1\n');          // a subshell cannot change its parent
        expect((await bash('cd /; (cd /usr; pwd); pwd')).out).toBe('/usr\n/\n');
        expect((await bash('sleep 0.01 & wait; echo done')).out).toBe('done\n');
        expect((await bash("cat <<EOF\nhi $USER\nEOF")).code).toBeDefined();
    }, 120000);

    it('bash (WASIX): files written by the shell and by the commands it runs see each other', async () => {
        await install('bash');
        const bash = (script: string) => run(`/usr/local/bin/bash -c '${script}'`);
        expect((await bash('tmp=$(mktemp); echo x > $tmp; cat $tmp; rm $tmp')).out).toBe('x\n');
        expect((await bash('echo one > a.txt; echo two >> a.txt; echo three >> a.txt; cat a.txt; wc -l < a.txt')).out).toBe('one\ntwo\nthree\n3\n');
        expect((await bash('mkdir -p d/e; echo hi > d/e/f.txt; ls d/e; cat d/e/f.txt; rm d/e/f.txt; ls d/e | wc -l')).out).toBe('f.txt\nhi\n0\n');
        expect((await bash('cp a.txt b.txt; mv b.txt c.txt; for f in [ac].txt; do echo f:$f; done')).out).toBe('f:a.txt\nf:c.txt\n');
        expect((await run('cat c.txt')).out).toBe('one\ntwo\nthree\n');                                  // and the host sees it afterwards
    }, 120000);

    it('bash (WASIX): exec replaces the shell, and nested bash works', async () => {
        await install('bash');
        expect((await run("/usr/local/bin/bash -c 'exec echo replaced; echo not-reached'")).out).toBe('replaced\n');
        expect((await run("/usr/local/bin/bash -c '/usr/local/bin/bash -c \"exit 5\"; echo rc=$?'")).out).toBe('rc=5\n');
    }, 120000);

    it('dash (WASIX): pipelines, substitution, redirections and PATH search', async () => {
        await install('dash');
        const dash = (script: string) => run(`/usr/local/bin/dash -c '${script}'`);
        expect((await dash('echo hi | tr a-z A-Z')).out).toBe('HI\n');
        expect((await dash('x=$(echo cap); echo got:$x')).out).toBe('got:cap\n');
        expect((await dash('echo a > f1; echo b >> f1; cat f1; wc -l < f1')).out).toBe('a\nb\n2\n');
        expect((await dash('ls nosuch 2>/dev/null; echo rc=$?')).out).toBe('rc=2\n');
        expect((await dash('nosuchcmd 2>/dev/null; echo rc=$?')).out).toBe('rc=127\n');
    }, 120000);

    it('php (WASIX): shell_exec, system, exec, popen and passthru', async () => {
        await install('php');
        const php = (code: string) => run(`/usr/local/bin/php -r '${code}'`);
        expect((await php('echo shell_exec("echo from-shell");')).out).toBe('from-shell\n');
        expect((await php('system("echo sys; exit 4", $rc); echo "rc=$rc\\n";')).out).toBe('sys\nrc=4\n');
        expect((await php('$p = popen("echo piped", "r"); echo fgets($p); pclose($p);')).out).toBe('piped\n');
        expect((await php('passthru("ls /nosuch 2>/dev/null", $rc); echo "rc=$rc";')).out).toBe('rc=2');
    }, 300000);
});
