// FG_DISABLE_GUARDS: single review guards can be turned off for an A/B run; off by default.
import { describe, it, expect, afterEach } from 'vitest';
import { runtime, REVIEW_GUARDS } from '../runtime.ts';
import { runCompletionGates } from '../completion-gates.ts';
import { isNegativeProbe, _normCode } from '../detectors.ts';

afterEach(() => { delete process.env.FG_DISABLE_GUARDS; });

describe('guardOff', () => {
    it('is off unless set; accepts names and the review set', () => {
        expect(REVIEW_GUARDS.every(n => !runtime.guardOff(n))).toBe(true);
        process.env.FG_DISABLE_GUARDS = 'invented_data, replace_region';
        expect(runtime.guardOff('invented_data')).toBe(true);
        expect(runtime.guardOff('replace_region')).toBe(true);
        expect(runtime.guardOff('no_edit_complete')).toBe(false);
        process.env.FG_DISABLE_GUARDS = 'review';
        expect(REVIEW_GUARDS.every(n => runtime.guardOff(n))).toBe(true);
        expect(runtime.guardOff('scratch_only_edits')).toBe(false);   // older guards stay
    });
    it('really disables a completion gate, a probe rule and the call normalisation', async () => {
        const c: any = { text: 'Done.\nCOMPLETED', step: 3, loopMax: 20, softStopPending: false, ps: {}, workflowMode: true,
            editedPaths: new Set(), shellWrites: new Set(), editsThisRun: false, editEvents: 0, verdict: 'no_change',
            reactiveFired: new Set(), firstUserText: '', task: 'Fix it.', editRequired: true, gradedTestIds: () => [],
            isScratchPath: () => false, envConfigEdits: async () => [] };
        expect((await runCompletionGates({ ...c, ps: {} }))?.name).toBe('no_edit_complete');
        process.env.FG_DISABLE_GUARDS = 'review';
        expect(await runCompletionGates({ ...c, ps: {} })).toBeNull();
        expect(isNegativeProbe({ code: 'grep x f', language: 'bash' }, { exit_code: 1, stdout: '' })).toBe(false);
        expect(_normCode('# c\nls')).toBe('# c\nls');
        delete process.env.FG_DISABLE_GUARDS;
        expect(isNegativeProbe({ code: 'grep x f', language: 'bash' }, { exit_code: 1, stdout: '' })).toBe(true);
        expect(_normCode('# c\nls')).toBe('ls');
    });
});
