// fg-chat 2026-10-23: after a compaction the model re-asked for src/player.js and was answered "Already read … the full content is in your prior
// tool result" — the read the note pointed to had been summarised away. Compaction must drop the read-dedup state with the reads it removes.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _historyResult, resetSeenReadFiles } from '../history.ts';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'llm-loops.ts'), 'utf8');

describe('read dedup across a compaction', () => {
    it('_doCompact resets the seen-reads state, the repeat cache and the read ledger', () => {
        const body = src.slice(src.indexOf('async function _doCompact'), src.indexOf('convoLogTurn({ type: \'history_snapshot\''));
        expect(body).toMatch(/resetSeenReadFiles\(\)/);
        expect(body).toMatch(/_repeatCache\.clear\(\)/);
        expect(body).toMatch(/_readLedgers\.delete\(_repeatCache\)/);
    });
    it('a read repeated after resetSeenReadFiles() returns the content again', () => {
        resetSeenReadFiles();
        const read = () => _historyResult('read_file', { path: 'src/p.js', content: 'x'.repeat(50), start_line: 1, end_line: 5 } as any);
        const first: any = read();
        expect(first.content).toBeTruthy();
        expect((read() as any).note).toMatch(/Already read/);
        resetSeenReadFiles();
        expect((read() as any).content).toBeTruthy();
    });
});
