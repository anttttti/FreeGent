import { describe, it, expect } from 'vitest';
import { _isComplete } from '../turn-protocol.js';

describe('review 2026-11-10: _isComplete', () => {
    it.each([
        'Two of the five migrations are done.',
        'The build has not completed',
        'I ran the tests; 3 still fail, so the fix is not done',
        'Next I will check what else needs to be done',
    ])('ordinary prose is not a terminal state: %s', t => expect(_isComplete(t)).toBe(false));
    it.each(['Helsinki. COMPLETED', '13\nCOMPLETED', 'COMPLETED. The answer is 13'])('protocol shapes still pass: %s', t => expect(_isComplete(t)).toBe(true));
});

import { repairHistoryArray } from '../history.js';
import { executeToolAsync } from '../tools.js';

describe('review 2026-11-10: tool results and apply_patch', () => {
    it('history repair leaves tags inside a tool result alone', () => {
        (globalThis as any)._stripThinking = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '');
        const content = 'a\n// <think>x</think>\nb = "<tool_call>{}</tool_call>"';
        const hist = [{ role: 'user', content: 'q' },
            { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: '1', content }];
        expect(repairHistoryArray(hist).find(m => m.role === 'tool')!.content).toBe(content);
    });
    it('apply_patch to a sensitive path is blocked like write_file', async () => {
        const viaArg = await executeToolAsync('apply_patch', { path: '.env', patch: '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n' });
        expect(JSON.stringify(viaArg)).toContain('Sensitive path');
        const viaHeader = await executeToolAsync('apply_patch', { patch: '--- a/.ssh/config\n+++ b/.ssh/config\n@@ -1 +1 @@\n-A\n+B\n' });
        expect(JSON.stringify(viaHeader)).toContain('Sensitive path');
    });
});
