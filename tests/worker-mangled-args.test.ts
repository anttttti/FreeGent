// run_workers arguments mangled from a python-style call (v0.57 fixes review §9): 59 of the 73
// "No workers specified" results in v0.57 had {"agents=[{id": "x", "role": …, "task": …}.
import { describe, it, expect } from 'vitest';
import { _agentsFromMangledArgs } from '../workers.ts';

describe('_agentsFromMangledArgs', () => {
    it('rebuilds the single agent, unquoting values', () => {
        expect(_agentsFromMangledArgs({ 'agents=[{id': 'investigator', role: 'researcher', task: 'Find where function-rgx is compiled.' }))
            .toEqual([{ id: 'investigator', role: 'researcher', task: 'Find where function-rgx is compiled.' }]);
        expect(_agentsFromMangledArgs({ 'agents=[{id': '"replan"', role: '"director"', task: '"Revise the plan."' }))
            .toEqual([{ id: 'replan', role: 'director', task: 'Revise the plan.' }]);
    });
    it('leaves other shapes alone', () => {
        expect(_agentsFromMangledArgs({})).toBeNull();
        expect(_agentsFromMangledArgs({ agents: [] })).toBeNull();
        expect(_agentsFromMangledArgs({ 'agents=[{id': 'x', role: 'coder' })).toBeNull();   // no task
    });
});
