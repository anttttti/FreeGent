import {it,beforeAll,expect} from 'vitest';
import {oaiEndpoint} from '../../model-router.ts';
import {makeReplayFetch} from '../../tests/replay-harness.ts';
const W=window as any;
beforeAll(async()=>{await import('../../llm-loops.ts')});
it('NVIDIA thinking survives an explicit endpoint for the same configured model',async()=>{
 localStorage.clear();W.mainAgentRole=null;
 const model=W.getAllModels().find((m:any)=>m.provider==='nvidia'&&m.thinking)!;
 localStorage.setItem('fg_main_models',JSON.stringify(['nvidia|'+model.model]));localStorage.setItem('fg_nvidia_key','own-synthetic-key');localStorage.setItem('fg_thinking_level','low');
 W.setActiveAbortController?.(new AbortController());
 const bodies:any[]=[];W.fetch=makeReplayFetch([{content:'OWN_CONTROL_RESPONSE'},{content:'OWN_EXPLICIT_RESPONSE'}],{});
 const ep=oaiEndpoint();await W.callOAI(()=>{},(p:any)=>bodies.push(p),{localHistory:[{role:'user',content:'OWN_PAYLOAD_REVIEW'}]});await W.callOAI(()=>{},(p:any)=>bodies.push(p),{localHistory:[{role:'user',content:'OWN_PAYLOAD_REVIEW'}],endpointOverride:ep});
 const observations={model:model.model,provider:ep.provider,implicit:bodies[0],explicit:bodies[1]};
 expect(bodies[0].reasoning_budget).toBe(4096);expect(bodies[1].reasoning_budget).toBe(bodies[0].reasoning_budget);expect(bodies[1].chat_template_kwargs).toEqual(bodies[0].chat_template_kwargs);
});
