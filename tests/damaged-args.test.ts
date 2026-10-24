// Arguments whose names carry the model's call syntax (vLLM's Gemma parser: path:<|"|>tools.ts<|"|>,start_line:402) are reported as bad args.
import { describe, it, expect, beforeAll } from 'vitest';
let R: any;
beforeAll(async () => { R = await import('../tool-call-repair.ts'); });
const call = (name: string, args: any) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

describe('repairAllToolCalls: damaged argument names', () => {
    it('lists a call whose argument name holds a <|"|> marker, and only that call', () => {
        const { bad } = R.repairAllToolCalls([
            call('replace_in_file', { end_line: 430, new_string: 'x', 'tools.ts<|"|>,start_line': '402' }),
            call('read_file', { path: 'a.ts' }),
        ]);
        expect(bad).toEqual(['replace_in_file']);
    });
    it('a normal call, and a value that merely contains the marker, are not reported', () => {
        const { bad } = R.repairAllToolCalls([call('write_file', { path: 'notes.md', content: 'the Gemma token <|"|> appears in this text' })]);
        expect(bad).toEqual([]);
    });
});
