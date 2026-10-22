import {afterEach,afterAll,it,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NodeFsAdapter} from '../../node-fs-adapter.ts';
import {setWorkspaceAdapter} from '../../workspace.ts';
import {enabledTools} from '../../config.ts';
const W=window as any,observations:any[]=[],roots:string[]=[];
afterEach(async()=>{setWorkspaceAdapter(null);for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
it.each(['relative','absolute','local alias'].flatMap(form=>[false,true].map(binary=>({form,binary}))))('$form binary=$binary preserves Unicode-path file bytes',async c=>{
 localStorage.clear();for(const[k,v]of Object.entries({fg_tool_approval:'off',fg_intent_validation:'off',fg_utility_model:'none'}))localStorage.setItem(k,v);W.mainAgentRole=null;enabledTools.add('write_file');W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);
 const parent=await mkdtemp(join(tmpdir(),'fg-review49-own-'));roots.push(parent);const root=join(parent,'project α space');await mkdir(root);setWorkspaceAdapter(new NodeFsAdapter(root));
 const relative='資料 space/naïve-'+c.binary+'.dat',path=c.form==='absolute'?join(root,relative):c.form==='local alias'?'local/'+relative:relative,text='café α हिन्दी 😀\r\nOWN_END',bytes=c.binary?Buffer.from([0,255,10,128]):Buffer.from(text,'utf8');
 const result=await W.executeToolAsync('write_file',{path,content:c.binary?bytes.toString('base64'):text,...(c.binary?{encoding:'base64'}:{})}),physical=await readFile(join(root,relative));let read:any;if(!c.binary)read=await W.executeToolAsync('read_file',{path});observations.push({...c,relative,result,expectedHex:bytes.toString('hex'),actualHex:physical.toString('hex'),read});expect(result.error).toBeUndefined();expect(result.bytes).toBe(bytes.length);expect(physical.equals(bytes)).toBe(true);if(!c.binary)expect(read.content).toBe(text);
});
