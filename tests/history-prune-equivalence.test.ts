// The array pruner and the Session pruner are two implementations of one rule (history.ts). Until
// the legacy history is retired (task 065) they must agree exactly: same saved characters, same
// stub text on the same results.
import { describe, it, expect } from 'vitest';
import { pruneOAIHistory, pruneSessionHistory } from '../history.ts';
import { Session } from '../session.ts';

const BIG = 'x'.repeat(900);
type Call = [name: string, args: any, content?: string];
let _n = 0;
const messages = (calls: Call[]) => calls.flatMap(([name, args, content]) => {
    const id = `eq${++_n}`;
    return [
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: id, name, content: content ?? BIG },
    ];
});

function runBoth(calls: Call[]) {
    const arr = messages(calls);
    const savedArr = pruneOAIHistory(arr);
    const sess = new Session({ id: `eqs${++_n}`, chatId: 'c' });
    for (const m of messages(calls).map((m: any, i) => ({ ...m, ...(m.tool_calls ? { tool_calls: arr[i].tool_calls } : { tool_call_id: arr[i].tool_call_id }) }))) {
        if (m.role === 'assistant') sess.append('assistant/message', { turn: 0, step: 0, message: m }, { surfaceOp: 'append' });
        else sess.append('tool/result', { turn: 0, step: 0, callId: m.tool_call_id, name: m.name, content: m.content }, { surfaceOp: 'append' });
    }
    const savedSess = pruneSessionHistory(sess);
    const contents = (h: any[]) => h.filter(m => m.role === 'tool').map(m => m.content);
    return { savedArr, savedSess, arr: contents(arr), sess: contents(sess.deriveMessages() as any[]) };
}

const A = { path: 'f.py', start_line: 10, end_line: 60 };
const B = { path: 'f.py', start_line: 1, end_line: 9 };

describe('pruneOAIHistory and pruneSessionHistory agree', () => {
    const fixtures: Record<string, Call[]> = {
        'repeat of one range': [['read_file', A], ['read_file', A]],
        'A/B/A': [['read_file', A], ['read_file', B], ['read_file', A]],
        'wider later read': [['read_file', A], ['read_file', { path: 'f.py', start_line: 1, end_line: 100 }]],
        'write between reads': [['read_file', A], ['write_file', { path: 'f.py', content: 'y' }, '{"ok":true}'], ['read_file', A]],
        'two files': [['read_file', { path: 'a.py' }], ['read_file', { path: 'b.py' }], ['read_file', { path: 'a.py' }], ['read_file', { path: 'b.py' }]],
        'small results are never pruned': [['read_file', A, 'small'], ['read_file', A, 'small']],
        'nothing to prune': [['read_file', A], ['list_files', {}, BIG]],
    };
    for (const [name, calls] of Object.entries(fixtures)) {
        it(name, () => {
            const r = runBoth(calls);
            expect(r.savedSess).toBe(r.savedArr);
            expect(r.sess).toEqual(r.arr);
        });
    }
    it('actually prunes something in the repeated-range fixture (the comparison is not vacuous)', () => {
        const r = runBoth(fixtures['repeat of one range']);
        expect(r.savedArr).toBeGreaterThan(0);
        expect(r.arr[0]).toMatch(/^\[pruned:/);
    });
});
