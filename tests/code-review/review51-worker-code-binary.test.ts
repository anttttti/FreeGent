import 'fake-indexeddb/auto';
import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NodeFsAdapter} from '../../node-fs-adapter.ts';
import {setWorkspaceAdapter} from '../../workspace.ts';
import {enabledTools} from '../../config.ts';
const W=window as any,observations:any[]=[],roots:string[]=[],originalNative=W.nativeExec;
beforeAll(async()=>{await import('../../llm-loops.ts');await import('../../step-validator.ts')});
afterEach(async()=>{setWorkspaceAdapter(null);W.nativeExec=originalNative;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
it.each(['native-text','native-binary','tool-binary'])('%s reports its generated file in the worker result',async kind=>{
 localStorage.clear();enabledTools.add('execute_code');enabledTools.add('write_file');W.mainAgentRole=null;W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);W.setActivePlaceholder(null);
 const root=await mkdtemp(join(tmpdir(),'fg-review51-own-'));roots.push(root);setWorkspaceAdapter(new NodeFsAdapter(root));const file='own-'+kind+'.dat',bytes=kind==='native-text'?Buffer.from('OWN_TEXT_EXECUTION'):Buffer.from([0,1,254,255]),nativeCalls:any[]=[],tools:any[]=[];
 W.nativeExec=vi.fn(async(language:string,code:string)=>{nativeCalls.push({language,code});await writeFile(join(root,file),bytes);return {stdout:'OWN_GENERATED',stderr:'',exit_code:0,files_written:[file]}});
 const model='own-worker-generated-'+kind,spec='custom|'+model;localStorage.setItem('fg_custom_models',JSON.stringify([{provider:'custom',model,contextK:128,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key',tools:true,media:['text']}]));for(const k of ['fg_main_models','fg_worker_models'])localStorage.setItem(k,JSON.stringify([spec]));for(const[k,v]of Object.entries({fg_thinking_level:'off',fg_tool_approval:'off',fg_intent_validation:'off',fg_agent_worker_reduce:'false',fg_utility_model:'none',fg_endpoint_rotation:'false'}))localStorage.setItem(k,v);
 W.fetch=vi.fn(async(_url:any,init:any)=>{let p=JSON.parse(init.body);if(p.body)p=JSON.parse(p.body);const results=p.messages.filter((m:any)=>m.role==='tool');tools.push(...results);const name=kind==='tool-binary'?'write_file':'execute_code',args=kind==='tool-binary'?{path:file,content:bytes.toString('base64'),encoding:'base64'}:{language:'bash',code:kind==='native-text'?`printf OWN_TEXT_EXECUTION > ${file}`:`python3 -c "open('${file}','wb').write(bytes([0,1,254,255]))"`};const message=results.length?{role:'assistant',content:'Own output generated.\nSTATUS: complete'}:{role:'assistant',content:null,tool_calls:[{id:'own-generate',type:'function',function:{name,arguments:JSON.stringify(args)}}]};return new Response(JSON.stringify({choices:[{message,finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:10}}),{headers:{'content-type':'application/json'}})});
 const result=await W.executeWorkers({agents:[{id:'own-generator',task:'Generate the own output and report.',role:'coder',model:spec}]}),physical=await readFile(join(root,file));observations.push({kind,file,result,nativeCalls,tools,expectedHex:bytes.toString('hex'),actualHex:physical.toString('hex')});expect(physical.equals(bytes)).toBe(true);expect(result.status).toBe('complete');expect(nativeCalls).toHaveLength(kind==='tool-binary'?0:1);expect(tools).toHaveLength(1);expect(tools[0].content).not.toContain('"error"');expect(result.agents[0].wrote).toContain(file);expect(result.applied).toContain(file);
},15000);
