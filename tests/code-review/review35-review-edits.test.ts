import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../tasks.ts')});
afterEach(()=>{setWorkspaceAdapter(null);vi.restoreAllMocks()});
it.each(['none','criteria','code','status'])('pending review respects concurrent change=%s',async change=>{
 localStorage.clear();for(const[k,v]of Object.entries({fg_qa_enabled:'true',fg_qa_acceptance_review:'true',fg_qa_test_runner:'false'}))localStorage.setItem(k,v);
 const path='fg-tasks/004-own.md',disk:Record<string,string>={[path]:'---\nid: 004\ntitle: Own concurrent task\nstatus: in-review\n---\n## Acceptance\nOWN_OLD_CRITERION\n## Files\n- `src/own.js`\n','src/own.js':'export const OWN_OLD_IMPLEMENTATION=true;\n','fg-tasks/ledger.md':'| 004 | in-review | Own concurrent task |\n'};
 setWorkspaceAdapter({agentReadFile:async(p:string)=>{if(!(p in disk))throw Error('OWN_ENOENT');return disk[p]},agentWriteFile:async(p:string,s:string)=>{disk[p]=s},agentListFiles:async()=>Object.keys(disk).map(name=>({name})),agentDeleteFile:async()=>{}} as any);
 vi.spyOn(W,'refreshTasks').mockImplementation(async()=>{});let ready!:(p:string)=>void,release!:(s:string)=>void;const entered=new Promise<string>(r=>ready=r),gate=new Promise<string>(r=>release=r);const judge=vi.spyOn(W,'callLLMComplete').mockImplementation(async(p:string)=>{ready(p);return gate});
 const run=W.transitionTask(path,'done'),prompt=await entered;
 expect(prompt).toContain('OWN_OLD_CRITERION');expect(prompt).toContain('OWN_OLD_IMPLEMENTATION');
 if(change==='criteria')await W.agentWriteFile(path,disk[path].replace('OWN_OLD_CRITERION','OWN_NEW_CRITERION'));
 if(change==='code')await W.agentWriteFile('src/own.js','export const OWN_NEW_IMPLEMENTATION=false;\n');
 if(change==='status')await W.setTaskStatus(path,'blocked');
 const beforeRelease={task:disk[path],code:disk['src/own.js']};release('NO');const result=await run;
 observations.push({change,prompt,beforeRelease,result,task:disk[path],code:disk['src/own.js'],ledger:disk['fg-tasks/ledger.md'],judgeCalls:judge.mock.calls.length});expect(judge).toHaveBeenCalledTimes(1);if(change==='none'){expect(result.transitioned).toBe(true);expect(disk[path]).toMatch(/^status: done$/m)}else{expect(result.transitioned).toBe(false);expect(disk[path]).not.toMatch(/^status: done$/m)}
},10000);
