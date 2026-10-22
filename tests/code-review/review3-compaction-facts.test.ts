import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {NULL_RENDER_ADAPTER} from '../../render-adapter.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../llm-shared.ts')});
beforeEach(()=>{localStorage.clear();localStorage.setItem('fg_openai_context','60000');localStorage.setItem('fg_retry_mode','fixed');localStorage.setItem('fg_retry_fixed_ms','1');W.setActiveAbortController?.(new AbortController());});
it.each([{name:'successful-write-control',tool:'write_file',ok:true},{name:'failed-write',tool:'write_file',ok:false},{name:'failed-replace',tool:'replace_in_file',ok:false}])('$name authoritative facts reflect tool success',async c=>{
 const file='own-fact-'+c.name+'.txt',history:any[]=[{role:'user',content:'Review only this own synthetic receipt.'},{role:'assistant',content:null,tool_calls:[{id:'early-write',type:'function',function:{name:c.tool,arguments:JSON.stringify({path:file,content:'OWN_CONTENT',old_string:'missing',new_string:'new'})}}]},{role:'tool',tool_call_id:'early-write',name:c.tool,content:c.ok?JSON.stringify({ok:true}):'[TOOL ERROR: own synthetic write failed]\n'+JSON.stringify({error:'own synthetic write failed'})}];
 for(let i=0;i<8;i++)history.push({role:'assistant',content:null,tool_calls:[{id:'read'+i,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'own-control.txt'})}}]},{role:'tool',name:'read_file',tool_call_id:'read'+i,content:'OWN_CONTROL_BODY'});
 W.fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'<tool_call>{"name":"read_file"}</tool_call>'}}],usage:{}}),{status:200,headers:{'content-type':'application/json'}}));
 const s=W.createSession({workflowMode:true}),out=await W.compactHistory(NULL_RENDER_ADAPTER,{provider:'vllm',url:'http://own-fixture.invalid/v1/chat/completions',model:'own',key:''},s,history,{system:'OWN_SYSTEM',tools:null});
 const summary=String(out[1]?.content??''),facts=summary.split('[Harness facts — authoritative]')[1]??'',listed=facts.includes('Files written this session: '+file),earlyErrorRetained=out.slice(2).some((m:any)=>String(m.content).includes('own synthetic write failed'));
 observations.push({case:c.name,tool:c.tool,ok:c.ok,file,listedAsWritten:listed,earlyErrorRetained,summary,tail:out.slice(2),requests:W.fetch.mock.calls.length});
 expect(listed).toBe(c.ok);
});
