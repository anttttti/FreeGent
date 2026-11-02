// codex R307: a project merge used whatever base text was stored last for a path, which a later export replaces. The base counts only
// when it is the one the incoming copy started from, or the copy is unchanged since.
import { describe, it, expect } from 'vitest';
import { projectBaseFits } from '../workspace.ts';
import { sha256Hex } from '../cloud-sync.ts';

const h = (s: string) => sha256Hex(new TextEncoder().encode(s));

describe('project merge base', () => {
    it('is the stored base when the copy names it as its starting point', async () => {
        expect(await projectBaseFits('v1', { content: 'v1 edited elsewhere', base: await h('v1') })).toBe(true);
    });
    it('is not a later export\'s base that the older copy never saw', async () => {
        expect(await projectBaseFits('v3 exported later', { content: 'v1 edited elsewhere', base: await h('v1') })).toBe(false);
        expect(await projectBaseFits('v3 exported later', { content: 'v1 edited elsewhere' })).toBe(false);   // an export from before this field
    });
    it('is the stored base when it is the content this copy was exported with (the copy was edited afterwards)', async () => {
        expect(await projectBaseFits('v1', { content: 'v1 edited', exported: await h('v1'), base: await h('v0') })).toBe(true);
    });
    it('is the stored base when the copy is that base unchanged', async () => {
        expect(await projectBaseFits('v1', { content: 'v1' })).toBe(true);
    });
});
