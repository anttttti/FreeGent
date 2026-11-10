import { describe, it, expect, beforeAll } from 'vitest';
import { ALL_TOOL_NAMES, OPT_IN_TOOLS, FILE_WRITE_TOOLS, WORKSPACE_WRITE_TOOLS, MAY_WRITE_TOOLS, CONTENT_ARG_TOOLS, PATH_ARG_TOOLS } from '../tool-effects.ts';

// A tool is one row in tool-effects.ts; the lists other modules used to keep by hand are derived from it.
describe('tool table', () => {
    beforeAll(async () => { await import('../tool-schemas.ts'); await import('../config.ts'); });
    it('every list is made of tools that exist, and the opt-in set is a subset', () => {
        const all = new Set(ALL_TOOL_NAMES);
        expect(all.size).toBe(ALL_TOOL_NAMES.length);
        for (const list of [OPT_IN_TOOLS, FILE_WRITE_TOOLS, WORKSPACE_WRITE_TOOLS, MAY_WRITE_TOOLS, CONTENT_ARG_TOOLS, PATH_ARG_TOOLS])
            for (const n of list) expect(all.has(n), n).toBe(true);
    });
    it('keeps the write sets nested: file writes ⊂ workspace writes ⊂ may-write', () => {
        for (const n of FILE_WRITE_TOOLS) expect(WORKSPACE_WRITE_TOOLS).toContain(n);
        for (const n of WORKSPACE_WRITE_TOOLS) expect(MAY_WRITE_TOOLS).toContain(n);
        expect(WORKSPACE_WRITE_TOOLS).toContain('undo_write');
        expect(FILE_WRITE_TOOLS).not.toContain('undo_write');
    });
    it('config and the pseudo-call list read the table, not copies of it', async () => {
        const W = window as any;
        expect(W.ALL_TOOL_NAMES ?? ALL_TOOL_NAMES).toEqual(ALL_TOOL_NAMES);
        const { AGENT_TOOL_NAMES } = await import('../step-validator.ts');
        expect(AGENT_TOOL_NAMES).toBe(ALL_TOOL_NAMES);
        const { enabledTools } = await import('../config.ts');
        for (const n of OPT_IN_TOOLS) expect(enabledTools.has(n), n).toBe(false);
    });
    it('every tool the model is sent a schema for is in the table', async () => {
        const { buildOAITools } = await import('../tool-schemas.ts');
        const sent = buildOAITools(false, new Set(ALL_TOOL_NAMES)).map((t: any) => t.function.name);
        expect(sent.length).toBeGreaterThan(5);
        for (const n of sent) expect(ALL_TOOL_NAMES, n).toContain(n);
    });
});
