// tests/exec-sandbox.test.ts — agent code runs outside the page's origin and the user's files:
//   - the page side of the exec sandbox (exec-sandbox-host.ts) answers only its own frame, and
//     only the allowed workspace operations
//   - the sandbox bundle (dev-api.ts buildExecSandbox) swaps Web Storage/IndexedDB for stand-ins
//     and uses the workspace channel instead of the page's workspace module
//   - bubblewrap isolation for /api/execute (dev-api.ts bwrapArgs / toolchainBinds)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { bwrapArgs, toolchainBinds } from '../dev-api.ts';
import { sandboxCall, resetSandbox } from '../exec-sandbox-host.ts';

const W = globalThis as any;

describe('exec sandbox host', () => {
    let frame: HTMLIFrameElement, posted: any[];
    const fromFrame = (data: any, source: any = frame.contentWindow) =>
        window.dispatchEvent(new MessageEvent('message', { data, source }));

    beforeEach(async () => {
        const call = sandboxCall('js', { code: '1', files: {} });
        frame = document.querySelector('iframe[sandbox]') as HTMLIFrameElement;
        posted = [];
        frame.contentWindow!.postMessage = ((m: any) => { posted.push(m); }) as any;
        fromFrame({ fg: 'ready' });
        await vi.waitFor(() => expect(posted.some(m => m.fg === 'call')).toBe(true));
        fromFrame({ fg: 'reply', id: posted.find(m => m.fg === 'call').id, value: { stdout: '1' } });
        await call;
        posted = [];
    });
    afterEach(() => resetSandbox());

    it('is an opaque-origin frame loading the sandbox bundle', () => {
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');   // no allow-same-origin
        expect(frame.srcdoc).toContain('fg-exec-sandbox.js');
    });

    it('delivers progress only for its own frame and pending call, outside result streams', async () => {
        const onProgress = vi.fn();
        const call = sandboxCall('bash', {code:'echo hi'}, 1000, onProgress);
        await vi.waitFor(() => expect(posted.some(m => m.fg === 'call')).toBe(true));
        const id = posted.find(m => m.fg === 'call').id;
        fromFrame({fg:'progress',id,message:'ignored'},window);
        fromFrame({fg:'progress',id:id+1,message:'ignored'});
        fromFrame({fg:'progress',id,message:'Downloading grep'});
        expect(onProgress).toHaveBeenCalledExactlyOnceWith('Downloading grep');
        fromFrame({fg:'reply',id,value:{stdout:'hi\n',stderr:'',exit_code:0}});
        expect(await call).toEqual({stdout:'hi\n',stderr:'',exit_code:0});
        fromFrame({fg:'progress',id,message:'late'});
        expect(onProgress).toHaveBeenCalledOnce();
    });

    it('answers allowed workspace operations from its frame', async () => {
        W.agentListFiles = vi.fn(async () => [{ name: 'a.txt' }]);
        fromFrame({ fg: 'ws', id: 7, op: 'agentListFiles', args: [] });
        await vi.waitFor(() => expect(posted).toContainEqual({ fg: 'ws-reply', id: 7, value: [{ name: 'a.txt' }] }));
    });

    it('refuses any other operation', async () => {
        W.agentListFiles = vi.fn();
        for (const op of ['eval', 'loadServerKeys', 'executeToolAsync', 'localStorage'])
            fromFrame({ fg: 'ws', id: 8, op, args: [] });
        await vi.waitFor(() => expect(posted.filter(m => m.error?.startsWith('workspace op not allowed'))).toHaveLength(4));
    });

    it('limits the artifact cache to its own frame and reviewed public artifacts', async () => {
        fromFrame({fg:'package-cache',id:101,request:{op:'get',store:'chats',key:'secret'}});
        fromFrame({fg:'package-cache',id:102,request:{op:'get',store:'packages',key:'secret'}});
        fromFrame({fg:'package-cache',id:103,request:{op:'put',store:'packages',key:'grep',value:new ArrayBuffer(0)}});
        fromFrame({fg:'package-cache',id:104,request:{op:'keys',store:'packages'}},window);
        await vi.waitFor(() => expect(posted.filter(m=>m.fg === 'package-cache-reply')).toHaveLength(3));
        expect(posted.filter(m=>m.fg === 'package-cache-reply').every(m=>typeof m.error === 'string')).toBe(true);
        expect(posted.some(m=>m.id === 104)).toBe(false);
    });

    describe('network fallback', () => {
        const realFetch = globalThis.fetch;
        afterEach(() => { globalThis.fetch = realFetch; delete W.getEffectiveProxy; });

        it('fetches a plain GET through the proxy, never the URL itself', async () => {
            W.getEffectiveProxy = () => 'https://proxy.test';
            const f = vi.fn(async () => new Response('page', { headers: { 'Content-Type': 'text/html' } }));
            globalThis.fetch = f as any;
            fromFrame({ fg: 'net', id: 11, url: 'https://example.com/a?b=1' });
            await vi.waitFor(() => expect(posted.some(m => m.fg === 'net-reply')).toBe(true));
            expect(f).toHaveBeenCalledTimes(1);
            expect((f.mock.calls[0] as any)[0]).toBe('https://proxy.test?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1');
            const r = posted.find(m => m.fg === 'net-reply');
            expect(r.value.status).toBe(200);
            expect(r.value.contentType).toBe('text/html');
            expect(new TextDecoder().decode(r.value.body)).toBe('page');
        });

        it('refuses non-http URLs and reports proxy refusals', async () => {
            W.getEffectiveProxy = () => 'https://proxy.test';
            globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'private address' }),
                { status: 403, headers: { 'X-FG-Proxy-Error': '1' } })) as any;
            fromFrame({ fg: 'net', id: 12, url: 'file:///etc/passwd' });
            fromFrame({ fg: 'net', id: 13, url: 'https://10.0.0.1/' });
            await vi.waitFor(() => expect(posted.filter(m => m.fg === 'net-reply')).toHaveLength(2));
            expect(posted.find(m => m.id === 12).error).toMatch(/only http/);
            expect(posted.find(m => m.id === 13).error).toMatch(/proxy refused this URL — private address/);
        });

        it('fails without a proxy instead of fetching directly', async () => {
            W.getEffectiveProxy = () => '';
            const f = vi.fn(); globalThis.fetch = f as any;
            fromFrame({ fg: 'net', id: 14, url: 'https://example.com/' });
            await vi.waitFor(() => expect(posted.some(m => m.id === 14)).toBe(true));
            expect(posted.find(m => m.id === 14).error).toMatch(/no fetch proxy/);
            expect(f).not.toHaveBeenCalled();
        });

        it('ignores network requests from other windows', async () => {
            const f = vi.fn(); globalThis.fetch = f as any;
            W.getEffectiveProxy = () => 'https://proxy.test';
            fromFrame({ fg: 'net', id: 15, url: 'https://example.com/' }, window);
            await new Promise(r => setTimeout(r, 20));
            expect(f).not.toHaveBeenCalled();
        });
    });

    it('cancels a pending execution promptly and reloads the sandbox next time',async()=>{
        const controller=new AbortController();
        const call=sandboxCall('bash',{code:'sleep 600'},60_000,undefined,controller.signal);
        const cancelled=expect(call).rejects.toMatchObject({name:'AbortError'});
        await vi.waitFor(()=>expect(posted.some(m=>m.fg==='call')).toBe(true));
        controller.abort();await cancelled;
        expect(document.querySelector('iframe[sandbox]')).toBeNull();
    });
    it('finishes the current sandbox operation on stop-after-step',async()=>{
        await import('../agent-core.ts');
        const controller=new AbortController();W.setActiveAbortController(controller);
        const call=sandboxCall('bash',{code:'echo saved'},1000,undefined,controller.signal);
        await vi.waitFor(()=>expect(posted.some(m=>m.fg==='call')).toBe(true));
        W.stopAfterStep();expect(controller.signal.aborted).toBe(false);
        const id=posted.find(m=>m.fg==='call').id;
        fromFrame({fg:'reply',id,value:{stdout:'saved\n',exit_code:0}});
        expect((await call).stdout).toBe('saved\n');
        W.setActiveAbortController(null);W.setSoftStopPending(false);
    });
    it('does not leave a failed postMessage timer that resets a later execution',async()=>{
        frame.contentWindow!.postMessage=(()=>{throw new DOMException('Cannot clone','DataCloneError');}) as any;
        await expect(sandboxCall('js',{},10)).rejects.toMatchObject({name:'DataCloneError'});
        await new Promise(resolve=>setTimeout(resolve,25));
        expect(frame.isConnected).toBe(true);
    });

    it('rejects boot waiters on reset and ignores a stale ready message',async()=>{
        resetSandbox();
        const first=sandboxCall('js');const failed=expect(first).rejects.toThrow('cancelled boot');
        const old=document.querySelector('iframe[sandbox]') as HTMLIFrameElement;
        const oldWindow=old.contentWindow;
        resetSandbox('cancelled boot');await failed;
        const next=sandboxCall('js');const current=document.querySelector('iframe[sandbox]') as HTMLIFrameElement;
        const messages:any[]=[];current.contentWindow!.postMessage=((m:any)=>messages.push(m)) as any;
        window.dispatchEvent(new MessageEvent('message',{source:oldWindow,data:{fg:'ready'}}));
        await Promise.resolve();expect(messages).toEqual([]);
        window.dispatchEvent(new MessageEvent('message',{source:current.contentWindow,data:{fg:'ready'}}));
        await vi.waitFor(()=>expect(messages.some(m=>m.fg==='call')).toBe(true));
        const call=messages.find(m=>m.fg==='call');
        window.dispatchEvent(new MessageEvent('message',{source:current.contentWindow,data:{fg:'reply',id:call.id,value:'new frame'}}));
        expect(await next).toBe('new frame');
    });

    it('ignores messages from other windows', async () => {
        W.agentListFiles = vi.fn(async () => []);
        fromFrame({ fg: 'ws', id: 9, op: 'agentListFiles', args: [] }, window);
        await new Promise(r => setTimeout(r, 20));
        expect(W.agentListFiles).not.toHaveBeenCalled();
        expect(posted).toHaveLength(0);
    });
});

