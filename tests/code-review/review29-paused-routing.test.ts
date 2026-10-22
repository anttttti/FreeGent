import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {NULL_TASK_HANDLE} from '../../render-adapter.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts')});
it.each([false,true].flatMap(paused=>['main','auxiliary'].map(caller=>({paused,caller}))))('$caller with only configured model paused=$paused',async c=>{
 localStorage.clear();W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());W.setActivePlaceholder(null);W.mainAgentRole=null;
 const model='own-routing-model',spec='custom|'+model;localStorage.setItem('fg_custom_models',JSON.stringify([{provider:'custom',model,contextK:128,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));localStorage.setItem('fg_main_models',JSON.stringify([spec]));localStorage.setItem('fg_paused_main',JSON.stringify(c.paused?[spec]:[]));localStorage.setItem('fg_thinking_level','off');
 const configured=W.getMainModelList(),active=W.getActiveMainModelList();expect(configured).toEqual([spec]);expect(active).toEqual(c.paused?[]:[spec]);
 const requests:any[]=[];W.fetch=vi.fn(async(url:any,init:any)=>{let body=JSON.parse(init.body);const target=body.url??String(url);if(body.body)body=JSON.parse(body.body);requests.push({url:target,transportUrl:String(url),body});return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'OWN_ROUTED_RESPONSE'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
 let result:any,error:any;try{result=c.caller==='main'?await W.callOAI(()=>{},()=>{},{localHistory:[{role:'user',content:'Own routing fixture.'}]}):await W.callLLMComplete('Own routing fixture.',{maxAttempts:1},NULL_TASK_HANDLE)}catch(e:any){error=e.message}
 observations.push({...c,configured,active,requests,result,error});if(c.paused){expect(requests).toHaveLength(0);expect(error).toMatch(/No model can be used/)}else{expect(error).toBeUndefined();expect(requests).toHaveLength(1);expect(requests[0].body.model).toBe(model);expect(requests[0].url).toContain('own-fixture.invalid')}
});
