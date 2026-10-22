import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../tasks.ts')});
afterEach(()=>{setWorkspaceAdapter(null);vi.restoreAllMocks()});
it.each([{reply:'YES\npayload: Own required function is absent',blocks:true},{reply:'**YES**\npayload: Own required function is absent',blocks:true},{reply:'- YES\npayload: Own required function is absent',blocks:true},{reply:'**NO**',blocks:false}])('acceptance verdict $reply preserves its decision',async c=>{
 localStorage.clear();for(const[k,v]of Object.entries({fg_qa_enabled:'true',fg_qa_acceptance_review:'true',fg_qa_test_runner:'false'}))localStorage.setItem(k,v);
 const path='fg-tasks/003-own.md',disk:Record<string,string>={[path]:'---\nid: 003\ntitle: Own acceptance task\nstatus: in-review\n---\n## Acceptance\nOwn required function is present.\n## Files\n- `src/own.js`\n','src/own.js':'export const ownValue=1;\n','fg-tasks/ledger.md':'| 003 | in-review | Own acceptance task |\n'};
 setWorkspaceAdapter({agentReadFile:async(p:string)=>{if(!(p in disk))throw Error('OWN_ENOENT');return disk[p]},agentWriteFile:async(p:string,s:string)=>{disk[p]=s},agentListFiles:async()=>Object.keys(disk).map(name=>({name})),agentDeleteFile:async()=>{}} as any);
 vi.spyOn(W,'refreshTasks').mockImplementation(async()=>{});const judge=vi.spyOn(W,'callLLMComplete').mockResolvedValue(c.reply);
 const result=await W.transitionTask(path,'done');observations.push({...c,result,task:disk[path],ledger:disk['fg-tasks/ledger.md'],judgeCalls:judge.mock.calls.length});expect(judge).toHaveBeenCalledTimes(1);expect(result.transitioned).toBe(!c.blocks);if(c.blocks)expect(result.reason).toContain('Own required function is absent');else expect(disk[path]).not.toContain('qa: unverified');
});
