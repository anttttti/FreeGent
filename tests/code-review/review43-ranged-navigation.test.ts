import {afterAll,it,expect} from 'vitest';
import {truncateResultForHistory} from '../../history.ts';
const W=window as any,observations:any[]=[];
const file=Array.from({length:700},(_,i)=>'OWN_LINE_'+String(i+1).padStart(3,'0')).join('\n');
it('seven disjoint ranges remain available despite whole-file reread protection',async()=>{
 localStorage.clear();W.mainAgentRole=null;const context={snapshot:new Map([['own-navigation.txt',file]]),staging:new Map(),depth:0},seen=new Map(),results:any[]=[];
 for(let i=0;i<7;i++){const start=i*100+1,end=(i+1)*100,raw=await W.executeToolAsync('read_file',{path:'own-navigation.txt',start_line:start,end_line:end},context),kept=truncateResultForHistory('read_file',raw,{seenReadFiles:seen,stepBudget:{remaining:50000}});results.push({start,end,raw,kept})}
 observations.push({case:'seven ranges',results,cache:[...seen]});for(const r of results){expect(r.kept.content).toBe(r.raw.content);expect(r.kept.lines_returned).toBe(100)}expect(results.at(-1).kept.content).toContain('OWN_LINE_700');
});
it('an exact unchanged range repeat is still deduplicated',async()=>{
 localStorage.clear();W.mainAgentRole=null;const context={snapshot:new Map([['own-navigation.txt',file]]),staging:new Map(),depth:0},seen=new Map();const raw=await W.executeToolAsync('read_file',{path:'own-navigation.txt',start_line:1,end_line:100},context),first=truncateResultForHistory('read_file',raw,{seenReadFiles:seen}),second=truncateResultForHistory('read_file',raw,{seenReadFiles:seen});observations.push({case:'exact duplicate',raw,first,second});expect(first.content).toBe(raw.content);expect(second.content).toBeUndefined();expect(second.note).toContain('Already read');
});
