// exec-sandbox/tools.ts — processing programs loaded on demand: pinned files from a CDN, verified by SHA-256 before anything runs.
//
// One catalog, used by the JavaScript runner (`tool('duckdb')`) and the shell commands (ffmpeg, duckdb, tesseract). A file is downloaded
// once per run (the browser's HTTP cache keeps a pinned version for a year: jsDelivr sends `immutable`), checked against its pin, and
// only then evaluated or instantiated. The frame has no IndexedDB and no cross-origin isolation, so only single-thread builds are listed.
// Licences are the programs' own; each one is fetched from its publisher at run time, not copied into FreeGent.

import { verifyArtifact } from '../shiro/wasi-packages';
import { TOOLS, type ToolFile, type ToolEntry } from './tool-pins';
export { TOOLS };

const bytesMemo = new Map<string, Promise<ArrayBuffer>>();
/** The verified bytes of one catalog file (downloaded once per run; the SHA-256 and length must match the pin). */
export function toolBytes(file: ToolFile): Promise<ArrayBuffer> {
  let p = bytesMemo.get(file.sha256);
  if (!p) {
    p = (async () => {
      const r = await fetch(file.url);
      if (!r.ok) throw new Error(`failed to download ${file.url}: HTTP ${r.status}`);
      const raw = await r.arrayBuffer();
      await verifyArtifact(raw, file);
      return raw;
    })();
    p.catch(() => bytesMemo.delete(file.sha256));
    bytesMemo.set(file.sha256, p);
  }
  return p;
}
const toolText = async (file: ToolFile) => new TextDecoder().decode(await toolBytes(file));
const entry = (name: string): ToolEntry => { const e = TOOLS[name]; if (!e) throw new Error(`unknown tool "${name}"; available: ${Object.keys(TOOLS).join(', ')}`); return e; };
const blobUrl = (data: BlobPart, type: string) => URL.createObjectURL(new Blob([data], { type }));

/** Evaluates a verified UMD script as a CommonJS module and returns its exports. */
function umd(source: string, req?: (name: string) => any): any {
  const module: { exports: any } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'define', 'require', source).call(globalThis, module, module.exports, undefined, req);
  return module.exports;
}

// ── sql.js, DuckDB, Tesseract, ffmpeg: a small API each ───────────────────────────────────────────────────────────────

async function sqlJs(): Promise<any> {
  const e = entry('sql.js');
  const init = umd(await toolText(e.files.js));
  const wasmBinary = new Uint8Array(await toolBytes(e.files.wasm));
  return init({ wasmBinary });   // the SQL namespace: new SQL.Database(bytes?)
}

type Files = Record<string, Uint8Array>;
const jsonSafe = (v: any): any => {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && typeof v.toJSON === 'function') {   // DECIMAL and HUGEINT arrive as typed arrays whose toJSON is the quoted number
    const j = v.toJSON();
    const t = typeof j === 'string' ? j.replace(/^"(.*)"$/, '$1') : j;
    return typeof t === 'string' && /^-?\d+(\.\d+)?$/.test(t) && Number.isSafeInteger(Math.trunc(Number(t))) ? Number(t) : t;
  }
  return v;
};

