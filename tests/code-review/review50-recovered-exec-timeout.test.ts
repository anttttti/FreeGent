import {afterEach,afterAll,it,expect,vi} from 'vitest';
const W=window as any,observations:any[]=[],originalNative=W.nativeExec;
afterEach(()=>{W.nativeExec=originalNative});
it.each([{language:'bash',code:'echo OWN_TIMEOUT',recover:false},{language:'python',code:'print("OWN_TIMEOUT")',recover:false},{language:'python',code:'echo OWN_TIMEOUT',recover:true}])('$language recovery=$recover preserves explicit timeout',async c=>{
 localStorage.clear();localStorage.setItem('fg_tool_approval','off');localStorage.setItem('fg_intent_validation','off');W.mainAgentRole=null;W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());
 const calls:any[]=[];W.nativeExec=vi.fn(async(language:string,code:string,opts:any)=>{calls.push({language,code,opts:opts??null});if(c.recover&&language==='python')return {stdout:'',stderr:'  File "<string>", line 1\n    echo OWN_TIMEOUT\nSyntaxError: invalid syntax',exit_code:1};return {stdout:'OWN_TIMEOUT\n',stderr:'',exit_code:0}});
 const result=await W.executeToolAsync('execute_code',{language:c.language,code:c.code,timeout_s:7});observations.push({...c,calls,result});expect(result.stdout).toBe('OWN_TIMEOUT\n');expect(calls).toHaveLength(c.recover?2:1);for(const call of calls)expect(call.opts).toEqual({timeoutMs:7000});
});
