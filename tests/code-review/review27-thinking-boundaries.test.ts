import {it,expect,afterAll} from 'vitest';
import {streamOAICompat,nonStreamOAICompat} from '../../stream-decode.ts';
const observations:any[]=[];
it.each(['think','thinking','thought'].flatMap(tag=>['whole','openSplit','closeSplit'].map(boundary=>({tag,boundary}))))('$tag tag $boundary preserves visible answer',async c=>{
 (window as any).setSoftStopPending(false);(window as any).setActiveAbortController(new AbortController());
 const open='<'+c.tag+'>',close='</'+c.tag+'>',reason='Own intermediate calculation.',answer='OWN_FINAL_42';
 const chunks=c.boundary==='whole'?[open+reason+close+answer]:c.boundary==='openSplit'?[open.slice(0,3),open.slice(3)+reason+close+answer]:[open+reason+close.slice(0,4),close.slice(4)+answer];
 const events=chunks.map(content=>({choices:[{delta:{content}}]}));events.push({choices:[{delta:{},finish_reason:'stop'}]} as any);
 const sse=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n';
 const live:any[]=[],nonlive:any[]=[];
 const stream=await streamOAICompat(new Response(sse,{headers:{'content-type':'text/event-stream'}}),(text:string,kind:string)=>live.push({text,kind}));
 const nonstream=await nonStreamOAICompat(new Response(JSON.stringify({choices:[{message:{role:'assistant',content:chunks.join('')},finish_reason:'stop'}]})),(text:string,kind:string)=>nonlive.push({text,kind}));
 const visible=live.filter(x=>x.kind==='output').map(x=>x.text).join('');
 observations.push({...c,chunks,stream,nonstream,live,nonlive,visible});expect(nonstream.content).toBe(answer);expect(stream.content).toBe(answer);expect(visible).toBe(answer);
});