/** A new DuckDB (its own Worker and empty database); `close()` ends it. `tool("duckdb")` shares one per run, the shell command opens one per command. */
export async function openDuckdb(): Promise<any> {
  if (typeof Worker !== 'function') throw new Error('duckdb needs a browser with Workers');
  const e = entry('duckdb');
  // In its own Worker (the blocking build traps on COPY … TO when it runs on a frame's main thread). Its one external, Arrow, is the second verified file.
  const boot = `let db,conn,lib;const ext={};const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return xo.call(this,m,ext[u]||u,...r)};const jsonSafe=${jsonSafe.toString()};
const umd=(source,req)=>{const module={exports:{}};new Function('module','exports','define','require',source).call(self,module,module.exports,undefined,req);return module.exports};
onmessage=async({data})=>{const {id,op}=data;try{let out,tr=[];
 if(op==='init'){const arrow=umd(data.arrow);lib=umd(data.js,n=>{if(n==='apache-arrow')return arrow;throw new Error('duckdb asked for '+n)});
  const mainModule=URL.createObjectURL(new Blob([data.wasm],{type:'application/wasm'}));
  db=await lib.createDuckDB({mvp:{mainModule,mainWorker:''},eh:{mainModule,mainWorker:''}},new lib.VoidLogger(),lib.BROWSER_RUNTIME);await db.instantiate(()=>{});db.open({allowUnsignedExtensions:true});conn=db.connect();
  // DuckDB never fetches an extension itself: the page downloads the pinned file, checks it and registers it (op ext).
  conn.query("SET autoinstall_known_extensions=false");conn.query("SET autoload_known_extensions=false")}
 else if(op==='ext'){const key='https://extension.invalid/'+data.name;ext[key]=URL.createObjectURL(new Blob([data.bytes],{type:'application/wasm'}));conn.query("LOAD '"+key+"'")}
 else if(op==='query'){const t=conn.query(data.sql),names=t.schema.fields.map(x=>x.name);out=t.toArray().map(row=>Object.fromEntries(names.map(n=>[n,jsonSafe(row[n])])))}
 else if(op==='register'){try{db.dropFile(data.name)}catch{}db.registerFileBuffer(data.name,data.bytes)}
 else if(op==='read'){out=db.copyFileToBuffer(data.name);tr=[out.buffer]}
 postMessage({id,out},tr)}catch(err){postMessage({id,error:String(err&&err.message||err)})}};`;
  const url = blobUrl(boot, 'text/javascript');
  const worker = new Worker(url);
  let n = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  worker.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); if (p) data.error ? p.rej(new Error(data.error)) : p.res(data.out); };
  worker.onerror = ev => { for (const p of pending.values()) p.rej(new Error(String(ev.message || 'duckdb worker error'))); pending.clear(); };
  const loaded = new Map<string, Promise<void>>();
  const rpc = (msg: Record<string, any>, transfer: Transferable[] = []): Promise<any> =>
    new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); worker.postMessage({ id, ...msg }, transfer); });
  const wasm = await toolBytes(e.files.wasm);
  const copy = wasm.slice(0);
  await rpc({ op: 'init', arrow: await toolText(e.files.arrow), js: await toolText(e.files.js), wasm: copy }, [copy]);
  return {
    /** Runs one statement; rows come back as plain objects (BigInt as number, or a string when it does not fit). */
    async query(sql: string): Promise<Record<string, any>[]> {
      // One load per extension, awaited by every query that needs it; a failed load is dropped so the next query tries again.
      await Promise.all(['parquet', 'json'].filter(ext => new RegExp(ext, 'i').test(sql)).map(ext => {
        let p = loaded.get(ext);
        if (!p) {
          p = (async () => { const b = (await toolBytes(e.files[ext])).slice(0); await rpc({ op: 'ext', name: `${ext}.duckdb_extension.wasm`, bytes: new Uint8Array(b) }, [b]); })();
          p.catch(() => loaded.delete(ext));
          loaded.set(ext, p);
        }
        return p;
      }));
      return rpc({ op: 'query', sql });
    },
    /** Makes bytes readable by name in SQL (read_csv('a.csv'), read_parquet('a.parquet')). */
    registerFile: (name: string, bytes: Uint8Array) => { const b = bytes.slice(); return rpc({ op: 'register', name, bytes: b }, [b.buffer]); },
    /** The bytes of a file the database wrote (COPY … TO 'out.parquet'). */
    readFile: (name: string): Promise<Uint8Array> => rpc({ op: 'read', name }),
    async close() { worker.terminate(); URL.revokeObjectURL(url); },
  };
}

async function tesseract(): Promise<any> {
  const e = entry('tesseract');
  const T = umd(await toolText(e.files.js));
  // The language file is the pinned one: the worker's fetch of "<langPath>/eng.traineddata.gz" is answered from a blob of the verified bytes.
  const engUrl = blobUrl(await toolBytes(e.files.eng), 'application/gzip');
  const workerPath = blobUrl(`const __f=self.fetch.bind(self);self.fetch=(u,...a)=>/\\/eng\\.traineddata\\.gz$/.test(String(u))?__f(${JSON.stringify(engUrl)}):__f(u,...a);`
    + await toolText(e.files.worker), 'text/javascript');
  // tesseract.js takes a path ending in "js" as the core file itself (anything else is a directory it appends a name to): the fragment says so.
  const corePath = blobUrl(await toolText(e.files.core), 'text/javascript') + '#tesseract-core-simd-lstm.wasm.js';
  return {
    /** Text of an image (PNG, JPEG, BMP, GIF, WebP bytes). English only: the one language file that is pinned. */
    async recognize(image: Uint8Array): Promise<{ text: string; confidence: number }> {
      const w = await T.createWorker('eng', 1, { workerPath, corePath, langPath: 'https://tessdata.invalid', workerBlobURL: false, cacheMethod: 'none' });
      try { const r = await w.recognize(image); return { text: r.data.text, confidence: r.data.confidence }; }
      finally { await w.terminate(); }
    },
  };
}

