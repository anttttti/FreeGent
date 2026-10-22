import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {enabledTools} from '../../config.ts';
import {setWorkspaceAdapter} from '../../workspace.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
afterEach(()=>setWorkspaceAdapter(null));
it.each([false,true].flatMap(duplicate=>[false,true].map(shared=>({duplicate,shared}))))('duplicate=$duplicate shared=$shared preserves both contributions',async c=>{
 localStorage.clear();enabledTools.add('write_file');W.mainAgentRole=null;W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);W.setActivePlaceholder(null);
 const disk:Record<string,string>=c.shared?{'shared.txt':'alpha=0\nbeta=0\n'}:{};
 setWorkspaceAdapter({agentReadFile:async(p:string)=>{if(!(p in disk))throw Error('OWN_ENOENT');return disk[p]},agentListFiles:async()=>Object.keys(disk).map(name=>({name,size:disk[name].length})),agentWriteFile:async(p:string,s:string)=>{disk[p]=s},agentDeleteFile:async(p:string)=>{delete disk[p]},agentFileMtime:async()=>null,agentListFilesInDir:async()=>[]} as any);
 const model='own-identities',spec='custom|'+model;
 localStorage.setItem('fg_custom_models',JSON.stringify([{provider:'custom',model,contextK:128,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));for(const k of ['fg_main_models','fg_worker_models'])localStorage.setItem(k,JSON.stringify([spec]));for(const[k,v]of Object.entries({fg_thinking_level:'off',fg_tool_approval:'off',fg_intent_validation:'off',fg_agent_worker_reduce:'false',fg_utility_model:'none',fg_endpoint_rotation:'false'}))localStorage.setItem(k,v);
 const calls:any[]=[];
 W.fetch=vi.fn(async(_u:any,init:any)=>{let p=JSON.parse(init.body);if(p.body)p=JSON.parse(p.body);const a=JSON.stringify(p.messages).includes('OWN_TASK_ALPHA'),side=a?'ALPHA':'BETA',done=p.messages.some((m:any)=>m.role==='tool');calls.push({side,done});const message=done?{role:'assistant',content:`OWN_REPORT_${side}\nSTATUS: complete`}:{role:'assistant',content:null,tool_calls:[{id:'own-'+side,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:c.shared?'shared.txt':side+'.txt',content:c.shared?(a?'alpha=1\nbeta=0\n':'alpha=0\nbeta=1\n'):side})}}]};return new Response(JSON.stringify({choices:[{message}],usage:{prompt_tokens:30,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}})});
 const result=await W.executeWorkers({agents:[{id:'same',task:'OWN_TASK_ALPHA apply alpha contribution',role:'coder',model:spec},{id:c.duplicate?'same':'other',task:'OWN_TASK_BETA apply beta contribution',role:'coder',model:spec}]});
 observations.push({...c,disk:{...disk},calls,result});expect(calls).toHaveLength(4);expect(result.agents).toHaveLength(2);expect(result.agents.every((a:any)=>a.status==='complete')).toBe(true);
 if(c.shared)expect(disk['shared.txt']).toBe('alpha=1\nbeta=1\n');else{expect(disk).toEqual({'ALPHA.txt':'ALPHA','BETA.txt':'BETA'});expect(Object.values(result.outputs)).toHaveLength(2)}
},15000);
