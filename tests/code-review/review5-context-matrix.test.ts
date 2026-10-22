import {beforeAll,afterAll,it,expect} from 'vitest';
import {getContextThreshold,getOAIContextTokens} from '../../config.ts';
import {oaiEndpoint} from '../../model-router.ts';
import {makeReplayFetch} from '../../tests/replay-harness.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts')});
it.each([{name:'catalog8-global50-thinkingOff',provider:'custom',catalogK:8,global:50000,thinking:'off'},{name:'catalog8-global8-thinkingOff-control',provider:'custom',catalogK:8,global:8000,thinking:'off'},{name:'vllm8-global8-thinkingHigh',provider:'vllm',catalogK:8,global:8000,thinking:'high'}])('$name output cap fits the selected catalog context',async c=>{
 localStorage.clear();W.mainAgentRole=null;const model='own-context-'+c.name;
 localStorage.setItem('fg_custom_models',JSON.stringify([{provider:c.provider,model,label:'Own context probe',contextK:c.catalogK,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));localStorage.setItem('fg_main_models',JSON.stringify([c.provider+'|'+model]));localStorage.setItem('fg_openai_context',String(c.global));localStorage.setItem('fg_thinking_level',c.thinking);
 W.setActiveAbortController?.(new AbortController());W.fetch=makeReplayFetch([{content:'OWN_CONTEXT_RECEIPT'}]);let payload:any;const ep=oaiEndpoint();await W.callOAI(()=>{},(p:any)=>payload=p,{endpointOverride:ep,localHistory:[{role:'user',content:'OWN_SMALL_CONTEXT_REQUEST'}]});
 const o={case:c.name,provider:c.provider,catalogThreshold:getContextThreshold(),globalContext:getOAIContextTokens(),maxTokens:payload.max_tokens,thinkingBudget:payload.thinking_token_budget??null,thinkingFields:payload.chat_template_kwargs??null,promptCharacters:JSON.stringify(payload.messages).length,thinkingBudgetExceedsEntireOutput:(payload.thinking_token_budget??0)>=payload.max_tokens};observations.push(o);
 expect(payload.max_tokens).toBeGreaterThan(0);expect(payload.max_tokens).toBeLessThan(o.catalogThreshold);
});