export interface FfmpegResult { code: number; files: Files; stdout: string; stderr: string }
/** One ffmpeg (or ffprobe) run in its own Worker: input files by name in, output files out. Single thread (the frame is not cross-origin isolated). */
export async function runFfmpeg(args: string[], files: Files, opts: { probe?: boolean } = {}): Promise<FfmpegResult> {
  if (typeof Worker !== 'function') throw new Error('ffmpeg needs a browser with Workers');
  const e = entry('ffmpeg');
  const coreJs = await toolText(e.files.js);
  const wasm = await toolBytes(e.files.wasm);
  const src = coreJs + `;self.onmessage=async({data})=>{const so=[],se=[];try{
    const m=await createFFmpegCore({wasmBinary:data.wasm,print:s=>so.push(s),printErr:s=>se.push(s)});
    const dirs=new Set();for(const n of Object.keys(data.files)){const parts=n.split('/');parts.pop();let p='';for(const d of parts){p+='/'+d;if(!dirs.has(p)){dirs.add(p);try{m.FS.mkdir(p)}catch{}}}m.FS.writeFile('/'+n,data.files[n]);}
    m.FS.chdir('/');
    const code=data.probe?m.ffprobe(...data.args):m.exec(...data.args);
    const out={},skip=new Set(['dev','proc','tmp','home','sys']);
    const walk=(dir)=>{for(const n of m.FS.readdir(dir)){if(n==='.'||n==='..')continue;const p=(dir==='/'?'':dir)+'/'+n;if(dir==='/'&&skip.has(n))continue;const st=m.FS.stat(p);if(m.FS.isDir(st.mode))walk(p);else{const b=m.FS.readFile(p);const rel=p.slice(1);const before=data.files[rel];if(!before||before.length!==b.length||before.some((x,i)=>x!==b[i]))out[rel]=b}}};
    walk('/');postMessage({code,files:out,stdout:so.join('\\n'),stderr:se.join('\\n')},Object.values(out).map(b=>b.buffer));
  }catch(err){postMessage({error:String(err&&err.message||err)+'\\n'+se.join('\\n')})}};`;
  const url = blobUrl(src, 'text/javascript');
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      // Some encoders never return in this build (JPEG without -strict unofficial, HEVC): the run ends with a message instead of the tool's own timeout.
      const timer = setTimeout(() => reject(new Error('ffmpeg did not finish in 50 s (this build hangs on some encoders: write JPEG with -strict unofficial or use PNG/WebP; HEVC and AV1 are not supported)')), 50_000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); data.error ? reject(new Error(data.error)) : resolve(data); };
      worker.onerror = ev => { clearTimeout(timer); reject(new Error(String(ev.message || 'ffmpeg worker error'))); };
      const copy = wasm.slice(0);
      // This ffprobe writes its report to the file named by -o (it does not print it).
      worker.postMessage({ wasm: copy, args: opts.probe && !args.includes('-o') ? [...args, '-o', '__probe.txt'] : args, files, probe: !!opts.probe }, [copy]);
    }).then((r: any) => {
      const report = r.files['__probe.txt'];
      if (report) { r.stdout = new TextDecoder().decode(report).replace(/\n$/, ''); delete r.files['__probe.txt']; r.code = 0; }   // it returns -1 even when it reported
      return r;
    });
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}

const memo = new Map<string, Promise<any>>();
/** A processing program by name: libraries return their API (pdf-lib, mammoth, xlsx, jszip, sql.js), the others a small object. */
export function loadTool(name: string): Promise<any> {
  let p = memo.get(name);
  if (!p) {
    p = (async () => {
      switch (name) {
        case 'pdf-lib': return umd(await toolText(entry(name).files.js));
        case 'mammoth': return umd(await toolText(entry(name).files.js));
        case 'xlsx':    return umd(await toolText(entry(name).files.js));
        case 'jszip':   return umd(await toolText(entry(name).files.js));
        case 'sql.js':  return sqlJs();
        case 'duckdb':  return openDuckdb();
        case 'tesseract': return tesseract();
        case 'ffmpeg':  return { run: (args: string[], files: Files = {}) => runFfmpeg(args, files), probe: (args: string[], files: Files = {}) => runFfmpeg(args, files, { probe: true }) };
        default: return entry(name);   // throws with the list
      }
    })();
    p.catch(() => memo.delete(name));
    memo.set(name, p);
  }
  return p;
}
