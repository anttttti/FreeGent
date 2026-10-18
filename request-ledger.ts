// request-ledger.ts — one line per model request of a task, for runs that set FG_REQUEST_LEDGER.
//
// The run totals (input/output, workers, auxiliary, discarded, cached) answer "how much"; this answers
// "which request": purpose, size, cached share, whether it was kept. Records are the ones the loop already
// sends to the metrics writer, so nothing new is measured and nothing is estimated: a field the server did
// not report is absent, not zero.
import { appendFileSync } from 'node:fs';

interface LedgerLine { ts: string; purpose: string; promptTokens?: number; responseTokens?: number; cachedTokens?: number; kept: boolean; step?: number }

const PURPOSE: Record<string, string> = {
    worker_step: 'worker', validation: 'validation', compaction: 'compaction', cut_off: 'discarded', request_failed: 'failed',
};

/** The ledger line for one metrics record, or null for records that are not requests (snapshots, summaries). */
export function ledgerLine(record: any, now: () => string = () => new Date().toISOString()): LedgerLine | null {
    if (!record || typeof record !== 'object') return null;
    if (record.type === 'history_snapshot' || record.type === 'history_final') return null;
    const purpose = record.type ? (PURPOSE[record.type] ?? null) : 'main';
    if (!purpose) return null;
    const line: LedgerLine = { ts: now(), purpose, kept: purpose !== 'discarded' && purpose !== 'failed' };
    if (typeof record.promptTokens === 'number') line.promptTokens = record.promptTokens;
    if (typeof record.responseTokens === 'number') line.responseTokens = record.responseTokens;
    if (typeof record.cachedTokens === 'number' && record.cachedTokens > 0) line.cachedTokens = record.cachedTokens;
    if (purpose === 'main' && typeof record.step === 'number') line.step = record.step;
    return line;
}

export function appendLedger(path: string | undefined, record: any): void {
    if (!path) return;
    const line = ledgerLine(record);
    if (!line) return;
    try { appendFileSync(path, JSON.stringify(line) + '\n'); } catch { /* the ledger must never break a run */ }
}
