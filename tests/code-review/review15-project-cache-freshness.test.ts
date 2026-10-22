import 'fake-indexeddb/auto';
import {beforeAll,afterAll,afterEach,it,expect} from 'vitest';
import {setChatHistory,getChatHistory} from '../../chat-history.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../chat-state.ts')});
afterEach(()=>W.setSessionStore(null));
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const projects=()=>new Promise<any[]>((resolve,reject)=>{const o=indexedDB.open('FreeGentDB');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,r=db.transaction('projects','readonly').objectStore('projects').getAll();r.onsuccess=()=>{resolve(r.result);db.close()};r.onerror=()=>reject(r.error)}});
it.each([false,true].flatMap(fail=>['rewind','edit'].map(mode=>({fail,mode}))))('project save keeps current $mode history with durable failure=$fail',async c=>{
 localStorage.clear();W.setWorkflowMode?.(false);const id='own-project-'+c.mode+'-'+c.fail,name='Own project '+c.mode+' '+c.fail;
 document.body.innerHTML='<input id="project-name-input"><div id="agent-messages"></div>';(document.getElementById('project-name-input') as HTMLInputElement).value=name;
 const old=[{role:'user',content:'OWN_FIRST_REQUEST'},{role:'assistant',content:'OWN_ORIGINAL_ANSWER'},{role:'user',content:'OWN_SECOND_REQUEST'},{role:'assistant',content:'OWN_SECOND_ANSWER'}],current=c.mode==='rewind'?old.slice(0,2):old.map((m,i)=>i===1?{...m,content:'OWN_EDITED_CURRENT_ANSWER'}:m);let persisted=clone(old),writes=0;
 W.setSessionStore({replaceMessages:async(_id:string,h:any[])=>{writes++;if(c.fail)throw Error('OWN_CHAT_SAVE_FAILURE');persisted=clone(h)},loadHistory:async()=>clone(persisted)} as any);
 localStorage.setItem('fg_chat_list',JSON.stringify([{id,name:'Own receipt',createdAt:1,lastAt:1}]));localStorage.setItem('fg_active_chat',id);W.setActiveChatId(id);setChatHistory(clone(current));W.saveHistory();await Promise.resolve();await Promise.resolve();const cache=JSON.parse(localStorage.getItem('fg_chat_'+id+'_oh')||'null');expect(cache).toEqual(current);expect(getChatHistory()).toEqual(current);
 await W.saveProject();const saved=(await projects()).find(p=>p.name===name);expect(saved).toBeDefined();const backup=JSON.parse(saved.chatData['fg_chat_'+id+'_oh']);observations.push({...c,id,name,current,cache,persisted,backup,writes,stamp:JSON.parse(localStorage.getItem('fg_chat_'+id+'_rev')||'null')});expect(backup).toEqual(current);
});
