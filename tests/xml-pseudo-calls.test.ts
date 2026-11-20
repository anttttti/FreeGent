// codex R537: a tool tag quoted as an example in prose is not a call.
import { describe, it, expect } from 'vitest';
import { _repairXmlPseudoCalls, _repairLongcatPseudoCalls } from '../tool-call-repair.ts';

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
    it('ignores a quoted tag in every context the table of the round-6 note lists (K021), for the XML and the Longcat forms', () => {
        const xml = '<read_file>{"path":"a.js"}</read_file>', longcat = '<longcat_tool_call>read_file\n<longcat_arg_key>path</longcat_arg_key>\n<longcat_arg_value>a.js</longcat_arg_value>\n</longcat_tool_call>';
        const quoted = (c: string) => [`~~~\n${c}\n~~~`, `\`\`\`\n${c}\n\`\`\``, `\`\`\n${c}\n\`\``, `> ${c}`, `| ${c} |`, `\`\`\`xml\n${c}`, `\`${c}\``, `\`\`${c}\`\``];
        for (const c of quoted(xml)) expect(_repairXmlPseudoCalls('The page says:\n' + c, names), c).toBeNull();
        for (const c of quoted(longcat)) expect(_repairLongcatPseudoCalls('The page says:\n' + c, names), c).toBeNull();
        // the calls themselves still run, bare and with a pretty-printed (indented) body
        expect(_repairLongcatPseudoCalls('Let me read it.\n' + longcat, names)).toEqual([{ name: 'read_file', args: { path: 'a.js' } }]);
        expect(_repairXmlPseudoCalls('<read_file>{\n    "path": "a.js"\n}</read_file>', names)).toHaveLength(1);
    });
});
