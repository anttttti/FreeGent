// Settings → Model Priority ranking: models are grouped by canonical id across providers and ranked
// as one entry each (settings-ui.ts buildModelRankGroups / formatModelRankLine, config.ts canonicalModelId).
import { describe, it, expect, beforeAll } from 'vitest';

const W = window as any;
let M: any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    M = await import('../settings-ui.ts');
});

const e = (provider: string, model: string, extra: any = {}) =>
    ({ provider, model, label: model, released: '2025-01', contextK: 128, params: null, media: ['text'], tools: false, thinking: false, note: '', ...extra });

describe('canonicalModelId', () => {
    it('maps provider-specific ids of one model to the same id', () => {
        const ids = ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nemotron-3-ultra-550b-a55b-free'];
        expect(new Set(ids.map(W.canonicalModelId))).toEqual(new Set(['nemotron-3-ultra-550b-a55b']));
        expect(W.canonicalModelId('stepfun-ai/step-3.7-flash')).toBe(W.canonicalModelId('stepfun/step-3.7-flash:free'));
        expect(W.canonicalModelId('poolside/laguna-s-2.1-free')).toBe('laguna-s-2.1');
        expect(W.canonicalModelId('gemma-4-31b-it')).toBe(W.canonicalModelId('google/gemma-4-31b-it:free'));
    });
});

describe('parseParamsB', () => {
    it('reads total/active counts from descriptions and ids', () => {
        expect(M.parseParamsB('with 55B active parameters out of 550B total (MoE)', 'x')).toEqual({ total: 550, active: 55 });
        expect(M.parseParamsB('a 118B total parameter model with 8B active', 'x')).toEqual({ total: 118, active: 8 });
        expect(M.parseParamsB('', 'nvidia/nemotron-3-super-120b-a12b')).toEqual({ total: 120, active: 12 });
        expect(M.parseParamsB('', 'qwen/qwen3.8-27b')).toEqual({ total: 27, active: null });
        expect(M.parseParamsB('', 'deepseek/deepseek-v4-flash')).toEqual({ total: null, active: null });
    });
});

describe('buildModelRankGroups', () => {
    const catalog = [
        e('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', { tools: true, released: '2026-06' }),
        e('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', { tools: true }),
        e('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free', { released: '2025-08' }),
        e('groq', 'openai/gpt-oss-120b', { params: 117, tools: true, released: '2025-08' }),
    ];
    const live = [
        { id: 'nvidia/nemotron-3-ultra-550b-a55b', created: 1780551208, context_length: 262144, supported_parameters: ['tools', 'reasoning'],
          description: '55B active parameters out of 550B total', benchmarks: { artificial_analysis: { intelligence_index: 22.9, coding_index: 49.3, agentic_index: 20.1 } } },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', created: 1780551208, context_length: 1000000, supported_parameters: ['tools'], description: '' },
    ];

    it('groups all providers of one model, with live details and the largest live context', () => {
        const [ultra, medium] = M.buildModelRankGroups(catalog, live);
        expect(ultra.entries.map((x: any) => x.provider)).toEqual(['nvidia', 'openrouter', 'kilo']);
        expect(ultra).toMatchObject({ id: 'nvidia/nemotron-3-ultra-550b-a55b', live: true, contextK: 1000, paramsB: 550, activeB: 55, tools: true, thinking: true, released: '2026-06' });
        expect(ultra.aa).toEqual({ intelligence: 22.9, coding: 49.3, agentic: 20.1 });
        // Not listed live → catalog values merged.
        expect(medium).toMatchObject({ id: 'openai/gpt-oss-120b', live: false, paramsB: 117, tools: true, released: '2025-08' });
    });

    it('prompt lines carry model ids only — no provider names', () => {
        const groups = M.buildModelRankGroups(catalog, live);
        const line = M.formatModelRankLine(1, groups[0]);
        expect(line).toBe('1. nvidia/nemotron-3-ultra-550b-a55b — 550B (55B active), 1000K ctx, tools, reasoning, released 2026-06, AA intelligence 22.9 / coding 49.3 / agentic 20.1, not used here yet');
        expect(line).not.toMatch(/openrouter|kilo|free/i);
    });
});

describe('successful-request counts', () => {
    it('recordModelSuccess counts per canonical id, across providers', () => {
        localStorage.removeItem('fg_model_success_counts');
        W.recordModelSuccess('nvidia/nemotron-3-ultra-550b-a55b');
        W.recordModelSuccess('nvidia/nemotron-3-ultra-550b-a55b:free');
        W.recordModelSuccess('nemotron-3-ultra-550b-a55b-free');
        W.recordModelSuccess('qwen/qwen3.8-27b:free');
        expect(W.getModelSuccessCounts()).toEqual({ 'nemotron-3-ultra-550b-a55b': 3, 'qwen3.8-27b': 1 });
    });

    it('are a ranking feature on each model line', () => {
        const groups = M.buildModelRankGroups(
            [e('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free'), e('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'), e('openrouter', 'qwen/qwen3.8-27b:free')],
            [], { 'nemotron-3-ultra-550b-a55b': 37, 'qwen3.8-27b': 1 });
        expect(groups.map((g: any) => g.successes)).toEqual([37, 1]);
        expect(M.formatModelRankLine(1, groups[0])).toMatch(/, 37 successful requests here$/);
        expect(M.formatModelRankLine(2, groups[1])).toMatch(/, 1 successful request here$/);
    });
});

describe('removed providers', () => {
    it('OpenCode entries are dropped, including saved custom models', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'opencode', model: 'big-pickle', label: 'Big Pickle' }]));
        expect(W.getAllModels().some((m: any) => m.provider === 'opencode')).toBe(false);
        localStorage.setItem('fg_main_models', JSON.stringify(['opencode|big-pickle', 'kilo|nvidia/nemotron-3-ultra-550b-a55b:free']));
        expect(W.getMainModelList()).toEqual(['kilo|nvidia/nemotron-3-ultra-550b-a55b:free']);
        localStorage.removeItem('fg_custom_models'); localStorage.removeItem('fg_main_models');
    });
});

describe('priority list display', () => {
    it('shows saved entries without a key (inactive, "no key") instead of hiding them', () => {
        const el = document.createElement('div'); el.id = 'main-model-list'; document.body.appendChild(el);
        localStorage.removeItem('fg_nvidia_key');
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia|nvidia/nemotron-3-ultra-550b-a55b']));
        W.renderMainModelList();
        const rows = el.querySelectorAll('.model-priority-row');
        expect(rows).toHaveLength(2);
        expect(rows[1].textContent).toContain('no key');
        expect(rows[1].querySelector('.model-priority-rank')!.textContent).toBe('–');
        el.remove(); localStorage.removeItem('fg_main_models');
    });
});

describe('sortModelRankGroupsNewestFirst', () => {
    it('orders by release month, newest first, undated last, ties keep catalog order', () => {
        const g = (id: string, released: string | null) => ({ id, released });
        const out = M.sortModelRankGroupsNewestFirst([g('a', '2026-04'), g('b', null), g('c', '2026-10'), g('d', '2026-04')]);
        expect(out.map((x: any) => x.id)).toEqual(['c', 'a', 'd', 'b']);
    });
});
