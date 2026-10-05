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
    setWasiWorkerFactory(await nodeWorkerFactory());
    if (process.env.FG_NET_TESTS) {
        vi.mocked(fetch).mockImplementation((...args:any[]) => (globalThis as any).__nativeFetchForTests(...args));
    }
    sh = await getShell();
});

describe('browser shell commands', () => {
    it('matches Bash help synopsis and malformed bzip2 stdin diagnostics', async () => {
        expect(await run('help -s cd')).toEqual({out:'cd: cd [-L|[-P [-e]] [-@]] [dir]\n',err:'',code:0});
        expect(await run('printf invalid | bzip2 -dc')).toEqual({out:'',err:'bzip2: (stdin) is not a bzip2 file.\n',code:2});
        expect(await run('printf invalid | zstd -dc')).toEqual({out:'',err:'zstd: /*stdin*\\: unsupported format \n',code:1});
        expect(await run('printf hello | openssl base64')).toEqual({out:'aGVsbG8=\n',err:'',code:0});
        expect(await run('printf hello | openssl base64 -A')).toEqual({out:'aGVsbG8=',err:'',code:0});
        expect((await run('openssl dgst -sha256 a.txt')).out).toBe('SHA2-256(a.txt)= b6285c57e8797db5d4c51c80d6f11938afda9b11c6a003549709189e9b4b92a2\n');
        expect((await run('umask 077; touch private-mask.txt; stat -c %a private-mask.txt')).out).toBe('600\n');
        await run('rm private-mask.txt; umask 022');
        expect(await run('chown 1000:1000 missing-file')).toEqual({out:'',err:"chown: cannot access 'missing-file': No such file or directory\n",code:1});
        expect(await run('chown 1000:1000 a.txt')).toEqual({out:'',err:'chown: workspace ownership changes are unavailable in the browser; select native execution\n',code:1});
        expect(sh.commands.get('chown').parityScope).toBe('capability-only');
        expect(await run('ln -s a.txt link.txt')).toEqual({out:'',err:'ln: workspace links are unavailable in the browser; select native execution\n',code:1});
        expect(sh.commands.get('ln').parityScope).toBe('capability-only');
        expect(await run('ulimit -f')).toEqual({out:'',err:'ulimit: kernel resource limits are unavailable in the browser; select native execution\n',code:2});
        expect(sh.commands.get('ulimit').parityScope).toBe('capability-only');
    });

    it('preserves OpenSSL base64 decoded bytes and uses its 64-column wrapping', async () => {
        expect(await run("printf 'YQoK' | openssl base64 -d -A")).toEqual({out:'a\n\n',err:'',code:0});
        const expected = Buffer.from('x'.repeat(60)).toString('base64');
        expect((await run("printf '%060d' 0 | tr 0 x | openssl base64")).out).toBe(expected.slice(0,64)+'\n'+expected.slice(64)+'\n');
    });

    it('shares umask state and prints symbolic modes without placeholder characters', async () => {
        expect((await run('umask 022; umask -pS')).out).toBe('umask -S u=rwx,g=rx,o=rx\n');
        expect((await run('umask -S 077; umask -S')).out).toBe('u=rwx,g=,o=\nu=rwx,g=,o=\n');
        expect((await run('umask u=rwx,g=rx,o=; umask')).out).toBe('0027\n');
        await run('umask 022');
    });

    it('applies a fork-isolated creation mask to writes, appends and directories', async () => {
        const r = await run('umask 077; printf x > mask-output; printf y >> mask-append; mkdir -p mask-dirs/nested; mkdir -m 755 mask-explicit; stat -c %a mask-output mask-append mask-dirs mask-dirs/nested mask-explicit');
        expect(r).toEqual({out:'600\n600\n700\n700\n755\n',err:'',code:0});
        const child = sh.fork(); child.umask = 0o027;
        await child.exec('touch mask-child');
        await run('touch mask-parent; chmod 644 mask-output; printf z > mask-output');
        expect((await run('stat -c %a mask-child mask-parent mask-output')).out).toBe('640\n600\n644\n');
        await run('rm -rf mask-output mask-append mask-dirs mask-explicit mask-child mask-parent; umask 022');
    });

    it('registers every command the guidance lists', async () => {
        for (const c of ['curl', 'wget', 'npm', 'npx', 'diff', 'jq', 'rg', 'gzip', 'gunzip', 'mktemp',
                         'grep', 'sed', 'awk', 'find', 'sort', 'tar', 'xargs', 'python3', 'pytest', '7z', 'node'])
            expect((await run(`type ${c}`)).code, c).toBe(0);
    });

    it('orders grammar, enabled aliases, functions and builtins before external lookup', async () => {
        const child = sh.fork();
        const capture = async (code:string) => {
            const r = await child.exec(code);
            return {out:r.stdout.replace(/\r\n/g,'\n'),err:r.stderr.replace(/\r\n/g,'\n'),code:r.exitCode};
        };
        await child.exec("function echo() { printf 'function\\n'; }; alias echo='printf alias'; shopt -s expand_aliases");
        // Separate parses match Bash's alias definition/expansion timing.
        expect((await capture('echo ignored')).out).toBe('alias');
        await child.exec('unalias echo');
        expect((await capture('echo ignored')).out).toBe('function\n');
        expect((await capture('command echo builtin')).out).toBe('builtin\n');
        expect((await capture('builtin echo direct')).out).toBe('direct\n');
        await child.exec("alias if='printf wrong'; function if() { printf 'wrong'; }");
        expect(await capture('if true; then printf grammar; fi')).toEqual({out:'grammar',err:'',code:0});
    });

    it('lets executable user PATH scripts shadow catalog commands, with hash preceding PATH', async () => {
        const child = sh.fork();
        const capture = async (code:string) => {
            const r = await child.exec(code);
            return {out:r.stdout.replace(/\r\n/g,'\n'),err:r.stderr.replace(/\r\n/g,'\n'),code:r.exitCode};
        };
        await child.exec("mkdir -p /workspace/precedence-a /workspace/precedence-b; printf '#!/bin/sh\\nprintf first' > /workspace/precedence-a/seq; printf '#!/bin/sh\\nprintf second' > /workspace/precedence-b/seq; chmod +x /workspace/precedence-a/seq /workspace/precedence-b/seq");
        child.env.PATH = '/workspace/precedence-a:/workspace/precedence-b';
        expect(await capture('seq 1')).toEqual({out:'first',err:'',code:0});
        expect((await capture('command -v seq')).out).toBe('/workspace/precedence-a/seq\n');
        await child.exec('hash -p /workspace/precedence-b/seq seq');
        expect((await capture('seq 1')).out).toBe('second');
        child.env.PATH = '/workspace/precedence-a';
        expect((await capture('seq 1')).out).toBe('first');
        child.env.PATH = '/missing';
        expect(await capture('seq 1 2')).toEqual({out:'1\n2\n',err:'',code:0});
        await child.exec('rm -rf /workspace/precedence-a /workspace/precedence-b');
    });

    it('discovers a lazy package after catalog lookup without downloading it', async () => {
        const child = sh.fork(); child.env.PATH = '/missing';
        const calls = vi.mocked(fetch).mock.calls.length;
        expect((await child.resolveCommand('seq')).route).toBe('registry');
        expect((await child.resolveCommand('gsort')).route).toBe('package');
        expect((await child.exec('command -v gsort')).exitCode).toBe(0);
        expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    });

    it('uses shell discovery for registered type and command adapters', async () => {
        const child = sh.fork();
        for (const [name,args,out] of [
            ['type',['-t','printf'],'builtin\n'],
            ['command',['-v','missing-discovery','printf'],'printf\n'],
            ['command',['printf','%s\n','argument with spaces'],'argument with spaces\n'],
        ] as const) {
            const ctx = {args:[...args],fs:child.fs,cwd:child.cwd,env:child.env,stdin:'',stdout:'',stderr:'',shell:child};
            expect(await child.commands.get(name).exec(ctx)).toBe(0);
            expect(ctx.stdout).toBe(out);
            expect(ctx.stderr).toBe('');
        }
    });

    it('uses Bash option order and alias expansion state for discovery', async () => {
        const child = sh.fork();
        const capture = async (code:string) => {
            const result = await child.exec(code);
            return {out:result.stdout.replace(/\r\n/g,'\n'),err:result.stderr.replace(/\r\n/g,'\n'),code:result.exitCode};
        };
        expect(await capture('type -tp echo; type -pt echo')).toEqual({out:'builtin\n',err:'',code:0});
        expect(await capture("shopt -u expand_aliases; alias dprobe='printf alias'; type -t dprobe")).toEqual({out:'',err:'',code:1});
        expect(await capture('shopt -s expand_aliases; type -t dprobe')).toEqual({out:'alias\n',err:'',code:0});
        expect(await capture('command -v missing-discovery echo')).toEqual({out:'echo\n',err:'',code:0});
        expect(await capture('hash -p /missing dprobe; type -aP dprobe')).toEqual({out:'/missing\n',err:'',code:0});
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
                expect((await run(`${tool} -d bad_${tool}.txt`)).err).toMatch(/unknown (extension|suffix)/);
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
                const r = await run('chmod +x /workspace/spin.wasm; timeout 0.4 /workspace/spin.wasm; echo status=$?');
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


describe('argv dispatch and capability failures', () => {
    it('uses one hash owner for registered calls and shell lookup', async () => {
        const child = sh.fork();
        await child.processHash(['-r']);
        await child.fs.writeFile('/workspace/hash-owner-test','printf mapped',{mode:0o755});
        try {
            const ctx:any = {args:['-p','/workspace/hash-owner-test','hash-owner-name'],shell:child,stdout:'',stderr:''};
            expect(await child.commands.get('hash').exec(ctx)).toBe(0);
            expect((await child.execArgv(['hash-owner-name'])).stdout).toBe('mapped');
            expect(await child.processHash([])).toEqual({stdout:'hits\tcommand\n   1\t/workspace/hash-owner-test\n',stderr:'',exitCode:0});
            const result = await child.processHash(['-d','hash-owner-name']);
            expect(result.exitCode).toBe(0);
            expect(await child.processHash(['-l'])).toEqual({stdout:'',stderr:'',exitCode:0});
        } finally { await child.fs.unlink('/workspace/hash-owner-test'); }
    });
    it('invalidates hashes for every PATH assignment and isolates child tables', async () => {
        const child = sh.fork();
        await child.processHash(['-r']);
        await child.processHash(['-p','/missing','hash-owner-name']);
        const nested = child.fork();
        await nested.processHash(['-r']);
        expect((await child.processHash(['-l'])).stdout).toContain('/missing');
        child.env.PATH = child.env.PATH;
        expect((await child.processHash(['-l'])).stdout).toBe('');
        await child.processHash(['-p','/missing','hash-owner-name']);
        delete child.env.PATH;
        expect((await child.processHash(['-l'])).stdout).toBe('');
    });
    it('rejects non-executable and missing explicitly hashed scripts', async () => {
        const child = sh.fork();
        await child.fs.writeFile('/workspace/hash-mode-test','printf should-not-run',{mode:0o644});
        try {
            await child.processHash(['-p','/workspace/hash-mode-test','hash-owner-name']);
            const result = await child.execArgv(['hash-owner-name']);
            expect(result.exitCode).toBe(126);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('bash: line 1: /workspace/hash-mode-test: Permission denied\n');
            await child.fs.unlink('/workspace/hash-mode-test');
            expect((await child.execArgv(['hash-owner-name'])).exitCode).toBe(127);
        } finally { if (await child.fs.exists('/workspace/hash-mode-test')) await child.fs.unlink('/workspace/hash-mode-test'); }
    });
    it('terminates scripts and loops with exit/exec while isolating child shells', async () => {
        expect(await run('echo before; exit 0; echo after')).toEqual({out:'before\n',err:'',code:0});
        expect(await run('false; exit')).toEqual({out:'',err:'',code:1});
        expect((await run('for i in a b; do exit 7; done; echo after')).code).toBe(7);
        expect((await run('(exit 3); echo outer; echo "$(exit 4)"; echo end')).out).toBe('outer\n\nend\n');
        expect((await run('echo before | exit 0; echo outer')).out).toBe('outer\n');
        expect((await run('exit 8 | cat; echo outer')).out).toBe('outer\n');
        expect((await run("exec printf '%s\\n' 'a b' '$HOME'; echo after")).out).toBe('a b\n$HOME\n');
    });
    it('uses source arguments temporarily and keeps exec redirections', async () => {
        await sh.fs.writeFile('/workspace/source-args.sh','printf "%s\\n" "$#" "$1" "$2"');
        expect((await run('set -- outer; source source-args.sh "a b" c; echo "$#:$1"')).out).toBe('2\na b\nc\n1:outer\n');
        const child = sh.fork();
        expect((await child.exec('exec > exec-output; echo one; printf two')).stdout).toBe('');
        expect(await sh.fs.readFile('/workspace/exec-output','utf8')).toBe('one\ntwo');
    });
    it('shares ordered output descriptors between builtins and registered programs', async () => {
        expect(await run('declare -p nonexistent_redirect_var 2>/dev/null; echo next')).toEqual({out:'next\n',err:'',code:0});
        expect(await run('cat nonexistent_redirect_file 2>&1 >/dev/null')).toEqual({out:'cat: nonexistent_redirect_file: No such file or directory\n',err:'',code:1});
        expect(await run('cat nonexistent_redirect_file >/dev/null 2>&1')).toEqual({out:'',err:'',code:1});
        await run('echo old > redirect-file; true > redirect-file');
        expect(await sh.fs.readFile('/workspace/redirect-file','utf8')).toBe('');
        await run('declare -p nonexistent_redirect_var 2> redirect-file');
        expect(await sh.fs.readFile('/workspace/redirect-file','utf8')).toBe('bash: declare: nonexistent_redirect_var: not found\n');
    });
    it('forwards process substitution diagnostics and isolates child state', async () => {
        expect(await run('cat <(cat nonexistent_substitution_file)')).toEqual({out:'',err:'cat: nonexistent_substitution_file: No such file or directory\n',code:0});
        expect((await run('value=parent; cat <(value=child; echo "$value"); echo "$value"')).out).toBe('child\nparent\n');
        vi.spyOn(Date,'now').mockReturnValue(123456);
        try { expect((await run("comm -12 <(printf 'a\\nb\\nc\\n') <(printf 'b\\nc\\nd\\n')")).out).toBe('b\nc\n'); }
        finally { vi.restoreAllMocks(); }
    });
    it('checks filesystem operations before mutation and preserves rename metadata', async () => {
        await expect(sh.fs.writeFile('/workspace/missing-parent/file','x')).rejects.toMatchObject({code:'ENOENT'});
        await expect(sh.fs.readdir('/workspace/absent-directory')).rejects.toMatchObject({code:'ENOENT'});
        await sh.fs.mkdir('/workspace/metadata-dir',{recursive:true});
        await expect(sh.fs.writeFile('/workspace/metadata-dir','x')).rejects.toMatchObject({code:'EISDIR'});
        await sh.fs.writeFile('/workspace/mode-file','x');
        await sh.fs.chmod('/workspace/mode-file',0o600);
        await sh.fs.utimes('/workspace/mode-file',new Date(1000),new Date(2000));
        await sh.fs.rename('/workspace/mode-file','/workspace/moved-mode-file');
        const st = await sh.fs.stat('/workspace/moved-mode-file');
        expect(st.mode).toBe(0o600); expect(st.mtime.getTime()).toBe(2000); expect(st.atime.getTime()).toBe(1000);
        await expect(sh.fs.mkdir('/workspace/moved-mode-file',{recursive:true})).rejects.toMatchObject({code:'EEXIST'});
    });
    it('preserves literal expansion syntax, empty arguments, CRLF and binary stdin', async () => {
        // Use a command context to check every argument without printf's format-repetition rules.
        sh.commands.register({name:'capture-argv',description:'test',async exec(ctx:any) {ctx.stdout = JSON.stringify(ctx.args); return 0;}});
        const argv = ['', '$HOME', '$(echo injected)', '*', 'a\nb', 'a; false'];
        expect((await sh.execArgv(['capture-argv',...argv])).stdout).toBe(JSON.stringify(argv));
        expect((await sh.execArgv(['cat'], 'x\r\n\0\udcff')).stdout).toBe('x\r\n\0\udcff');
    });
    it('does not create temporary stdin files', async () => {
        const before = await sh.fs.readdir('/tmp');
        expect((await run("printf hi | timeout 5 cat")).out).toBe('hi');
        expect(await sh.fs.readdir('/tmp')).toEqual(before);
    });
    it('honors function precedence and command/builtin bypass', async () => {
        expect((await run('echo() { printf function; }; echo; command echo native; builtin echo builtin; unset -f echo')).out).toBe('functionnative\nbuiltin\n');
    });
    it('keeps catalog defaults after explicit package alternatives are installed', async () => {
        await sh.fs.mkdir('/usr/local/bin',{recursive:true});
        await sh.fs.writeFile('/usr/local/bin/grep','#!wasi-pkg grep\n',{mode:0o755});
        expect((await sh.resolveCommand('grep')).route).toBe('registry');
        expect((await sh.resolveCommand('/usr/local/bin/grep')).path).toBe('/usr/local/bin/grep');
        await sh.fs.unlink('/usr/local/bin/grep');
    });
    it('reports native-only utilities and process descriptors as capabilities', async () => {
        expect(sh.commands.get('make').parityScope).toBe('capability-only');
        expect(await run('make')).toEqual({out:'',err:'make: recipe execution is unavailable in the browser shell; select native execution\n',code:2});
        await run('echo target > link-target');
        expect((await run('ln -s link-target link-name')).code).toBe(1);
        expect(await sh.fs.exists('/workspace/link-name')).toBe(false);
        expect(sh.commands.get('col').parityScope).toBe('capability-only');
        expect(await run("printf 'hello\\n' | col -b")).toEqual({out:'',err:'col: validated terminal filtering is unavailable in the browser; select native execution\n',code:2});
        expect(await run('coproc echo hello')).toEqual({out:'',err:'bash: coproc: process file descriptors are unsupported; select native execution\n',code:2});
        const listing = await run('ls -lh a.txt');
        expect(listing.code).toBe(0);
        expect(listing.out).toMatch(/user user\s+14 .* a\.txt\n$/);
    });
    it('tests package and browser-opening contracts outside Bash parity', async () => {
        expect(sh.commands.get('pkg').parityScope).toBe('integration-only');
        expect(sh.commands.get('open').parityScope).toBe('integration-only');
        expect(sh.commands.get('xdg-open').parityScope).toBe('integration-only');
        expect((await run('pkg search grep')).out).toContain('grep');
        expect((await run('pkg search')).code).toBe(1);

        const open = vi.spyOn(window,'open').mockReturnValue(null);
        try {
            expect(await run('open https://example.test/path')).toEqual({out:'',err:'',code:0});
            expect(await run('xdg-open https://example.test/other')).toEqual({out:'',err:'',code:0});
            expect(open.mock.calls).toEqual([['https://example.test/path','_blank'],['https://example.test/other','_blank']]);
        } finally { open.mockRestore(); }
        expect(await run('open a.txt')).toEqual({out:'',err:"open: no browser handler for 'a.txt'; select native execution\n",code:2});
    });
    it('keeps child cwd and environment changes out of the parent', async () => {
        await run('saved=value');
        expect((await run("env -i saved=child sh -c 'cd /tmp; echo $saved'; echo $saved; pwd")).out).toBe('child\nvalue\n/workspace\n');
    });
});
