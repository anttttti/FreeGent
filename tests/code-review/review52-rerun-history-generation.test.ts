import {afterAll,it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as Store from '../../tui-store.ts';
import {makeTuiPlaceholder} from '../../tui-placeholder.ts';
const source=readFileSync('fg-tui.tsx','utf8'),sf=ts.createSourceFile('fg-tui.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),decl=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='rerunFromStep')!;
const fn=decl.getText(sf),code=ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,observations:any[]=[];
it.each(['original','compacted-short','compacted-regrown'])('old step anchor handles history=%s',async state=>{
 Store.replaceEntries([]);Store.setNextTurnOrigin({text:'OWN_SECOND_REQUEST',historyLen:2,ckptId:null,model:'own'});Store.addUserMessage('OWN_SECOND_REQUEST');const ph:any=makeTuiPlaceholder();ph.addThinkingTask({histLen:3});ph.finalize('OWN_OLD_ANSWER');const turn=(Store.getState().entries.find(e=>e.type==='turn') as any).turn,step=turn.steps[0];
 const original=[{role:'user',content:'OWN_FIRST_REQUEST'},{role:'assistant',content:'OWN_FIRST_ANSWER'},{role:'user',content:'OWN_SECOND_REQUEST'},{role:'assistant',content:'OWN_OLD_ANSWER'}],summary=[{role:'user',content:'OWN_COMPACTED_SUMMARY'},{role:'assistant',content:'OWN_SUMMARY_ACK'}],growth=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:'OWN_NEW_'+i}));
 let history:any[]=state==='original'?original:state==='compacted-short'?summary:[...summary,...growth];const before=structuredClone(history),runs:any[]=[];
 // Execute the actual source declaration without booting fg-tui's CLI/profile/terminal side effects.
 const sandbox:any={exports:{},Store,makeTuiPlaceholder,isTurnBusy:()=>false,getChatHistory:()=>history,setChatHistory:(h:any[])=>{history=h},_sendsActive:0,_dropCheckpointsFrom:async()=>{},_restoreTurnWorkspace:async()=>'',rerunTurnFromHistory:async(factory:any)=>{runs.push(structuredClone(history));factory().finalize('OWN_RERUN_ANSWER')}};
 vm.runInNewContext(code,sandbox);await sandbox.exports.rerunFromStep(turn,step,{resetWorkspace:false});
 observations.push({state,before,history,runs,origin:turn.origin,entries:Store.getState().entries.map(e=>e.type==='user'?{type:e.type,text:e.text}:{type:e.type,finalText:(e as any).turn?.finalText}),sendsActive:sandbox._sendsActive});expect(sandbox._sendsActive).toBe(0);if(state==='original'){expect(runs).toHaveLength(1);expect(history.at(-1)?.content).toBe('OWN_SECOND_REQUEST')}else{expect(runs).toHaveLength(0);expect(history).toEqual(before)}
});
