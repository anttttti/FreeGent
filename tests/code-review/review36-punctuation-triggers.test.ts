import {afterAll,it,expect} from 'vitest';
import {evaluateSkillTriggers} from '../../skill-guidance.ts';
const observations:any[]=[];
it.each([{keyword:'debug',text:'Please debug this function.',expected:true},{keyword:'sql',text:'Please explain mysql behavior.',expected:false},{keyword:'c++',text:'Please review this C++ function.',expected:true},{keyword:'c#',text:'Please review this C# function.',expected:true},{keyword:'.net',text:'Please review this .NET service.',expected:true}])('literal trigger $keyword in $text',c=>{
 const name='own-literal-trigger',skill={name,trigger:c.keyword,body:'OWN_LANGUAGE_GUIDANCE'},registry=new Map([[name,skill]]),inputs={roleName:null,lowerText:c.text.toLowerCase(),rawText:c.text,firstMsg:false,isTaskCompletion:false,turn:2,wsExts:new Set(),wsNames:new Set(),wsAllPaths:new Set(),msgMedia:new Set(),histTools:new Set()};
 const keywords=evaluateSkillTriggers(registry,new Set(),inputs);
 // The explicitly regex-based trigger is a control/workaround: no application source is changed.
 const patternSkill={name,trigger_on_message_pattern:c.keyword.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),body:skill.body};
 const pattern=evaluateSkillTriggers(new Map([[name,patternSkill]]),new Set(),inputs);
 observations.push({...c,keywords:[...keywords],pattern:[...pattern]});expect(keywords.has(name)).toBe(c.expected);if(c.expected)expect(pattern.has(name)).toBe(true);
});
