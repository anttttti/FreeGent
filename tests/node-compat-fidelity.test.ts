// Node behaviour that the node-compat layer got wrong (exploration round 6, notes/2026_11_19_v1.0_claudecode_exploration_round6.md, K044).
// Each case is a script run as `node -e` and the stdout and exit status real Node 22 gives; each gets a fresh shell and workspace.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell, resetShell } from '../shiro/shell-singleton';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

beforeEach(() => { files.clear(); resetShell(); });

// [name, script, Node's stdout, Node's exit status]
const CASES: [string, string, string, number][] = [
    ["path.join and normalize collapse . and ..",
     "console.log(require('path').join('a','..','b','c.txt'),require('path').join('/a/b','../c'),require('path').join('a','./b//c/'),require('path').normalize('a/b/../c/./d'),require('path').join('a/b','..','..','..','z'),JSON.stringify(require('path').join('')),require('path').join('a',''))",
     "b/c.txt /a/c a/b/c/ a/c/d ../z \".\" a\n",
     0],
    ["assert throws AssertionError with code, and throws() fails when nothing throws",
     "const a=require('assert');for(const f of [()=>a.strictEqual(1,2),()=>a.deepStrictEqual({a:1},{a:2}),()=>a.ok(0),()=>a.throws(()=>{}),()=>a.equal(1,2),()=>a.notStrictEqual(1,1),()=>a.rejects]) {try{f();console.log('no throw')}catch(e){console.log(e.name,e.code)}}\na.throws(()=>{throw new TypeError('x')},TypeError);a.throws(()=>{throw new Error('abc')},/abc/);a.deepStrictEqual({a:[1,{b:2}],m:new Map([[1,2]])},{m:new Map([[1,2]]),a:[1,{b:2}]});console.log('fine')",
     "AssertionError ERR_ASSERTION\nAssertionError ERR_ASSERTION\nAssertionError ERR_ASSERTION\nAssertionError ERR_ASSERTION\nAssertionError ERR_ASSERTION\nAssertionError ERR_ASSERTION\nno throw\nfine\n",
     0],
    ["assert: a hole is not a missing key, map keys match by structure, and assert.strict is strict (Codex review of e49098b)",
     "const a=require('assert');const t=f=>{try{f();return 'ok'}catch(e){return e.name}};console.log(t(()=>a.deepStrictEqual([],Array(1))),t(()=>a.deepStrictEqual(new Map([[{a:1},1]]),new Map([[{a:1},1]]))),t(()=>a.strict.equal(1,'1')),t(()=>a.strict.deepEqual([1],['1'])))",
     "AssertionError ok AssertionError AssertionError\n",
     0],
    ["assert: DataViews compare by their bytes (Codex review of e49098b)",
     "const a=require('assert');const t=f=>{try{f();return 'ok'}catch(e){return e.name}};const v=b=>new DataView(new Uint8Array(b).buffer);console.log(t(()=>a.deepStrictEqual(v([1,2,3]),v([9,9,9]))),t(()=>a.deepStrictEqual(v([1,2,3]),v([1,2,3]))))",
     "AssertionError ok\n",
     0],
    ["util.isDeepStrictEqual compares structure",
     "const u=require('util');console.log(u.isDeepStrictEqual({a:1,b:2},{b:2,a:1}),u.isDeepStrictEqual([undefined],[null]),u.isDeepStrictEqual(new Set([1,2]),new Set([2,1])),u.isDeepStrictEqual(new Date(0),new Date(0)),u.isDeepStrictEqual(1,'1'),u.isDeepStrictEqual(NaN,NaN))",
     "true false true true false true\n",
     0],
    ["util.format and util.inspect are Node's",
     "const u=require('util');console.log(u.format('%d %i %f %s %j %%',1.5,2.7,'3.5',{a:1},{b:2}));console.log(u.inspect({a:{b:{c:{d:1}}}},{depth:0}),u.inspect({a:{b:{c:{d:1}}}},{depth:null}),u.inspect('s'),u.inspect([1,[2,[3,[4]]]]))",
     "1.5 2 3.5 { a: 1 } {\"b\":2} %\n{ a: [Object] } {\n  a: { b: { c: { d: 1 } } }\n} 's' [ 1, [ 2, [ 3, [Array] ] ] ]\n",
     0],
    ["querystring keeps repeated keys",
     "const q=require('querystring');console.log(q.stringify({a:[1,2],b:'c d'}),JSON.stringify(q.parse('a=1&a=2&b=c+d&e')))",
     "a=1&a=2&b=c%20d {\"a\":[\"1\",\"2\"],\"b\":\"c d\",\"e\":\"\"}\n",
     0],
    ["EventEmitter.emit reports listeners, once fires once, 'error' without listener throws",
     "const E=require('events');const e=new E();e.once('x',v=>console.log('got',v));console.log(e.emit('x',1),e.emit('x',2),e.emit('nolisten'));try{e.emit('error',new Error('boom'))}catch(x){console.log('thrown',x.message)}",
     "got 1\ntrue false false\nthrown boom\n",
     0],
    ["process.on('exit') runs when the script ends, with process.exitCode",
     "process.on('exit',c=>console.log('exit',c));console.log('body');process.exitCode=3",
     "body\nexit 3\n",
     3],
    ["a timer's process.exit ends the run while top-level code awaits forever (review of dde5141)",
     "setTimeout(()=>{console.log('bye');process.exit(3)},10);(async()=>{await new Promise(()=>{})})()",
     "bye\n",
     3],
    ["a second timer started after the first one fired still runs",
     "const sleep=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{await sleep(5);console.log(1);await sleep(1);console.log(2)})()",
     "1\n2\n",
     0],
];

describe('node-compat fidelity', () => {
    for (const [name, script, expected, status] of CASES) {
        it(name, async () => {
            const sh = await getShell();
            await sh.exec("cat > t.js <<'JSEOF'\n" + script + "\nJSEOF");
            const r = await sh.exec('node t.js');
            expect(lf(r.stdout)).toBe(expected);
            expect(r.exitCode).toBe(status);
        }, 20000);
    }
});