describe('exec sandbox bundle', () => {
    let code = '';
    // Built in a separate Node process: esbuild refuses to start under jsdom (its TextEncoder
    // returns a Uint8Array from another realm).
    beforeAll(() => {
        if (process.env.FG_TEST_SANDBOX_BUNDLE) { code=readFileSync(process.env.FG_TEST_SANDBOX_BUNDLE,'utf8'); if(!code.trim()) throw new Error('Empty sandbox fixture'); return; }
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--loader', './js-to-ts-loader.mjs',
            'scripts/build-exec-sandbox.mjs'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
        if (r.error || r.status !== 0 || !r.stdout.trim()) throw new Error(`bundle build failed: ${r.error || r.stderr || 'empty output'}`);
        code = r.stdout;
    }, 60_000);

    function frameRealm({ legacy = false } = {}) {
        const posted: any[] = [], listeners: any[] = [];
        const files = new Map<string, any>([['sample.txt', {name:'sample.txt',content:'sample content'}]]);
        const urls = new Map<string, any>(); let next = 0;
        let context: any;
        const parent = { postMessage(message: any) {
            posted.push(message);
            if (message.fg !== 'ws') return;
            const args=message.args || []; let value: any;
            if (message.op === 'agentListFiles') value=[...files.values()];
            else if (message.op === 'readWorkspaceFile') value=files.get(args[0]) || null;
            else if (message.op === 'agentWriteFile') files.set(args[0],{name:args[0],content:args[1],encoding:args[2]});
            else if (message.op === 'agentDeleteFile') files.delete(args[0]);
            else throw new Error('Unexpected workspace operation');
            queueMicrotask(()=>listeners.forEach(fn=>fn({source:parent,data:{fg:'ws-reply',id:message.id,value}})));
        }};
        class RealmBlob { parts: any[]; constructor(parts:any[]) {this.parts=parts;} }
        const RealmURL = class extends URL {
            static createObjectURL(blob:any) {const url='blob:fixture-'+(++next);urls.set(url,blob);return url;}
            static revokeObjectURL(url:string) {urls.delete(url);}
        };
        const document = {
            createElement: () => ({remove() {},src:'',onload:null as any,onerror:null as any}),
            head: {appendChild(script:any) {
                try {runInContext(urls.get(script.src).parts.join(''),context);script.onload?.();}
                catch(error) {script.onerror?.(error);}
            }},
        };
        context=createContext({parent,document,addEventListener:(_name:string,fn:any)=>listeners.push(fn),
            setTimeout,clearTimeout,TextEncoder,TextDecoder,Blob:RealmBlob,URL:RealmURL,
            AbortController,AbortSignal,DOMException,fetch:async()=>{throw new Error('Unexpected direct fetch');},
            atob:(s:string)=>Buffer.from(s,'base64').toString('binary'),btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),
            console,Worker:class {},performance,crypto});
        runInContext('window=this;self=this;',context);
        if (legacy) runInContext(`
            BigInt=undefined;globalThis=undefined;
            delete Array.prototype.at;delete Array.prototype.findLast;
            delete Object.fromEntries;delete String.prototype.matchAll;delete Promise.allSettled;
            const NativeRegExp=RegExp;
            RegExp=function(pattern,flags){if(String(pattern).includes('(?<'))throw new SyntaxError('Unsupported lookbehind');return new NativeRegExp(pattern,flags);};
            RegExp.prototype=NativeRegExp.prototype;
        `,context);
        runInContext(code,context);
        const call=async(kind:string,payload:any) => {
            const id=++next;
            await listeners[0]({source:parent,data:{fg:'call',id,kind,...payload}});
            return posted.find(m=>m.fg==='reply' && m.id===id);
        };
        return {posted,files,call,context};
    }
    it('boots without BigInt/globalThis/new collection methods and executes JavaScript files', async () => {
        const realm=frameRealm({legacy:true});
        expect(realm.posted).toContainEqual({fg:'ready'});
        const reply=await realm.call('js',{code:`const fs=require('fs');console.log(fs.readFileSync('hello.txt','utf8'));fs.writeFileSync('out.txt','written');`,files:{'hello.txt':'visible content'}});
        expect(reply.error).toBeUndefined();expect(reply.value.stdout).toBe('visible content\n');
        expect(reply.value.written['out.txt']).toBe('written');
        await expect(runInContext('Promise.allSettled(new Set([Promise.resolve(1)])).then(x=>x.length)',realm.context)).resolves.toBe(1);
    });
    it('returns a useful bash capability error rather than breaking all tools on legacy engines', async () => {
        const realm=frameRealm({legacy:true});
        expect((await realm.call('bash',{code:'echo hi'})).error).toContain('requires BigInt');
        expect((await realm.call('js',{code:'console.log("still working")',files:{}})).value.stdout).toBe('still working\n');
    });
    it('loads modern formatting and bash through the same private workspace channel', async () => {
        const realm=frameRealm();
        const js=await realm.call('js',{code:'console.log({value:1})',files:{}});
        expect(js.error).toBeUndefined();expect(js.value.stdout).toBe('{ value: 1 }\n');
        const bash=await realm.call('bash',{code:'echo hello; printf "%s\\n" ok; echo saved > result.txt; cat result.txt'});
        expect(bash.error).toBeUndefined();expect(bash.value.exit_code).toBe(0);
        expect(bash.value.stdout).toBe('hello\nok\nsaved\n');
        expect(realm.files.get('result.txt').content).toBe('saved\n');
    });

    it('has no direct Web Storage or IndexedDB references', () => {
        expect(code).not.toMatch(/[^.\w$]localStorage\b/);
        expect(code).not.toMatch(/[^.\w$]sessionStorage\b/);
        expect(code).not.toMatch(/[^.\w$]indexedDB\.open/);
    });

    it('reaches the workspace through the channel, not the page module', () => {
        expect(code).toContain('agentWriteFile');
        expect(code).toContain('__fgExecChannel.workspaceCall');
        expect(code).not.toContain('_buildPyRunnerHtml');   // workspace.ts was not bundled
    });

    it('inlines the Pyodide worker, which uses in-memory files', () => {
        expect(code).toContain('pyodide.js');
        expect(code).not.toContain('IDBFS');
    });
});

