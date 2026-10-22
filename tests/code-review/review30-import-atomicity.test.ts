import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {validateProjectData} from '../../workspace.ts';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../chat-state.ts');W.loadAgentsContext=vi.fn();W.loadSkills=vi.fn()});
afterEach(()=>vi.restoreAllMocks());
it.each(['none','secondWrite','clear'])('valid project import remains coherent with fault=%s',async fault=>{
 const abort=fault==='secondWrite';
 localStorage.clear();W.setActiveChatId('');W.setSessionStore(null);W.stopTurnAndWait=vi.fn(async()=>true);document.body.innerHTML='<input id="project-name-input">';
 for(const f of await W.listWorkspaceFiles())await W.deleteWorkspaceFile(f.name);
 await W.writeWorkspaceFile('own-original.txt','OWN_PREIMPORT_CONTENT');localStorage.setItem('fg_chat_own-before_oh',JSON.stringify([{role:'user',content:'OWN_BEFORE_CHAT'}]));
 const data={fg_project:'1.0',id:'own-import',name:'Own import',workspace:[{name:'own-new-first.txt',content:'OWN_IMPORTED_TEXT'},{name:'own-new-second.bin',content:'AAECA/7/',encoding:'base64'}],chatData:{}};expect(()=>validateProjectData(data)).not.toThrow();
 const confirms:any[]=[],alerts:any[]=[],puts:any[]=[];vi.spyOn(window,'confirm').mockImplementation((s:any)=>{confirms.push(s);return true});vi.spyOn(window,'alert').mockImplementation((s:any)=>{alerts.push(String(s))});
 const put=IDBObjectStore.prototype.put;let aborted=0;const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:any[]){const req=put.apply(this,args as any);puts.push({store:this.name,name:args[0]?.name});if(abort&&args[0]?.name==='own-new-second.bin'){const tx=this.transaction;req.addEventListener('success',()=>{aborted++;tx.abort()})}return req});
 const clear=IDBObjectStore.prototype.clear;let clearAborted=0;vi.spyOn(IDBObjectStore.prototype,'clear').mockImplementation(function(this:IDBObjectStore){const req=clear.call(this);if(fault==='clear'&&this.name==='files'){const tx=this.transaction;req.addEventListener('success',()=>{clearAborted++;tx.abort()})}return req});
 try{await W.importProject({files:[{name:'own.fg_project.json',text:async()=>JSON.stringify(data)}],value:'own'});const files=(await W.listWorkspaceFiles()).map((f:any)=>({name:f.name,content:f.content,encoding:f.encoding??null}));observations.push({fault,abort,aborted,clearAborted,confirms,alerts,puts,files,oldChat:localStorage.getItem('fg_chat_own-before_oh'),projectName:localStorage.getItem('fg_project_name')});expect(confirms).toHaveLength(1);if(fault==='clear'){expect(clearAborted).toBe(1);expect(alerts.some((s:string)=>s.includes('Import failed'))).toBe(true);expect(files).toEqual([{name:'own-original.txt',content:'OWN_PREIMPORT_CONTENT',encoding:null}])}else if(abort){expect(aborted).toBe(1);expect(alerts.some((s:string)=>s.includes('Import failed'))).toBe(true);expect(files).toEqual([{name:'own-original.txt',content:'OWN_PREIMPORT_CONTENT',encoding:null}])}else{expect(alerts).toEqual([]);expect(files).toEqual([{name:'own-new-first.txt',content:'OWN_IMPORTED_TEXT',encoding:null},{name:'own-new-second.bin',content:'AAECA/7/',encoding:'base64'}]);expect(localStorage.getItem('fg_chat_own-before_oh')).toBeNull()}}finally{spy.mockRestore()}
});
