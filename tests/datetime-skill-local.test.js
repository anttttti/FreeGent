// The datetime skill says "local": its date, time and offset must all come from the device's local clock.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const W = window;

beforeAll(async () => {
    await import('../skills.ts');
    W.agentListFiles = async () => [];
    await W.loadSkills();
});
afterEach(() => vi.useRealTimers());

describe('datetime skill', () => {
    it('uses the local calendar day, not the UTC day', async () => {
        // 23:30 local on the 19th in a UTC+h zone is the 19th UTC-wise only in some zones; build it from local parts.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 9, 20, 0, 15));   // local 00:15 on 20 Oct: UTC is the 19th in any zone ahead of UTC
        const body = await W.skillsRegistry.get('datetime').body_fn();
        expect(body).toContain('2026-10-20 00:15 local');
    });
});