describe('bubblewrap isolation', () => {
    it('exposes toolchain prefixes under $HOME but not private directories', () => {
        const home = mkdtempSync(join(process.cwd(), 'tmp-home-'));
        try {
            for (const d of ['anaconda3/bin', '.local/bin', '.config/tool/bin', 'bin']) mkdirSync(join(home, d), { recursive: true });
            const binds = toolchainBinds([`${home}/anaconda3/bin`, `${home}/.local/bin`, `${home}/.config/tool/bin`, `${home}/bin`, '/usr/bin'].join(':'), home);
            expect(binds).toContain(join(home, 'anaconda3'));
            expect(binds).toContain(join(home, '.local', 'bin'));
            expect(binds).not.toContain(join(home, '.local'));
            expect(binds).toContain(join(home, 'bin'));
            expect(binds).not.toContain(home);
            expect(binds.some(b => b.includes('.config'))).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });

    const hasBwrap = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
    it.runIf(hasBwrap)('hides files outside the system directories and the work directory', () => {
        const secretDir = mkdtempSync(join(process.cwd(), 'tmp-secret-'));
        const work = mkdtempSync('/tmp/fg-work-');
        try {
            writeFileSync(join(secretDir, 'credentials'), 'SECRET');
            const r = spawnSync('bwrap', [...bwrapArgs(work, '/usr/bin:/bin', '/nonexistent-home'), '--',
                'bash', '-c', `cat ${join(secretDir, 'credentials')}; echo ok > out.txt; cat out.txt`], { encoding: 'utf-8' });
            expect(r.stdout).not.toContain('SECRET');
            expect(r.stderr).toMatch(/No such file/);
            expect(r.stdout.trim()).toBe('ok');   // the work directory is writable
        } finally { rmSync(secretDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
    });
});

describe('approval default with isolation', () => {
    afterEach(() => { delete W.__FG_SERVER_INFO; localStorage.clear(); });

    it('does not ask for every command when the dev server isolates them', () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        W.__FG_SERVER_INFO = { execIsolated: true };
        expect(W.getToolApproval()).toBe('off');
        W.__FG_SERVER_INFO = { execIsolated: false };
        expect(W.getToolApproval()).toBe('high');
    });
});
