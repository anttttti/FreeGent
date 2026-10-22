import {afterEach,afterAll,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NodeFsAdapter} from '../../node-fs-adapter.ts';
import {setWorkspaceAdapter} from '../../workspace.ts';
import {enabledTools} from '../../config.ts';
const W=window as any,observations:any[]=[],roots:string[]=[];
afterEach(async()=>{setWorkspaceAdapter(null);for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
it.each(['absent','empty','populated','empty-with-top-file'])('workspace directory %s preserves the intended target',async state=>{
 localStorage.clear();localStorage.setItem('fg_tool_approval','off');localStorage.setItem('fg_intent_validation','off');W.mainAgentRole=null;enabledTools.add('write_file');W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);
 const root=await mkdtemp(join(tmpdir(),'fg-review48-own-'));roots.push(root);if(state!=='absent')await mkdir(join(root,'workspace'));if(state==='populated')await writeFile(join(root,'workspace/own-existing.txt'),'OWN_EXISTING');if(state==='empty-with-top-file')await writeFile(join(root,'own-new.txt'),'OWN_PREEXISTING_TOP');setWorkspaceAdapter(new NodeFsAdapter(root));
 const preTop=await readFile(join(root,'own-new.txt'),'utf8').catch(()=>null);expect(preTop).toBe(state==='empty-with-top-file'?'OWN_PREEXISTING_TOP':null);const before=await W.agentListFiles(),result=await W.executeToolAsync('write_file',{path:'workspace/own-new.txt',content:'OWN_NEW_CONTENT'}),top=await readFile(join(root,'own-new.txt'),'utf8').catch(()=>null),nested=await readFile(join(root,'workspace/own-new.txt'),'utf8').catch(()=>null);observations.push({state,preTop,before,result,top,nested});expect(result.error).toBeUndefined();if(state==='absent'){expect(top).toBe('OWN_NEW_CONTENT');expect(nested).toBeNull()}else{expect(nested).toBe('OWN_NEW_CONTENT');expect(top).toBe(state==='empty-with-top-file'?'OWN_PREEXISTING_TOP':null)}
});
