// ladder-info.ts — reads the generated model-ladder.ts (bench/modelladder long-context conversation results) for the
// model ranking prompt (settings-ui.ts) and the model update modal (model-update.ts).
import { MODEL_LADDER, MODEL_LADDER_DATE, type LadderResult } from './model-ladder.js';

const _ratio = (r: [number, number]) => `${r[0]}/${r[1]}`;
const _score = (r: LadderResult) => {
    const rounds = r.coding[1] + r.knowledge[1] + r.reasoning[1];
    return rounds ? (r.coding[0] + r.knowledge[0] + r.reasoning[0]) / rounds : 0;
};

// Best result over the given "provider|model" specs (one model is often served by several providers):
// highest share of rounds solved, then the longest context held.
export function bestLadder(specs: string[], table: Record<string, LadderResult> = MODEL_LADDER): LadderResult | null {
    let best: LadderResult | null = null;
    for (const s of specs) {
        const r = table[s];
        if (r && (!best || _score(r) > _score(best) || (_score(r) === _score(best) && Math.max(...r.capK) > Math.max(...best.capK)))) best = r;
    }
    return best;
}

// "long chats: coding 55/66 (held 250K), knowledge 60/66 (held 250K), reasoning 40/66 (held 180K)" (+ "; free tier stopped a chat: <reason>").
// One conversation per area; "held" is the largest prompt (K tokens) a task completed at in it, "(ceiling)" = the test ceiling, no provider limit hit.
export function formatLadder(r: LadderResult | null): string {
    if (!r) return '';
    const part = (name: string, d: [number, number], capK: number) => `${name} ${_ratio(d)} (held ${capK}K${capK >= r.ceilingK ? ', ceiling' : ''})`;
    const lim = r.limit ? `; free tier stopped a chat: ${r.limit.replace(/\s+/g, ' ').slice(0, 70)}` : '';
    return `long chats: ${part('coding', r.coding, r.capK[0])}, ${part('knowledge', r.knowledge, r.capK[1])}, ${part('reasoning', r.reasoning, r.capK[2])}${lim}`;
}

export { MODEL_LADDER_DATE };
