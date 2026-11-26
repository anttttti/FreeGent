// flush() returns only when nothing is queued and nothing is being written (Sol 6.2 review of dbca1d1: a timer drain that took the next batch
// while flush waited was still writing it when flush returned, and the headless CLI could exit first).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistence } from '../session-persistence.ts';

describe('SessionPersistence.flush', () => {
    it('waits for a batch a concurrent drain took while it was waiting', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sp-'));
        const sp: any = new SessionPersistence(dir, 10_000);
        const ev = (seq: number) => ({ type: 'tool/result', seq, time: seq, data: { n: seq } });
        sp.enqueue('s1', ev(1));
        const first = sp._drain();                 // a drain is writing batch 1
        sp.enqueue('s1', ev(2));                   // batch 2 queued meanwhile
        const timerDrain = sp._drain();            // the timer's drain waits for batch 1, then takes batch 2
        await sp.flush();                          // flush must not return before batch 2 is on disk
        const lines = readFileSync(join(dir, 's1.jsonl'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        await Promise.all([first, timerDrain]);
    });
});
