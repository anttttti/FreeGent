import {afterAll,it,expect} from 'vitest';
const W=window as any,observations:any[]=[];
const file=Array.from({length:200},(_,i)=>'OWN_LINE_'+String(i+1).padStart(3,'0')).join('\n');
it.each([{kind:'numbers',args:{start_line:10,end_line:11},base:{start_line:10,end_line:11}},{kind:'numeric strings',args:{start_line:'10',end_line:'11'},base:{start_line:10,end_line:11}},{kind:'mixed string/number',args:{start_line:'10',end_line:11},base:{start_line:10,end_line:11}},{kind:'JSON range alias',args:{line_range:'[10,11]'},base:{start_line:10,end_line:11}},{kind:'inverted numeric strings',args:{start_line:'70',end_line:'20'},base:{start_line:70,end_line:20}}])('$kind reads the intended numeric range or rejects it explicitly',async c=>{
 localStorage.clear();W.mainAgentRole=null;const context={snapshot:new Map([['own-ranges.txt',file]]),staging:new Map(),depth:0};
 const expected=await W.executeToolAsync('read_file',{path:'own-ranges.txt',...c.base},context),actual=await W.executeToolAsync('read_file',{path:'own-ranges.txt',...c.args},context);
 observations.push({...c,expected,actual});expect(expected.error).toBeUndefined();if(!actual.error)expect(actual.content).toBe(expected.content);
});
