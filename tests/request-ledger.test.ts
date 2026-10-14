import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerLine, appendLedger } from '../request-ledger.ts';

const t = () => '2026-10-14T00:00:00.000Z';
describe('ledgerLine', () => {
    it('labels main steps, workers, validation, compaction, discarded and failed requests', () => {
        expect(ledgerLine({ step: 3, promptTokens: 900, responseTokens: 40, cachedTokens: 700 }, t)).toEqual({ ts: t(), purpose: 'main', kept: true, promptTokens: 900, responseTokens: 40, cachedTokens: 700, step: 3 });
        expect(ledgerLine({ type: 'worker_step', promptTokens: 500, responseTokens: 20 }, t)?.purpose).toBe('worker');
        expect(ledgerLine({ type: 'validation', promptTokens: 80 }, t)?.purpose).toBe('validation');
        expect(ledgerLine({ type: 'compaction', promptTokens: 40000 }, t)?.purpose).toBe('compaction');
        expect(ledgerLine({ type: 'cut_off', responseTokens: 2000 }, t)).toMatchObject({ purpose: 'discarded', kept: false, responseTokens: 2000 });
        expect(ledgerLine({ type: 'request_failed' }, t)).toMatchObject({ purpose: 'failed', kept: false });
    });
    it('ignores records that are not requests and omits fields the server did not report', () => {
        expect(ledgerLine({ type: 'history_snapshot' }, t)).toBeNull();
        expect(ledgerLine(null, t)).toBeNull();
        expect(ledgerLine({ step: 1, promptTokens: 10, cachedTokens: 0 }, t)).not.toHaveProperty('cachedTokens');
    });
});

describe('appendLedger', () => {
    it('writes one JSON line per request and does nothing without a path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
        const f = join(dir, 'l.jsonl');
        appendLedger(undefined, { step: 1, promptTokens: 1 });
        appendLedger(f, { step: 1, promptTokens: 10, responseTokens: 2 });
        appendLedger(f, { type: 'worker_step', promptTokens: 7 });
        const lines = readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines.map(l => l.purpose)).toEqual(['main', 'worker']);
        rmSync(dir, { recursive: true, force: true });
    });
});
