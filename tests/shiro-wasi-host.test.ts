// execWasi: WASM programs run in a Worker with a deadline (shiro/wasi-host.ts).
// The modules are assembled by hand, so nothing here needs the network.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
import { spin, hello, trap } from './helpers/wasm-assemble';
import { execWasi, setWasiWorkerFactory, EXIT_DEADLINE } from '../shiro/wasi-host';
import { WasiRT, FD, WASI_FILETYPE_REGULAR_FILE } from '../shiro/wasi-runtime';

const compile = (b: Uint8Array) => WebAssembly.compile(b as unknown as BufferSource);
const run = async (b: Uint8Array, opts: Parameters<typeof execWasi>[2] = {}) => {
  let out = '', err = '';
  const code = await execWasi({
    fs: {
      readdir: async () => [],
      stat: async () => ({type:'dir', size:0, mtime:new Date(0)}),
    } as any, cwd: '/', args: ['prog'], env: {},
    onStdout: t => { out += t; }, onStderr: t => { err += t; },
  }, await compile(b), { preloadRoot: '/', ...opts });
  return { code, out, err };
};

afterEach(() => setWasiWorkerFactory(null));

describe('WASI import capability boundary', () => {
  const rt = () => new WasiRT({fs:{} as any, cwd:'/', args:['prog'], env:{}});
  const importing = async (namespace:string, name:string) => {
    const string = (value:string) => [value.length, ...Buffer.from(value)];
    const body = [1, ...string(namespace), ...string(name), 0, 0];
    return compile(Uint8Array.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,body.length,...body]));
  };
  it('rejects inherited object members as import namespaces', async () => {
    for (const namespace of ['constructor', '__proto__', 'toString']) {
      const module = await importing(namespace, 'constructor');
      expect(() => rt().getImports(module)).toThrow('Unsupported WASM import namespace');
    }
  });
  it('does not expose object constructors through an allowed namespace', async () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      const imports = rt().getImports(await importing('wasi_snapshot_preview1', name));
      expect(Object.getPrototypeOf(imports)).toBeNull();
      expect(Object.getPrototypeOf(imports.wasi_snapshot_preview1)).toBeNull();
      expect((imports.wasi_snapshot_preview1[name] as Function)()).toBe(52); // ENOSYS
    }
  });
  it('bounds-checks entropy buffers and chunks valid large requests', () => {
    const runtime = rt();
    const memory = new WebAssembly.Memory({initial:2});
    (runtime as any).memory = memory;
    const random = runtime.getImports().wasi_snapshot_preview1.random_get as Function;
    const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((buffer:any) => buffer.fill(0x7a));
    try {
      expect(random(-1,1)).toBe(21); // EFAULT
      expect(random(131072,1)).toBe(21);
      expect(entropy).not.toHaveBeenCalled();
      expect(random(0,65537)).toBe(0);
      expect(entropy.mock.calls.map(([bytes]) => bytes!.byteLength)).toEqual([65536,1]);
      expect(new Uint8Array(memory.buffer)[65536]).toBe(0x7a);
    } finally { entropy.mockRestore(); }
  });
});

describe('WASI descriptor seek semantics', () => {
  it('seeks regular files renumbered onto stdin and rejects duplicated streams', () => {
    const runtime = new WasiRT({fs:{} as any,cwd:'/',args:['probe'],env:{}});
    const memory = new WebAssembly.Memory({initial:1});
    (runtime as any).memory = memory;
    const imports:any = runtime.getImports();
    const wasi = imports.wasi_snapshot_preview1, wasix = imports.wasix_32v1;
    expect(wasi.fd_seek(0,0n,0,0)).toBe(70); // ESPIPE
    expect(wasi.fd_tell(0,0)).toBe(70);
    expect(wasix.fd_dup(1,8)).toBe(0);
    const view = new DataView(memory.buffer);
    const duplicate = view.getUint32(8,true);
    expect(wasi.fd_seek(duplicate,0n,0,0)).toBe(70);
    expect(wasi.fd_tell(duplicate,0)).toBe(70);
    const regular = new FD({path:'/input',filetype:WASI_FILETYPE_REGULAR_FILE,data:new Uint8Array(5)});
    (runtime as any).fds.set(99,regular);
    expect(wasi.fd_renumber(99,0)).toBe(0);
    expect(wasi.fd_seek(0,2n,0,0)).toBe(0);
    expect(view.getBigUint64(0,true)).toBe(2n);
    expect(wasi.fd_tell(0,0)).toBe(0);
    expect(view.getBigUint64(0,true)).toBe(2n);
    expect(wasi.fd_seek(0,0n,2,0)).toBe(0);
    expect(view.getBigUint64(0,true)).toBe(5n);
    expect(wasi.fd_seek(0,-6n,1,0)).toBe(28); // EINVAL, preserve position
    expect(wasi.fd_seek(0,0n,3,0)).toBe(28);
    expect(wasi.fd_seek(0,9007199254740992n,0,0)).toBe(61); // EOVERFLOW
    expect(regular.offset).toBe(5);
  });
});

