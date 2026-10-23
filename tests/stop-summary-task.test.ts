import { _stopSummaryTask } from '../llm-loops.ts';

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });

describe('_stopSummaryTask: what a forced stop is told the task is', () => {
    it('a single message is the task, as before', () => {
        expect(_stopSummaryTask([u('Fix the bug in foo.py')])).toBe('Fix the bug in foo.py');
    });
    it('in a longer chat the latest user message follows the first (fg-chat 2026-10-23: a step-limit stop answered "Yes" to the first message)', () => {
        const t = _stopSummaryTask([u('Do you see this link? Say yes or no'), a('Yes'), u('Get all the Sonic physics from there and apply them'), a('...'), u('<nudge>fix errors</nudge>'), u('<tool_response>x</tool_response>')]);
        expect(t).toContain('Do you see this link');
        expect(t).toContain("latest message:\nGet all the Sonic physics");
        expect(t).not.toContain('nudge');
    });
    it('skips the compaction note, the task pin and injected guidance blocks', () => {
        const t = _stopSummaryTask([
            u('[TASK — do not lose track of this]\nBuild the thing'),
            u('[SYSTEM: The conversation history above has been compacted. Summary…]'),
            u('~~~guidance\nrules\n~~~\n\nContinue the work on level 2'),
        ]);
        expect(t).toContain('Build the thing');
        expect(t).toContain('Continue the work on level 2');
        expect(t).not.toContain('compacted');
        expect(t).not.toContain('rules');
    });
});
