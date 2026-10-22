import {afterEach,afterAll,it,expect} from 'vitest';
import {forceSkillsNextTurn} from '../../turn-context.ts';
import {syncGuidanceMemory} from '../../skill-guidance.ts';
const W=window as any,observations:any[]=[],savedRegistry=[...W.skillsRegistry],savedActive=[...W.activeSkills];
afterEach(()=>{W.skillsRegistry.clear();for(const[k,v]of savedRegistry)W.skillsRegistry.set(k,v);W.activeSkills.clear();for(const n of savedActive)W.activeSkills.add(n);W.setCurrentTurnSkills(new Set())});
it.each(['keyword','alwaysOn','forced','workerRole'].flatMap(path=>[false,true].map(enabled=>({path,enabled}))))('$path honors optional skill prerequisite=$enabled',c=>{
 localStorage.clear();localStorage.setItem('fg_own_guidance_enabled',String(c.enabled));W.clearMainAgentRole();W.skillsRegistry.clear();W.activeSkills.clear();W.setCurrentTurnSkills(new Set());syncGuidanceMemory('own-prereq-'+c.path+c.enabled,0,[]);
 const name='own-optional-guidance',body='OWN_OPTIONAL_GUIDANCE_BODY',skill={name,description:'Own optional instructions',body,type:'skill',trigger:'ownkeyword',requires:'fg_own_guidance_enabled',roles:'own-role'};W.skillsRegistry.set(name,skill);
 let prompt='';if(c.path==='alwaysOn'){W.activeSkills.add(name);prompt=W.buildSystemPrompt()}else if(c.path==='workerRole'){prompt=W.buildWorkerSystemPrompt({name:'own-role',body:'OWN_ROLE_BODY',tools:[]})}else{if(c.path==='forced')forceSkillsNextTurn([name]);W.applyTurnTriggers({rawText:c.path==='keyword'?'ownkeyword':'hello',history:[],wsPaths:[]});prompt=W.buildTriggeredGuidance()}
 const included=prompt.includes(body);observations.push({...c,prerequisite:localStorage.getItem(skill.requires),included,currentTurnSkills:[...W.currentTurnSkills],prompt});expect(included).toBe(c.enabled);
});
