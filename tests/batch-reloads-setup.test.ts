import { describe, it, expect, beforeAll } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// codex R397: a project merge or checkpoint restore wrote AGENTS.md, roles and skills without reloading them.
const W = window as any;
beforeAll(async () => { W.indexedDB = new IDBFactory(); W.IDBKeyRange = IDBKeyRange; await import('../workspace.ts'); });

describe('applyWorkspaceBatch', () => {
    it('reloads the instructions, roles and skills once each when the batch touched them, in either root', async () => {
        const calls: string[] = [];
        W.loadAgentsContext = () => calls.push('agents'); W.loadRoles = () => calls.push('roles'); W.loadSkills = () => calls.push('skills');
        await W.applyWorkspaceBatch([
            { name: 'AGENTS.md', content: 'a' }, { name: 'roles/x.md', content: 'r' }, { name: 'roles/y.md', content: 'r' },
            { name: 'local/skills/s/SKILL.md', content: 's' }, { name: 'src/app.js', content: 'c' },
        ], []);
        expect(calls.sort()).toEqual(['agents', 'roles', 'skills']);
        calls.length = 0;
        await W.applyWorkspaceBatch([{ name: 'src/only.js', content: 'c' }], []);
        expect(calls).toEqual([]);
    });
});