describe('execWasi in a Worker', () => {
  it('includes a stalled filesystem snapshot in the wall-clock deadline', async () => {
    const create = vi.fn();
    setWasiWorkerFactory(create);
    let stderr = '';
    const code = await execWasi({fs:{readdir:()=>new Promise(()=>{})} as any,cwd:'/',args:['prog'],env:{},onStderr:s=>{stderr += s;}},await compile(hello()),{deadlineMs:50});
    expect(code).toBe(EXIT_DEADLINE);
    expect(stderr).toContain('still running after 0.05s');
    expect(create).not.toHaveBeenCalled();
  });
  it('runs a program and streams its output', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    expect(await run(hello())).toEqual({ code: 0, out: 'hi\n', err: '' });
  });

  it('kills a program that never returns, and the caller keeps running', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const t0 = Date.now();
    const r = await run(spin(), { deadlineMs: 300 });
    expect(r.code).toBe(EXIT_DEADLINE);
    expect(r.err).toMatch(/still running after 0\.3s, killed/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('does not kill a program that finishes before the deadline', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    expect((await run(hello(), { deadlineMs: 20000 })).code).toBe(0);
  });

  it('reports a trapping program as an error', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    await expect(run(trap())).rejects.toThrow(/unreachable/);
  });

  it('runs concurrently: a slow program does not block another', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const [a, b] = await Promise.all([run(spin(), { deadlineMs: 400 }), run(hello())]);
    expect(a.code).toBe(EXIT_DEADLINE);
    expect(b).toEqual({ code: 0, out: 'hi\n', err: '' });
  });
});

