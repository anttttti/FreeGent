// The badge labels tools.ts writes (toolLabel) must be words friendlyLabel knows (AG-C01: context7, academic and package searches fell through to raw text).
import { describe, it, expect, beforeAll } from 'vitest';
import { friendlyLabel } from '../step-label.ts';

let toolLabel: any;
beforeAll(async () => { ({ toolLabel } = await import('../tools.ts')); });

describe('friendlyLabel of toolLabel output', () => {
    it('names the lookups, instead of showing their raw prefix', () => {
        const cases: [string, any, string][] = [['context7_docs', { library: 'react' }, 'Looking up docs'], ['academic_search', { query: 'attention' }, 'Researching'],
            ['package_search', { query: 'vitest' }, 'Looking up packages'], ['web_search', { query: 'x' }, 'Searching']];
        for (const [name, args, want] of cases) expect(friendlyLabel(toolLabel(name, args)), name).toBe(want);
    });
    it('a worker role has one label in both badge formats (hermes §3)', () => {
        expect(friendlyLabel('worker:W1:researcher')).toBe('Researching');
        expect(friendlyLabel('workers(a:researcher,b:coder)')).toBe('Researching');
        expect(friendlyLabel('workers(a:config-read)')).toBe('Reading config');   // the second ladder lacked the special cases
        expect(friendlyLabel('workers(a:zebra)')).toBe('Delegating');
        expect(friendlyLabel('worker:W1:zebra_role')).toBe('Zebra Role');
    });
});
