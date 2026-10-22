import {it,expect,afterAll} from 'vitest';
import {writeFileSync,mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {takeSnapshot,restoreSnapshot} from '../../tui-checkpoint.ts';
const observations:any[]=[];
it.each(['unchanged-ignore-control','unignore-preexisting','ignore-new-file'])('%s checkpoint preserves the correct file lifetime',async mode=>{const base=mkdtempSync(join(tmpdir(),'fg-review13-ignore-')),root=join(base,'root'),store=join(base,'store');mkdirSync(root);try{execFileSync('git',['init','-q'],{cwd:root,stdio:'pipe'});const initiallyIgnored=mode!=='ignore-new-file';writeFileSync(join(root,'.gitignore'),initiallyIgnored?'archive/\n':'');writeFileSync(join(root,'main.txt'),'OWN_MAIN');execFileSync('git',['add','.gitignore','main.txt'],{cwd:root,stdio:'pipe'});const target='archive/'+(initiallyIgnored?'preexisting.txt':'created.txt');if(initiallyIgnored){mkdirSync(join(root,'archive'));writeFileSync(join(root,target),'OWN_PREEXISTING_KEEP')}
 const snap=await takeSnapshot(root,store,'before');await new Promise(r=>setTimeout(r,30));/* the turn takes longer than the clock's resolution */expect(snap.tooBig).toBe(false);expect(snap.files).toContain('main.txt');expect(snap.files).not.toContain(target);if(mode==='unignore-preexisting')writeFileSync(join(root,'.gitignore'),'');if(mode==='ignore-new-file'){mkdirSync(join(root,'archive'));writeFileSync(join(root,target),'OWN_CREATED_DURING_TURN');writeFileSync(join(root,'.gitignore'),'archive/\n')}
 const restored=await restoreSnapshot(root,snap),after=existsSync(join(root,target))?readFileSync(join(root,target),'utf8'):null;observations.push({mode,target,snapshot:{files:snap.files,tooBig:snap.tooBig,skippedLarge:snap.skippedLarge},restored,after,finalIgnore:readFileSync(join(root,'.gitignore'),'utf8')});expect(after).toBe(initiallyIgnored?'OWN_PREEXISTING_KEEP':null);
 }finally{rmSync(base,{recursive:true,force:true})}});
