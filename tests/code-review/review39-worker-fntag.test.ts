import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {recordToolFormat} from '../../model-caps.ts';
import {NULL_TASK_HANDLE} from '../../render-adapter.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
it.each(['openai','fn-tag'] as const)('worker %s applies its endpoint history representation',async format=>{
 localStorage.clear();W.mainAgentRole=null;W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());W.setActivePlaceholder(null);
 const model='own-worker-history-'+format,spec='openrouter|'+model;localStorage.setItem('fg_main_models',JSON.stringify([spec]));localStorage.setItem('fg_openrouter_key','own-synthetic-key');recordToolFormat('openrouter',model,format);
 const requests:any[]=[];W.fetch=vi.fn(async(_url:any,init:any)=>{const body=JSON.parse(init.body);requests.push(body);const message=requests.length===1?{role:'assistant',content:'<function=list_files>{}</function>'}:{role:'assistant',content:'Own listing completed.\nSTATUS: complete'};return new Response(JSON.stringify({choices:[{message,finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}}),{headers:{'content-type':'application/json'}})});
 const result=await W.runWorkerTurn('List the own snapshot files and report.',{snapshot:new Map([['own.txt','OWN_TEXT']]),staging:new Map(),depth:0},NULL_TASK_HANDLE,spec,W.rolesRegistry.get('coder'),null);
 const second=requests[1]?.messages,native=second?.some((m:any)=>m.role==='tool'||m.tool_calls?.length),tagged=second?.some((m:any)=>m.role==='user'&&String(m.content).includes('<tool_response>'));
 observations.push({format,requests,result,native,tagged,learned:W.getModelToolFormat('openrouter',model)});expect(requests).toHaveLength(2);expect(result.toolCalls).toHaveLength(1);expect(result.toolCalls[0].name).toBe('list_files');expect(W.getModelToolFormat('openrouter',model)).toBe(format);expect(native).toBe(format==='openai');expect(tagged).toBe(format==='fn-tag');
});
