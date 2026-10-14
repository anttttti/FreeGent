// A task-level worker budget (headless only): v0.70 xarray-7229 / django-12663 / xarray-4094 spent 176-210
// worker steps each and none was resolved.
import { describe, it, expect, afterEach } from 'vitest';
import { workerStepLimit, WORKER_STEP_LIMIT_DEFAULT, workerStepsUsed, resetWorkerBudget, workerInputLimit, WORKER_INPUT_LIMIT_DEFAULT, workerInputUsed } from '../workers.ts';

afterEach(() => { delete (process.env as any).FREEGENT_WORKER_STEP_LIMIT; delete (process.env as any).FREEGENT_WORKER_INPUT_TOKEN_LIMIT; resetWorkerBudget(); });

describe('worker step limit', () => {
    it('defaults to 150 and can be set or turned off from the environment', () => {
        expect(workerStepLimit()).toBe(WORKER_STEP_LIMIT_DEFAULT);
        process.env.FREEGENT_WORKER_STEP_LIMIT = '40';
        expect(workerStepLimit()).toBe(40);
        process.env.FREEGENT_WORKER_STEP_LIMIT = '0';
        expect(workerStepLimit()).toBe(0);
        process.env.FREEGENT_WORKER_STEP_LIMIT = 'x';
        expect(workerStepLimit()).toBe(WORKER_STEP_LIMIT_DEFAULT);
    });
    it('starts at zero after a reset', () => {
        expect(workerStepsUsed()).toBe(0);
    });
    it('has an input-token limit with the same override', () => {
        expect(workerInputLimit()).toBe(WORKER_INPUT_LIMIT_DEFAULT);
        process.env.FREEGENT_WORKER_INPUT_TOKEN_LIMIT = '500000';
        expect(workerInputLimit()).toBe(500000);
        process.env.FREEGENT_WORKER_INPUT_TOKEN_LIMIT = '0';
        expect(workerInputLimit()).toBe(0);
        expect(workerInputUsed()).toBe(0);
    });
});
