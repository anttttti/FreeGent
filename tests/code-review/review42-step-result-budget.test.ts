import {afterAll,it,expect} from 'vitest';
import {truncateResultForHistory} from '../../history.ts';
const observations:any[]=[];
it.each(['read_file','browser_snapshot','repo_map','deep_research','execute_code_stderr','repo_then_read'])('%s results consume the shared step budget',name=>{
 localStorage.clear();localStorage.setItem('fg_agent_max_tool_result','100000');const budget={remaining:1000},seen=new Map(),list=new Set(),results:any[]=[];
 for(let i=0;i<2;i++){
  const text=('OWN_'+i+'_').padEnd(600,'x'),kind=name==='repo_then_read'?(i?'read_file':'repo_map'):name,tool=kind==='execute_code_stderr'?'execute_code':kind;
  const raw=kind==='read_file'?{path:'own-'+i+'.txt',content:text}:kind==='browser_snapshot'?{url:'http://own-fixture.invalid/'+i,observation:text}:kind==='repo_map'?{map:text,files_mapped:1}:kind==='execute_code_stderr'?{stdout:'',stderr:text,exit_code:1}:{report:text};
  const kept=truncateResultForHistory(tool,raw,{stepBudget:budget,seenReadFiles:seen,seenListFiles:list});results.push({tool,raw,kept,remaining:budget.remaining});
 }
 observations.push({name,initialBudget:1000,remaining:budget.remaining,results});expect(budget.remaining).toBe(0);
});
