// A soft stop ends the turn right after a step's tool results were recorded. The history repair that runs before the next
// turn removes a trailing tool exchange as orphaned, so the finished step used to vanish (TUI report cases 047-051, 072).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getChatHistory, setChatHistory } from '../chat-history.ts';
import { repairHistoryArray } from '../history.ts';

let _closeSoftStop: (t: string, sess?: any) => void;
beforeAll(async () => { ({ _closeSoftStop } = await import('../agent-core.ts') as any); });

const exchange = () => [
    { role: 'user', content: 'run the task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"stdout":"TOOL_DONE","exit_code":0}' },
];
beforeEach(() => setChatHistory([]));

describe('soft stop and the recorded step', () => {
    it('without the closing line (a hard stop) the repair keeps the finished step: its result is answered by the assistant message above it', () => {
        const repaired = repairHistoryArray(exchange());
        expect(repaired.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);    // it used to erase every trailing finished step (hermes C14)
    });
    it('several finished steps at the end of a hard-stopped turn all stay; an unanswered call at the end does not', () => {
        const h = [...exchange(), ...exchange().slice(1).map((m: any, i: number) => i === 0 ? { ...m, tool_calls: [{ ...m.tool_calls[0], id: 'c2' }] } : { ...m, tool_call_id: 'c2' }),
                   { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }];
        expect(repairHistoryArray(h).map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    });
    it('a soft stop after a tool step closes the exchange, and the repair keeps it', () => {
        setChatHistory(exchange());
        _closeSoftStop('*(break)*');
        const h = getChatHistory();
        expect(h.at(-1)?.role).toBe('assistant');
        expect(String(h.at(-1)?.content)).toMatch(/Stopped by the user after this step/);
        const repaired = repairHistoryArray(h);
        expect(repaired.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(repaired.some(m => m.role === 'tool' && String(m.content).includes('TOOL_DONE'))).toBe(true);
    });
    it('does nothing for a normal finish or when the history does not end on a tool result', () => {
        setChatHistory(exchange());
        _closeSoftStop('All done.');
        expect(getChatHistory().at(-1)?.role).toBe('tool');
        setChatHistory([{ role: 'user', content: 'x' }]);
        _closeSoftStop('*(break)*');
        expect(getChatHistory()).toHaveLength(1);
    });
});
