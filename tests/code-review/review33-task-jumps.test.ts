import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setWorkspaceAdapter} from '../../workspace.ts';
import {enabledTools} from '../../config.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../tasks.ts')});
afterEach(()=>{setWorkspaceAdapter(null);W.clearMainAgentRole();vi.restoreAllMocks()});
it.each(['in-progress','todo','open','blocked'].flatMap(from=>[false,true].map(reviews=>({from,reviews}))))('QA protects unfinished work when $from jumps directly to done; reviews=$reviews',async({from,reviews})=>{
 localStorage.clear();W.setMainAgentRole('director');enabledTools.add('update_task_status');for(const[k,v]of Object.entries({fg_qa_enabled:'true',fg_qa_acceptance_review:String(reviews),fg_qa_test_runner:String(reviews)}))localStorage.setItem(k,v);
 const path='fg-tasks/002-own.md',disk:Record<string,string>={[path]:`---\nid: 002\ntitle: Own incomplete task\nstatus: ${from}\n---\n## Plan\n- [ ] Own implementation still required\n`,'fg-tasks/ledger.md':`| 002 | ${from} | Own incomplete task |\n`};
 setWorkspaceAdapter({agentReadFile:async(p:string)=>{if(!(p in disk))throw Error('OWN_ENOENT');return disk[p]},agentWriteFile:async(p:string,c:string)=>{disk[p]=c},agentListFiles:async()=>Object.keys(disk).map(name=>({name})),agentDeleteFile:async(p:string)=>{delete disk[p]}} as any);
 vi.spyOn(W,'refreshTasks').mockImplementation(async()=>{});const judge=vi.spyOn(W,'callLLMComplete').mockRejectedValue(Error('UNEXPECTED_JUDGE'));
 const result=await W.executeToolAsync('update_task_status',{path,status:'done'});observations.push({from,reviews,result,task:disk[path],ledger:disk['fg-tasks/ledger.md'],gatePass:W.gatesPassedDone(path),judgeCalls:judge.mock.calls.length});expect(judge).not.toHaveBeenCalled();expect(result.blocked).toBe(true);expect(result.ok).toBe(false);expect(disk[path]).toContain('status: '+from+'\n');
});
