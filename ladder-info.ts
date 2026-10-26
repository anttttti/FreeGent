// ladder-info.ts — reads the generated model-ladder.ts (long-context conversation results of the model ladder) for the
// model ranking prompt (settings-ui.ts) and the model update modal (model-update.ts).
import { MODEL_LADDER, MODEL_LADDER_DATE, type LadderResult } from './model-ladder.js';

const _acc = (r: LadderResult) => (r.attempted ? r.correct / r.attempted : 0);

// Best result over the given "provider|model" specs (one model is often served by several providers):
// highest share of microtasks solved, then the largest context held.
export function bestLadder(specs: string[], table: Record<string, LadderResult> = MODEL_LADDER): LadderResult | null {
    let best: LadderResult | null = null;
    for (const s of specs) {
        const r = table[s];
        if (r && (!best || _acc(r) > _acc(best) || (_acc(r) === _acc(best) && Math.max(...r.capK, 0) > Math.max(...best.capK, 0)))) best = r;
    }
    return best;
}

// "long chats: 182/195 microtasks solved, held 250K/250K tokens (test ceiling), 41 tok/s"
// held = largest prompt a task completed at, per conversation (10K / 20K / 50K starts; a cap ends the test, so later ones may be missing);
// a stop other than the test ceiling (free-tier quota, context limit) is named.
export function formatLadder(r: LadderResult | null): string {
    if (!r) return '';
    const caps = r.capK.map(k => `${k}K`).join('/') || 'n/a';
    const other = [...new Set(r.stops.filter(s => s !== 'ceiling'))];
    const stop = other.length ? `; a chat was ended by the free tier's ${other.map(s => s === 'quota' ? 'quota' : s === 'context' ? 'context limit' : 'limit').join(' and ')}` : ' (test ceiling)';
    return `long chats: ${r.correct}/${r.attempted} microtasks solved, held ${caps} tokens${stop}${r.tokPerS != null ? `, ${r.tokPerS} tok/s` : ''}`;
}

export { MODEL_LADDER_DATE };
