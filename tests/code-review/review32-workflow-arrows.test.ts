import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../tasks.ts')});
afterEach(()=>{setWorkspaceAdapter(null);vi.restoreAllMocks()});
it.each(['→','>','->'])('workflow heading with %s applies its declared completeness check',async arrow=>{
 localStorage.clear();for(const[k,v]of Object.entries({fg_qa_enabled:'true',fg_qa_acceptance_review:'false',fg_qa_test_runner:'false'}))localStorage.setItem(k,v);
 const path='fg-tasks/001-own.md',disk:Record<string,string>={[path]:'---\nid: 001\ntitle: Own arrow task\nstatus: in-review\n---\n## Plan\n- [ ] Own unfinished implementation\n','WORKFLOW.md':`## Gates: in-review ${arrow} done\n- completeness-check\n`,'fg-tasks/ledger.md':'| 001 | in-review | Own arrow task |\n'};
 setWorkspaceAdapter({agentReadFile:async(p:string)=>{if(!(p in disk))throw Error('OWN_ENOENT');return disk[p]},agentWriteFile:async(p:string,c:string)=>{disk[p]=c},agentListFiles:async()=>Object.keys(disk).map(name=>({name})),agentDeleteFile:async(p:string)=>{delete disk[p]}} as any);
 vi.spyOn(W,'refreshTasks').mockImplementation(async()=>{});const judge=vi.spyOn(W,'callLLMComplete').mockRejectedValue(Error('UNEXPECTED_JUDGE'));
 const result=await W.transitionTask(path,'done');observations.push({arrow,workflow:disk['WORKFLOW.md'],result,task:disk[path],ledger:disk['fg-tasks/ledger.md'],judgeCalls:judge.mock.calls.length});expect(judge).not.toHaveBeenCalled();expect(result.transitioned).toBe(false);expect(disk[path]).toMatch(/^status: in-review$/m);
});
