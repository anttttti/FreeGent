import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';
import {resetWorkerBudget,_addWorkerUsage,workerStepsUsed,workerInputUsed} from '../../workers.ts';
const W=window as any,observations:any[]=[];
const originalNative=W.nativeExec;
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
afterEach(()=>{setWorkspaceAdapter(null);resetWorkerBudget();W.setWorkflowMode(false);W.nativeExec=originalNative;delete process.env.FREEGENT_WORKER_STEP_LIMIT;delete process.env.FREEGENT_WORKER_INPUT_TOKEN_LIMIT});
it.each([{autonomous:true,workers:1,spent:0},{autonomous:true,workers:2,spent:0},{autonomous:true,workers:1,spent:1},{autonomous:false,workers:1,spent:1}])('budget admission $autonomous / $workers workers / spent $spent',async c=>{
 localStorage.clear();resetWorkerBudget();_addWorkerUsage(c.spent,0);process.env.FREEGENT_WORKER_STEP_LIMIT='1';process.env.FREEGENT_WORKER_INPUT_TOKEN_LIMIT='40';W.nativeExec=vi.fn(()=>{throw Error('UNEXPECTED_NATIVE_EXEC')});W.setWorkflowMode(c.autonomous);W.mainAgentRole=null;W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);W.setActivePlaceholder(null);
 setWorkspaceAdapter({agentReadFile:async(p:string)=>'OWN '+p,agentListFiles:async()=>['one.txt','two.txt'].map(name=>({name,size:10})),agentWriteFile:async()=>{throw Error('UNEXPECTED_WRITE')},agentDeleteFile:async()=>{},agentFileMtime:async()=>null,agentListFilesInDir:async()=>[]} as any);
 const model='own-budget',spec='custom|'+model;localStorage.setItem('fg_custom_models',JSON.stringify([{provider:'custom',model,contextK:128,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));for(const k of ['fg_main_models','fg_worker_models'])localStorage.setItem(k,JSON.stringify([spec]));for(const[k,v]of Object.entries({fg_thinking_level:'off',fg_tool_approval:'off',fg_intent_validation:'off',fg_agent_worker_reduce:'false',fg_utility_model:'none',fg_endpoint_rotation:'false'}))localStorage.setItem(k,v);
 let requests=0;
 W.fetch=vi.fn(async(_u:any,init:any)=>{let p=JSON.parse(init.body);if(p.body)p=JSON.parse(p.body);requests++;const n=p.messages.filter((m:any)=>m.role==='tool').length;const message=n>=2?{role:'assistant',content:'Own two reads finished.\nSTATUS: complete'}:{role:'assistant',content:null,tool_calls:[{id:'read-'+n,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:n?'two.txt':'one.txt'})}}]};return new Response(JSON.stringify({choices:[{message}],usage:{prompt_tokens:30,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}})});
 const result=await W.executeWorkers({agents:Array.from({length:c.workers},(_,i)=>({id:'worker'+i,task:'Read the own two files and report.',role:'coder',model:spec}))});
 const used={steps:workerStepsUsed(),inputTokens:workerInputUsed()};observations.push({...c,configured:{steps:1,inputTokens:40},requests,used,result});
 // Characterize the implemented admission-only contract; these are observations, not hard-cap assertions.
 if(c.autonomous&&c.spent){expect(requests).toBe(0);expect(result.error).toContain('Nothing was started')}else{expect(requests).toBe(c.workers*3);expect(result.status).toBe('complete');expect(used.steps).toBe(c.spent+c.workers*3);expect(used.inputTokens).toBe(c.workers*90)}
},15000);
