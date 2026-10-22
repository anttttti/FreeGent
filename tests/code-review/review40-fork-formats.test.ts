import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {recordToolFormat} from '../../model-caps.ts';
import {NULL_TASK_HANDLE} from '../../render-adapter.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
it.each(['openai','fn-tag'].flatMap(parent=>['openai','fn-tag'].map(child=>({parent,child}))))('fork $parent parent to $child worker describes the worker endpoint',async c=>{
 localStorage.clear();W.mainAgentRole=null;W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());W.setActivePlaceholder(null);localStorage.setItem('fg_agent_worker_history','true');
 const parentModel='own-parent-'+c.parent+'-'+c.child,childModel='own-child-'+c.parent+'-'+c.child;localStorage.setItem('fg_main_models',JSON.stringify(['openrouter|'+parentModel]));localStorage.setItem('fg_openrouter_key','own-synthetic-key');recordToolFormat('openrouter',parentModel,c.parent as any);recordToolFormat('openrouter',childModel,c.child as any);
 const requests:any[]=[];W.fetch=vi.fn(async(url:any,init:any)=>{requests.push({url:String(url),payload:JSON.parse(init.body)});return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Own response.\nSTATUS: complete'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
 await W.callOAI(()=>{},()=>{},{endpointOverride:{provider:'openrouter',model:parentModel,url:'http://own-fixture.invalid/v1/chat/completions',key:'own-synthetic-key'},localHistory:[{role:'user',content:'Own parent request.'}]});
 const base=W.getLastMainRequest();const result=await W.runWorkerTurn('Report the own inherited request.',{snapshot:new Map(),staging:new Map(),depth:0},NULL_TASK_HANDLE,'openrouter|'+childModel,W.rolesRegistry.get('director'),base);
 const parentPrompt=requests[0].payload.messages[0].content,childPrompt=requests[1].payload.messages[0].content,note='## Tool-call format (this endpoint)';
 observations.push({...c,requests,result,parentNote:parentPrompt.includes(note),childNote:childPrompt.includes(note),prefixEqual:parentPrompt===childPrompt});expect(requests).toHaveLength(2);expect(requests[1].payload.model).toBe(childModel);expect(parentPrompt.includes(note)).toBe(c.parent==='fn-tag');expect(childPrompt.includes(note)).toBe(c.child==='fn-tag');
});
