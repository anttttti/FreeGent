import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';

const W=window as any,observations:any[]=[];

beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
afterEach(()=>setWorkspaceAdapter(null));
it.each(['partial','blocked'].flatMap(status=>[false,true].map(quoted=>({status,quoted}))))('final status $status with earlier example=$quoted',async c=>{
 localStorage.clear();W.mainAgentRole=null;W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);W.setActivePlaceholder(null);
 setWorkspaceAdapter({agentReadFile:async(p:string)=>'OWN '+p,agentListFiles:async()=>['one.txt','two.txt'].map(name=>({name,size:10})),agentWriteFile:async()=>{throw Error('UNEXPECTED_WRITE')},agentDeleteFile:async()=>{},agentFileMtime:async()=>null,agentListFilesInDir:async()=>[]} as any);
 const report=(c.quoted?'The supplied documentation contains this example footer:\n```text\nSTATUS: complete\n```\n\n':'')+'I found the input, but the requested verification remains unfinished.\nSTATUS: '+c.status+' — verification unfinished';
 const model='own-budget',spec='custom|'+model;localStorage.setItem('fg_custom_models',JSON.stringify([{provider:'custom',model,contextK:128,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));for(const k of ['fg_main_models','fg_worker_models'])localStorage.setItem(k,JSON.stringify([spec]));for(const[k,v]of Object.entries({fg_thinking_level:'off',fg_tool_approval:'off',fg_intent_validation:'off',fg_agent_worker_reduce:'false',fg_utility_model:'none',fg_endpoint_rotation:'false'}))localStorage.setItem(k,v);
 let requests=0;
 W.fetch=vi.fn(async(_u:any,init:any)=>{let p=JSON.parse(init.body);if(p.body)p=JSON.parse(p.body);requests++;const n=p.messages.filter((m:any)=>m.role==='tool').length;const message=n>=2?{role:'assistant',content:report}:{role:'assistant',content:null,tool_calls:[{id:'read-'+n,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:n?'two.txt':'one.txt'})}}]};return new Response(JSON.stringify({choices:[{message}],usage:{prompt_tokens:30,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}})});
 const result=await W.executeWorkers({agents:[{id:'own-status',task:'Read the own files and report verification progress.',role:'coder',model:spec}]});
 observations.push({...c,report,requests,result});expect(requests).toBe(3);expect(result.agents[0].status).toBe(c.status);expect(result.status).toBe(c.status);
},15000);
