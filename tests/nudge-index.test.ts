// docs/harness/nudges.md lists every nudge and completion gate by name; a new one must be added (node scripts/nudge-index.mjs --update)
// and described (WHEN in the script). The names are what turn logs, sim checks (nudge_min / nudge_absent) and harness reports use.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectNudges, WHEN } from '../scripts/nudge-index.mjs';

describe('nudge index', () => {
    const items = collectNudges();
    it('finds the nudges of the main loop, the worker loop and the completion gates', () => {
        const names = items.map((i: any) => i.name);
        for (const n of ['tool_failure', 'stuck_detected', 'rewrite_loop', 'worker_stuck', 'scratch_only_edits', 'invented_data']) expect(names, n).toContain(n);
        expect(items.find((i: any) => i.name === 'invented_data').kind).toBe('gate');
    });
    it('every name is described and listed in docs/harness/nudges.md, and the doc lists no name that is gone', () => {
        const md = readFileSync(`${process.cwd()}/docs/harness/nudges.md`, 'utf8');
        const listed = new Set([...md.matchAll(/^\| `([a-z_0-9]+)` \|/gm)].map(m => m[1]));
        const want = new Set(items.map((i: any) => i.name));
        expect([...want].filter(n => !WHEN[n as string]), 'missing from WHEN').toEqual([]);
        expect([...want].filter(n => !listed.has(n as string)), 'missing from the doc: run node scripts/nudge-index.mjs --update').toEqual([]);
        expect([...listed].filter(n => !want.has(n)), 'listed but gone').toEqual([]);
    });
});
