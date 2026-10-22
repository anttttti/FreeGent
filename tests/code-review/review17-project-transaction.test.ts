import 'fake-indexeddb/auto';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
const W=window as any,observations:any[]=[];
beforeAll(async()=>{await import('../../chat-state.ts')});
afterEach(()=>vi.restoreAllMocks());
const projectStore=()=>new Promise<{db:IDBDatabase,store:IDBObjectStore}>((resolve,reject)=>{const req=indexedDB.open('FreeGentDB');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;resolve({db,store:db.transaction('projects','readonly').objectStore('projects')})}});
const savedProjects=async()=>{const {db,store}=await projectStore();return new Promise<any[]>((resolve,reject)=>{const r=store.getAll();r.onsuccess=()=>{resolve(r.result);db.close()};r.onerror=()=>reject(r.error)})};
it.each([false,true])('project save acknowledgement follows transaction commit, abort=%s',async abort=>{
 localStorage.clear();W.setActiveChatId('');W.setSessionStore(null);const name='Own transaction project '+abort,file='own-project-transaction-'+abort+'.txt';document.body.innerHTML='<input id="project-name-input"><button class="project-save-btn">Save</button><div id="agent-messages"></div>';(document.getElementById('project-name-input') as HTMLInputElement).value=name;
 await W.agentWriteFile(file,'OWN_OLD_BACKUP');await W.saveProject();expect((await savedProjects()).find(p=>p.name===name).workspace.find((f:any)=>f.name===file).content).toBe('OWN_OLD_BACKUP');await W.agentWriteFile(file,'OWN_NEW_WORKSPACE');document.querySelector('.project-save-btn')!.textContent='Save';
 const {db,store}=await projectStore(),proto=Object.getPrototypeOf(store),original=proto.put;db.close();let aborted=0;
 const spy=vi.spyOn(proto,'put').mockImplementation(function(this:IDBObjectStore,...args:any[]){const req=original.apply(this,args);if(abort&&this.name==='projects'){const tx=this.transaction;req.addEventListener('success',()=>{aborted++;tx.abort()})}return req});
 const alerts:any[]=[];vi.spyOn(window,'alert').mockImplementation((s:any)=>{alerts.push(String(s))});try{await W.saveProject();const feedback=document.querySelector('.project-save-btn')?.textContent,record=(await savedProjects()).find(p=>p.name===name),saved=record.workspace.find((f:any)=>f.name===file).content;observations.push({abort,aborted,feedback,alerts,saved,current:await W.agentReadFile(file)});if(abort){expect(aborted).toBe(1);expect(feedback==='✓ Saved'&&saved!=='OWN_NEW_WORKSPACE').toBe(false)}else{expect(saved).toBe('OWN_NEW_WORKSPACE');expect(feedback).toBe('✓ Saved')}}finally{spy.mockRestore()}
});
