// codex R537: a tool tag quoted as an example in prose is not a call.
import { describe, it, expect } from 'vitest';
import { _repairXmlPseudoCalls } from '../tool-call-repair.ts';

const names = ['read_file', 'delete_file'];

describe('_repairXmlPseudoCalls', () => {
    it('still reads a call written as the whole reply', () => {
        expect(_repairXmlPseudoCalls('<read_file>{"path":"a.js"}</read_file>', names)).toEqual([{ name: 'read_file', args: { path: 'a.js' } }]);
        expect(_repairXmlPseudoCalls('Let me look.\n<read_file>{"path":"a.js"}</read_file>', names)).toHaveLength(1);
    });
    it('ignores a tag shown in a code fence or in inline code', () => {
        expect(_repairXmlPseudoCalls('To delete a file send:\n```xml\n<delete_file>{"path":"a.js"}</delete_file>\n```', names)).toBeNull();
        expect(_repairXmlPseudoCalls('The form is `<delete_file>{"path":"a.js"}</delete_file>`, do not use it here.', names)).toBeNull();
    });
});
