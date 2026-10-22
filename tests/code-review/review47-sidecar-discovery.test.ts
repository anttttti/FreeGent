import {beforeAll,afterEach,afterAll,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NodeFsAdapter} from '../../node-fs-adapter.ts';
import {setWorkspaceAdapter} from '../../workspace.ts';
const W=window as any,observations:any[]=[],roots:string[]=[];
beforeAll(async()=>{await import('../../tasks.ts')});
afterEach(async()=>{setWorkspaceAdapter(null);for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
it.each(['ordinary','sidecar','sidecar-with-root-task'])('%s lists the task it has just written',async mode=>{
 localStorage.clear();const parent=await mkdtemp(join(tmpdir(),'fg-review47-own-'));roots.push(parent);const root=join(parent,'project α space'),side=join(parent,'sidecar'),path='fg-tasks/001-own.md',content='---\nid: 001\ntitle: Own sidecar task\nstatus: open\n---\nOwn task body.\n';await mkdir(root);await mkdir(side);
 if(mode==='sidecar-with-root-task'){await mkdir(join(root,'fg-tasks'));await writeFile(join(root,'fg-tasks/099-old.md'),'---\nid: 099\ntitle: Own root task\nstatus: open\n---\n')}
 const adapter=new NodeFsAdapter(root,mode==='ordinary'?{}:{sidecarRoot:side,sidecarPrefixes:['fg-tasks/','memory/']} as any);setWorkspaceAdapter(adapter);await W.agentWriteFile(path,content);
 const read=await W.agentReadFile(path),physical=await readFile(join(mode==='ordinary'?root:side,path),'utf8'),all=await W.agentListFiles(),subtree=await W.agentListFilesInDir('fg-tasks'),tasks=await W.loadTaskFiles();observations.push({mode,read,physical,all,subtree,tasks});expect(read).toBe(content);expect(physical).toBe(content);expect(all.map((f:any)=>f.name)).toContain(path);expect(subtree.map((f:any)=>f.name)).toContain('001-own.md');expect(tasks.map((t:any)=>t.path)).toContain(path);
});
