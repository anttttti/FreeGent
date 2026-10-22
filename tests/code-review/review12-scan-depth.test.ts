import {it,expect,afterAll} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listFiles,snapshotMarks} from '../../workspace-scan.ts';
const observations:any[]=[];
it.each([3,10])('depth%s scan is complete or explicitly reports incompleteness',async depth=>{const root=mkdtempSync(join(tmpdir(),'fg-review12-depth-'));try{writeFileSync(join(root,'shallow.txt'),'OWN_SHALLOW');const folder=Array.from({length:depth},(_,i)=>'level'+i).join('/'),deep=folder+'/receipt.txt';mkdirSync(join(root,folder),{recursive:true});writeFileSync(join(root,deep),'OWN_DEEP');const listed=await listFiles(root,{maxEntries:100,deadlineMs:5000}),marks=await snapshotMarks(root);observations.push({depth,deep,listed,marks:marks?[...marks]:null});expect(!listed.complete||listed.files.includes(deep)).toBe(true);expect(marks===null||marks.has(deep)).toBe(true)}finally{rmSync(root,{recursive:true,force:true})}});
