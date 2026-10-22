import {it,expect,afterAll} from 'vitest';
import {writeFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {snapshotMarks,changedSince} from '../../workspace-scan.ts';
const observations:any[]=[];
it.each(['write-only-control','commit-only-control','write-and-commit','create-and-commit'])('%s detects actual writes rather than only final dirtiness',async mode=>{const root=mkdtempSync(join(tmpdir(),'fg-review14-commit-'));const git=(...a:string[])=>execFileSync('git',['-c','user.name=OwnReview','-c','user.email=own@example.invalid','-c','core.hooksPath=/dev/null',...a],{cwd:root,stdio:'pipe'});try{git('init','-q');writeFileSync(join(root,'main.txt'),'OWN_BEFORE');git('add','main.txt');git('commit','-qm','own initial');if(mode==='commit-only-control')writeFileSync(join(root,'main.txt'),'OWN_ALREADY_CHANGED');const before=await snapshotMarks(root),headBefore=git('rev-parse','HEAD').toString().trim();expect(before).not.toBeNull();const target=mode==='create-and-commit'?'new.txt':'main.txt';if(mode!=='commit-only-control')writeFileSync(join(root,target),'OWN_WRITTEN_DURING_OPERATION');if(mode!=='write-only-control'){git('add',target);git('commit','-qm','own operation')}
 const after=await snapshotMarks(root),headAfter=git('rev-parse','HEAD').toString().trim();expect(after).not.toBeNull();const changed=await changedSince(root,before!,after!);observations.push({mode,target,before:[...before!],after:[...after!],headBefore,headAfter,changed,actualContent:readFileSync(join(root,target),'utf8')});expect(changed).toEqual(mode==='commit-only-control'?[]:[target]);
 }finally{rmSync(root,{recursive:true,force:true})}});
