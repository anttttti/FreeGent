import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {setChatHistory,getChatHistory,chatSession} from '../../chat-history.ts';
import {recordToolFormat} from '../../model-caps.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts')});
it.each(['openai','fn-tag'] as const)('%s request retains executed command identity',async format=>{
 localStorage.clear();W.mainAgentRole=null;W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());W.setActiveChatId('own-history-projection');
 const model='own-history-model',ep={provider:'openrouter',model,url:'http://own-fixture.invalid/v1/chat/completions',key:'own-synthetic-key'};localStorage.setItem('fg_main_models',JSON.stringify(['openrouter|'+model]));localStorage.setItem('fg_openrouter_key','own-synthetic-key');recordToolFormat('openrouter',model,format);
 const cases:any[]=[];
 for(const side of ['ALPHA','BETA']){
  const command='cat OWN_PATH_'+side+'.txt',history=[{role:'user',content:'Read the selected input and then continue.'},{role:'assistant',content:null,tool_calls:[{id:'own-call',type:'function',function:{name:'execute_code',arguments:JSON.stringify({language:'bash',code:command})}}]},{role:'tool',tool_call_id:'own-call',name:'execute_code',content:JSON.stringify({stdout:'OWN_SAME_RESULT',stderr:'',exit_code:0})}];setChatHistory(history);
  let request:any;W.fetch=vi.fn(async(_url:any,init:any)=>{request=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Own continuation.'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
  await W.callOAI(()=>{},()=>{},{endpointOverride:ep,evtSession:{_session:chatSession(),_evtTurn:0}});
  cases.push({side,command,history,request,stored:getChatHistory()});
 }
 observations.push({format,cases,requestsDistinct:JSON.stringify(cases[0].request.messages)!==JSON.stringify(cases[1].request.messages)});
 for(const c of cases){expect(JSON.stringify(c.stored)).toContain(c.command);expect(JSON.stringify(c.request.messages)).toContain(c.command)}expect(cases[0].request.messages).not.toEqual(cases[1].request.messages);
});
