import {afterAll,it,expect} from 'vitest';
import * as Store from '../../tui-store.ts';
import {userMessages} from '../../tui-input-history.ts';
import {stripInjected} from '../../history-util.ts';
import {_stripTerminal} from '../../turn-protocol.ts';
const observations:any[]=[];
it.each(['ordinary','nudge','legacy-fntag','compacted'])('restored %s history keeps the human request as its turn origin',kind=>{
 Store.replaceEntries([]);Store.setNextTurnOrigin(null);const user={role:'user',content:'OWN_REQUEST'},answer={role:'assistant',content:'OWN_ANSWER'},summary={role:'user',content:'[SYSTEM: The conversation history above has been compacted. The following is a read-only summary of what was discussed and accomplished — it is NOT a new request from the user. Continue the work based on this context.]\n\nOWN_SUMMARY\n\nOWN_FACTS'};
 const history=kind==='ordinary'?[user,answer]:kind==='nudge'?[user,{role:'user',content:'<nudge>Own continue</nudge>'},answer]:kind==='legacy-fntag'?[user,{role:'user',content:'<tool_response>\n<tool_name>list_files</tool_name>\n<result>OWN_FILES</result>\n</tool_response>'},answer]:[{role:'user',content:'[TASK — do not lose track of this]\nOWN_REQUEST'},summary,{role:'user',content:'[SYSTEM: Continue where you left off.]'},answer];
 const typed=userMessages(history),entries=Store.entriesFromHistory(history,{user:stripInjected,answer:_stripTerminal});Store.replaceEntries(entries);const visible=entries.filter(e=>e.type==='user').map((e:any)=>e.text),origin=Store.lastOriginTurn()?.origin;
 observations.push({kind,history,typed,visible,origin,entries});expect(typed).toEqual(['OWN_REQUEST']);expect(visible).toEqual(typed);expect(origin?.text).toBe('OWN_REQUEST');
});
