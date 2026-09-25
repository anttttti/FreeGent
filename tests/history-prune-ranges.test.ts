// history-prune-ranges.test.ts — duplicate-read pruning is range-aware: an earlier read_file result
// is stubbed only when a later read of the same file covers its line range with no write in
// between. Pruning every earlier read of a path left the model one range at a time, and it
// re-read two ranges alternately until the step limit (v0.55 SWE-bench Lite).
import { describe, it, expect } from 'vitest';
import { pruneOAIHistory, pruneSessionHistory } from '../history.ts';
import { Session } from '../session.ts';

const BIG = 'x'.repeat(900);   // above the 800-char pruning minimum
type Call = [name: string, args: any];

let _n = 0;
function oaiHistory(calls: Call[]): any[] {
    return calls.flatMap(([name, args]) => {
        const id = `c${++_n}`;
        return [
            { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
            { role: 'tool', tool_call_id: id, name, content: BIG },
        ];
    });
}
const prunedOAI = (calls: Call[]) => {
    const h = oaiHistory(calls);
    pruneOAIHistory(h);
    return h.filter(m => m.role === 'tool').map(m => m.content.startsWith('[pruned:'));
};
const prunedSession = (calls: Call[]) => {
    const sess = new Session({ id: `s${++_n}`, chatId: 'c' });
    sess.append('user/message', { role: 'user', content: 'task' }, { surfaceOp: 'append' });
    for (const m of oaiHistory(calls)) {
        if (m.role === 'assistant') sess.append('assistant/message', { turn: 0, step: 0, message: m }, { surfaceOp: 'append' });
        else sess.append('tool/result', { turn: 0, step: 0, callId: m.tool_call_id, name: m.name, content: m.content }, { surfaceOp: 'append' });
    }
    pruneSessionHistory(sess);
    return sess.deriveMessages().filter((m: any) => m.role === 'tool').map((m: any) => m.content.startsWith('[pruned:'));
};

const A = { path: 'f.py', start_line: 514, end_line: 572 };
const B = { path: 'f.py', start_line: 450, end_line: 513 };

describe.each([['pruneOAIHistory', prunedOAI], ['pruneSessionHistory', prunedSession]])('%s', (_name, pruned) => {
    it('keeps two different ranges of one file visible', () => {
        expect(pruned([['read_file', A], ['read_file', B]])).toEqual([false, false]);
    });

    it('A/B/A: only the repeated range is stubbed, so both ranges stay visible', () => {
        expect(pruned([['read_file', A], ['read_file', B], ['read_file', A]])).toEqual([true, false, false]);
    });

    it('a later wider or whole-file read covers an earlier narrow one', () => {
        expect(pruned([['read_file', A], ['read_file', { path: 'f.py', start_line: 400, end_line: 600 }]])).toEqual([true, false]);
        expect(pruned([['read_file', A], ['read_file', { path: 'f.py' }]])).toEqual([true, false]);
    });

    it('a later narrow read does not cover an earlier whole-file read', () => {
        expect(pruned([['read_file', { path: 'f.py' }], ['read_file', A]])).toEqual([false, false]);
    });

    it('a write between the reads keeps the earlier one', () => {
        expect(pruned([['read_file', A], ['write_file', { path: 'f.py' }], ['read_file', A]])).toEqual([false, false, false]);
    });

    it('reads of other files do not cover', () => {
        expect(pruned([['read_file', A], ['read_file', { ...A, path: 'g.py' }]])).toEqual([false, false]);
    });
});
