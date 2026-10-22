import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../llm-loops.ts')});
afterEach(()=>W.setActivePlaceholder(null));
it.each(['json','sse'].flatMap(format=>['stop','length','content_filter','error'].map(finish=>({format,finish}))))('$format finish $finish does not silently accept incomplete output',async c=>{
 localStorage.clear();W.setSoftStopPending(false);W.setActiveAbortController(new AbortController());
 const events:any[]=[];const handle=Object.fromEntries(['setModel','setPrompt','setRequest','setOutput','append','setTokens','complete','abort','markCompact'].map(name=>[name,(...args:any[])=>events.push({name,args})]));W.setActivePlaceholder({addToolStep:()=>[handle]});
 const content=c.finish==='stop'?'OWN_FULL_REPORT':'OWN_PARTIAL_REPORT: first item, next item is';let requests=0;
 W.fetch=vi.fn(async()=>{requests++;return c.format==='json'?new Response(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:c.finish}],usage:{prompt_tokens:10,completion_tokens:40}}),{headers:{'content-type':'application/json'}}):new Response('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:c.finish}],usage:{prompt_tokens:10,completion_tokens:40}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
 let result:any,error:any;try{result=await W.callLLMComplete('Return the complete own report.',{endpoint:{provider:'custom',url:'http://own-fixture.invalid/v1/chat/completions',model:'own-aux-finish',key:'own-synthetic-key'},label:'worker:review:review',maxTokens:40,maxAttempts:1})}catch(e:any){error={message:e.message,isTruncated:e.isTruncated}}
 observations.push({...c,content,requests,result,error,events});expect(requests).toBe(1);if(c.finish==='stop'){expect(error).toBeUndefined();expect(result).toBe(content);expect(events.some(e=>e.name==='complete')).toBe(true)}else{expect(result).toBeUndefined();expect(error).toBeDefined();expect(events.some(e=>e.name==='complete')).toBe(false)}
});
