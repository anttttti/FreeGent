import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const src = (f: string) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

describe('browser-tour fixes', () => {
    it('CodeMirror basic-setup is pinned to a published version', () => {
        expect(src('editor.ts')).toContain('basic-setup@0.20.0');
        expect(src('editor.ts')).not.toContain('basic-setup@0.7');
    });
    it('tab selectors escape quotes and backslashes in file names', () => {
        const s = src('tabs.ts');
        expect(s).toContain('_attrEsc(key)');
        expect(s).not.toMatch(/\[data-panel="\$\{key\}"\]/);
    });
    it('the user message is persisted before the turn runs', () => {
        const s = src('agent-core.ts');
        const i = s.indexOf("_evtSess.append('user/message'");
        expect(s.slice(i, i + 500)).toContain('saveHistory()');
    });
    it('the click that focuses the input does not accept the ghost suggestion', () => {
        expect(src('init.ts')).toContain('_wasFocusedOnDown');
    });
});