describe('execWasi without a Worker', () => {
  it('requires enforceable cancellation for normal command execution', async () => {
    setWasiWorkerFactory(null);
    await expect(run(hello())).rejects.toThrow(/requires a Worker/);
    expect(await run(hello(), {allowInThread:true, deadlineMs:Infinity})).toEqual({ code: 0, out: 'hi\n', err: '' });
  });

  it('does not execute in-thread after structured clone fails', async () => {
    const terminate = vi.fn();
    setWasiWorkerFactory(() => ({postMessage() {throw new Error('clone failed');}, onmessage:null, onerror:null, terminate}));
    await expect(run(hello())).rejects.toThrow('clone failed');
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('cancels a running Worker promptly without a deadline diagnostic', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const abort = new AbortController();
    const pending = run(spin(), {signal:abort.signal});
    setTimeout(() => abort.abort(), 100);
    expect(await pending).toEqual({code:130, out:'', err:''});
  });
});

describe('exec: keeping the program and the host filesystem in step', () => {
  // a tiny filesystem: path -> [content, mtime ms]; directories are the keys of `dirs`
  const files = new Map<string, [string, number]>([['/w/same', ['abc', 1000]], ['/w/edited', ['new content', 5000]], ['/w/fresh', ['made by the command', 7000]]]);
  const dirs = new Map<string, string[]>([['/w', ['same', 'edited', 'fresh']]]);
  const fs: any = {
    stat: async (p: string) => {
      const f = files.get(p);
      if (!f && dirs.has(p)) return {type:'dir',size:0,mtime:new Date(0)};
      if (!f) throw new Error('ENOENT');
      return { type: 'file', size: f[0].length, mtime: new Date(f[1]) };
    },
    lstat: async (p:string) => files.has(p) ? {type:'file',size:files.get(p)![0].length,mtime:new Date(files.get(p)![1])} : {type:'dir',size:0,mtime:new Date(0)},
    readFile: async (p: string) => new TextEncoder().encode(files.get(p)![0]),
    readdir: async (p: string) => { const d = dirs.get(p); if (!d) throw new Error('ENOENT'); return d; },
  };
  const rt = new WasiRT({ fs, cwd: '/w', args: [], env: {} });
  const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

  it('reports files that changed, appeared or disappeared among those the program has cached', async () => {
    const known: [string, number, number][] = [['/w/same', 3, 1000], ['/w/edited', 3, 1000], ['/w/removed', 5, 1000]];
    const u = await rt.computeUpdates(known, ['/w']);
    const byPath = Object.fromEntries(u.files.map(([p, d]) => [p, text(d)]));
    expect(byPath['/w/edited']).toBe('new content');         // size and mtime differ
    expect(byPath['/w/fresh']).toBe('made by the command');  // listed in a cached directory, not known yet
    expect(byPath['/w/removed']).toBeNull();                 // gone
    expect('/w/same' in byPath).toBe(false);                 // untouched: nothing to send
    expect(u.dirs).toEqual([['/w', ['same', 'edited', 'fresh']]]);
  });

  it('sends nothing when nothing changed', async () => {
    const u = await rt.computeUpdates([['/w/same', 3, 1000], ['/w/edited', 11, 5000], ['/w/fresh', 19, 7000]], ['/w']);
    expect(u.files).toEqual([]);
  });
});


describe('complete WASI filesystem snapshots', () => {
  const stat = (type:string, size=0) => ({type,size,mtime:new Date(0)});
  const filesystem = () => ({
    readdir: async (p:string) => p === '/' ? ['outside','w'] : p === '/w' ? [...Array.from({length:105},(_,i)=>String(i)),'deep'] : p === '/w/deep' ? ['a'] : p === '/w/deep/a' ? ['b'] : p === '/w/deep/a/b' ? ['c'] : p === '/w/deep/a/b/c' ? ['last'] : [],
    stat: async (p:string) => stat(['/','/w','/w/deep','/w/deep/a','/w/deep/a/b','/w/deep/a/b/c'].includes(p) ? 'dir' : 'file',1),
    lstat: async (p:string) => stat(['/w','/w/deep','/w/deep/a','/w/deep/a/b','/w/deep/a/b/c'].includes(p) ? 'dir' : 'file',1),
    readFile: async () => new Uint8Array([0xff]),
  });
  it('includes paths outside cwd, deep trees, and more than 100 files', async () => {
    const rt = new WasiRT({fs:filesystem() as any, cwd:'/w',args:[],env:{}});
    await rt.preloadTree('/');
    const files = new Map(rt.exportJob().files.map(([p,data]) => [p,data]));
    expect(files.get('/outside')).toEqual(new Uint8Array([0xff]));
    expect(files.get('/w/104')).toEqual(new Uint8Array([0xff]));
    expect(files.get('/w/deep/a/b/c/last')).toEqual(new Uint8Array([0xff]));
  });
  it('fails explicitly on resource bounds and inaccessible files', async () => {
    const fs = filesystem();
    const rt = new WasiRT({fs:fs as any, cwd:'/w',args:[],env:{}});
    await expect(rt.preloadTree('/',Infinity,100)).rejects.toThrow(/limit/);
    await expect(rt.preloadTree('/',1)).rejects.toThrow(/depth limit/);
    fs.readFile = async () => {throw new Error('EACCES');};
    const denied = new WasiRT({fs:fs as any,cwd:'/w',args:[],env:{}});
    await expect(denied.preloadTree('/')).rejects.toThrow('EACCES');
  });
  it('keeps package resources private, immutable and out of workspace updates', async () => {
    const fs = filesystem();
    const rt = new WasiRT({fs:fs as any,cwd:'/w',args:[],env:{},resources:[['/usr/share/data',new Uint8Array([42])]],commands:['cat']});
    await rt.preloadTree('/'); rt.mountPackageResources(); rt.installVirtualCommands();
    const job = rt.exportJob();
    expect(job.resourcePaths).toContain('/usr/share/data');
    expect(job.virtualCommandPaths).toContain('/usr/bin/cat');
    const worker:any = WasiRT.fromJob(job,{});
    const update = await rt.computeUpdates(job.files.filter(([p,s]) => !job.resourcePaths!.includes(p) && !job.virtualCommandPaths!.includes(p)).filter(([, ,st])=>st.type==='file').map(([p,,st])=>[p,st.size,st.mtime]),job.dirs.map(([p])=>p));
    expect(update.files.some(([p])=>p === '/usr/share/data' || p === '/usr/bin/cat')).toBe(false);
    worker.applyUpdates(update); worker.installVirtualCommands();
    expect(worker.realFiles.has('/usr/bin/cat')).toBe(false);
    expect(worker.setTimes('/usr/share/data',0n,0n,5)).toBe(2);
    const other = new WasiRT({fs:fs as any,cwd:'/w',args:[],env:{}});
    await other.preloadTree('/');
    expect(other.exportJob().files.some(([p])=>p === '/usr/share/data')).toBe(false);
  });

  it('applies an ordered write/rename/delete journal and surfaces persistence errors', async () => {
    const state = new Map<string,Uint8Array>();
    const fs:any = {
      stat:async(p:string)=> { if (p === '/') return {type:'dir',size:0,mtime:new Date(0)}; if (!state.has(p)) throw Object.assign(new Error('ENOENT'),{code:'ENOENT'}); return {type:'file',size:state.get(p)!.length,mtime:new Date(0)}; },
      lstat:async(p:string)=>fs.stat(p), readdir:async()=>[...state.keys()].map(p=>p.slice(1)),readFile:async(p:string)=>state.get(p)!,
      writeFile:async(p:string,data:Uint8Array)=>{state.set(p,data);},rename:async(a:string,b:string)=>{if(!state.has(a)) throw new Error('ENOENT'); state.set(b,state.get(a)!);state.delete(a);},unlink:async(p:string)=>{state.delete(p);}
    };
    const rt = new WasiRT({fs,cwd:'/',args:[],env:{}});
    await rt.preloadTree('/');
    await rt.applyWrites({closedDirty:[],deferredOps:[{type:'write',path:'/a',data:new Uint8Array([1])},{type:'rename',oldPath:'/a',newPath:'/b'},{type:'write',path:'/a',data:new Uint8Array([2])},{type:'delete',path:'/b'}]});
    expect([...state]).toEqual([['/a',new Uint8Array([2])]]);
    fs.writeFile = async()=>{throw new Error('quota exceeded');};
    await expect(rt.applyWrites({closedDirty:[{path:'/a',data:new Uint8Array()}],deferredOps:[]})).rejects.toThrow('quota exceeded');
  });

  it('rejects a stale filesystem commit before writing any files', async () => {
    const data = new Map([['/a',new Uint8Array([1])],['/b',new Uint8Array([2])]]);
    const fs:any = {
      stat:async(p:string)=>({type:p==='/'?'dir':'file',size:data.get(p)?.length ?? 0,mtime:new Date(0)}),
      lstat:async(p:string)=>fs.stat(p),readdir:async()=>['a','b'],readFile:async(p:string)=>data.get(p)!,
      writeFile:vi.fn(async(p:string,b:Uint8Array)=>{data.set(p,b);}),
    };
    const rt = new WasiRT({fs,cwd:'/',args:[],env:{}});
    await rt.preloadTree('/');
    data.get('/b')![0] = 3; // even an edit with unchanged size/mtime must be detected
    await expect(rt.applyWrites({closedDirty:[],deferredOps:[{type:'write',path:'/a',data:new Uint8Array([4])},{type:'write',path:'/b',data:new Uint8Array([5])}]})).rejects.toThrow('/b');
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect([...data.get('/a')!]).toEqual([1]);
  });
});
