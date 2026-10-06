import { createContext,runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transpileModule,ScriptTarget,ModuleKind } from 'typescript';
const source=readFileSync(resolve(__dirname,'../polyfills.ts'),'utf8').replace('export {};','');
const code=transpileModule(source,{compilerOptions:{target:ScriptTarget.ES2019,module:ModuleKind.None}}).outputText;
function realm(){
    const timers:Function[]=[];
    const context=createContext({DOMException,setTimeout:(fn:Function)=>{timers.push(fn);return timers.length;},clearTimeout(){}});
    runInContext(`self=this;globalThis=undefined;
        delete Object.fromEntries;delete Promise.allSettled;delete String.prototype.matchAll;delete RegExp.prototype[Symbol.matchAll];
        class Signal{constructor(){this.aborted=false;this.listeners=new Set();}addEventListener(n,f){this.listeners.add(f);}removeEventListener(n,f){this.listeners.delete(f);}}
        class Controller{constructor(){this.signal=new Signal();}abort(){if(!this.signal.aborted){this.signal.aborted=true;for(const f of Array.from(this.signal.listeners))f();}}}
        AbortSignal=Signal;AbortController=Controller;
    `,context);
    runInContext(code,context);
    return {context,timers};
}
describe('legacy collection and cancellation semantics',()=>{
    it('supports iterable allSettled and safe __proto__ keys',async()=>{
        const {context}=realm();
        expect(await runInContext(`Promise.allSettled(new Set([Promise.resolve(1),Promise.reject('bad')]))`,context)).toEqual([{status:'fulfilled',value:1},{status:'rejected',reason:'bad'}]);
        expect(runInContext(`Object.getPrototypeOf(Object.fromEntries([['__proto__',{polluted:true}]]))===Object.prototype`,context)).toBe(true);
        expect(runInContext(`Object.hasOwn(Object.fromEntries([['__proto__',1]]),'__proto__')`,context)).toBe(true);
    });
    it('preserves matchAll lastIndex and advances Unicode empty matches',()=>{
        const {context}=realm();
        expect(runInContext(`const r=/a/g;r.lastIndex=1;Array.from('aa'.matchAll(r),m=>m.index)`,context)).toEqual([1]);
        expect(runInContext(`Array.from('😀'.matchAll(/(?:)/gu),m=>m.index)`,context)).toEqual([0,2]);
        expect(()=>runInContext(`'a'.matchAll(/a/)`,context)).toThrow();
    });
    it('preserves timeout reasons on controllers that ignore abort(reason)',()=>{
        const {context,timers}=realm();
        runInContext('timeout=AbortSignal.timeout(5)',context);timers[0]();
        expect(runInContext('timeout.reason.name',context)).toBe('TimeoutError');
    });
    it('cleans combined signal listeners and preserves the first abort reason',()=>{
        const {context}=realm();
        runInContext(`a=new AbortController();b=new AbortController();combined=AbortSignal.any(new Set([a.signal,b.signal]));a.abort('first');b.abort('second');`,context);
        expect(runInContext('combined.reason',context)).toBe('first');
        expect(runInContext('a.signal.listeners.size+b.signal.listeners.size',context)).toBe(0);
    });
});
