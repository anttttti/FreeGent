import 'fake-indexeddb/auto';
import {beforeAll,afterEach,afterAll,it,expect,vi} from 'vitest';
import {enabledTools} from '../../config.ts';
const W=window as any,observations:any[]=[];
class OwnFile {
 kind='file';constructor(public name:string,public disk:Map<string,Uint8Array>){}
 async getFile(){const b=this.disk.get(this.name)!;return {size:b.length,lastModified:1,arrayBuffer:async()=>b.slice().buffer,text:async()=>new TextDecoder().decode(b)}}
 async createWritable(){return {write:async(c:any)=>{this.disk.set(this.name,typeof c==='string'?new TextEncoder().encode(c):new Uint8Array(c))},close:async()=>{}}}
}
class OwnDir {
 name='Own fake folder';kind='directory';disk=new Map<string,Uint8Array>();
 async *entries(){for(const name of this.disk.keys())yield [name,new OwnFile(name,this.disk)]}
 async getFileHandle(name:string,opts:any={}){if(!this.disk.has(name)){if(!opts.create)throw Error('OWN_NOT_FOUND');this.disk.set(name,new Uint8Array())}return new OwnFile(name,this.disk)}
}
beforeAll(()=>{vi.stubGlobal('isSecureContext',true);W.maybeRunInitAgent=async()=>{};W.generateAndShowSuggestion=async()=>{}});
afterEach(async()=>{W.closeFsaFolder();vi.restoreAllMocks()});
it.each(['idb','local','mirrored'].flatMap(route=>[false,true].map(binary=>({route,binary}))))('$route base64=$binary preserves file bytes',async c=>{
 localStorage.clear();enabledTools.add('write_file');W.setActiveAbortController(new AbortController());W.setSoftStopPending(false);document.body.innerHTML='';
 const dir=new OwnDir(),name='own-bytes-'+c.route+'-'+c.binary+'.bin',bytes=c.binary?new Uint8Array([0,1,2,3,254,255]):new TextEncoder().encode('OWN_PLAIN_TEXT');
 if(c.route!=='idb'){if(c.route==='mirrored')dir.disk.set(name,new TextEncoder().encode('OWN_OLD'));W.showDirectoryPicker=vi.fn(async()=>dir);const opened=await W.openLocalFolder();expect(opened).toBe(dir);await new Promise(r=>setTimeout(r,0))}
 const path=(c.route==='local'?'local/':'')+name,content=c.binary?Buffer.from(bytes).toString('base64'):'OWN_PLAIN_TEXT';
 const result=await W.executeToolAsync('write_file',{path,content,...(c.binary?{encoding:'base64'}:{})});
 const readback=await W.agentReadFileBytes(path),local=c.route!=='idb'?Array.from(dir.disk.get(name)!):null,idb=await W.readWorkspaceFile(name);observations.push({...c,path,result,expected:Array.from(bytes),readback:Array.from(readback),local,idb});expect(result.error).toBeUndefined();expect(Array.from(readback)).toEqual(Array.from(bytes));if(c.route!=='idb')expect(local).toEqual(Array.from(bytes));
});
