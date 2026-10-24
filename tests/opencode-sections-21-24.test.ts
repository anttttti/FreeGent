// Open items from the opencode review (2026-10-22): §23 a busy local server's 503 in compaction, §24 the read counter survives pruning.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneSessionHistory } from '../history.ts';
import { Session } from '../session.ts';
import { _seenReadFiles, setSeenReadFiles } from '../state.ts';

const BIG = 'x'.repeat(900);

describe('opencode §24: pruning a duplicate read leaves the per-file read counter a number', () => {
    it('a covered read is stubbed, its range key is marked, the counter key is not', () => {
        setSeenReadFiles(new Map());
        const sess = new Session({ id: 's24', chatId: 'c' });
        sess.append('user/message', { role: 'user', content: 'task' }, { surfaceOp: 'append' });
        const call = (id: string, args: any) => {
            sess.append('assistant/message', { turn: 0, step: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } }, { surfaceOp: 'append' });
            sess.append('tool/result', { turn: 0, step: 0, callId: id, name: 'read_file', content: BIG }, { surfaceOp: 'append' });
        };
        call('a', { path: 'src/a.py', start_line: 10, end_line: 20 });
        call('b', { path: 'src/a.py' });                       // a whole-file read covers the earlier range
        const seen = (await_import() as Map<string, any>);
        seen.set('src/a.py::__count__', 3);
        seen.set('src/a.py:10-20', 'full');
        const saved = pruneSessionHistory(sess);
        expect(saved).toBeGreaterThan(0);                      // something was pruned
        expect(seen.get('src/a.py::__count__')).toBe(3);       // and the counter that caps whole-file reads is intact
        expect(seen.get('src/a.py:10-20')).toBe('pruned');
    });
});
function await_import(): Map<string, any> { return _seenReadFiles; }

describe('opencode §23: compaction classifies a rate limit with the endpoint', () => {
    it('_isRateLimit gets the endpoint in the compaction retry handler', () => {
        const src = readFileSync(join(process.cwd(), 'llm-shared.ts'), 'utf8');
        expect(src).toMatch(/const ep = getEp\(\);\s*\n\s*const is429 = _isRateLimit\(e\.message, ep\)/);
    });
});

describe('opencode §22: media routing only picks a provider that can receive the media', () => {
    it('a model whose catalog entry lists video for a provider without video parts is not chosen for a video attachment', async () => {
        const { AV_CAPABLE_PROVIDERS } = await import('../config.ts');
        const getMediaCapableSpec = (window as any).getMediaCapableSpec;
        expect(AV_CAPABLE_PROVIDERS.has('nous')).toBe(false);
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'nous', model: 'own-video', label: 'own', media: ['text', 'video'] }]));
        localStorage.setItem('fg_main_models', JSON.stringify(['nous|own-video']));
        localStorage.setItem('fg_nous_key', 'own-key');
        const spec = getMediaCapableSpec(['video']);
        expect(spec).not.toBe('nous|own-video');
        localStorage.removeItem('fg_custom_models'); localStorage.removeItem('fg_main_models'); localStorage.removeItem('fg_nous_key');
    });
});

describe('hermes C19: the judge verdict and the stateful pattern', async () => {
    const { judgeDecision, validateOutput } = await import('../step-validator.ts');
    it('a reply that starts with a hyphenated word is not a verdict', () => {
        expect(judgeDecision('yes-man')).toBeNull();
        expect(judgeDecision('YES-man says hi')).toBeNull();
        expect(judgeDecision('YES')).toBe('yes');
        expect(judgeDecision('- NO')).toBe('no');
        expect(judgeDecision('**YES**')).toBe('yes');
        expect(judgeDecision('nope')).toBeNull();
    });
    it('a /g pattern gives the same answer every time it is tested', async () => {
        const re = /needle/g;
        const checks = [{ name: 'c', re_fail: re, max: 5 }];
        const a = await validateOutput('a needle here', checks);
        const b = await validateOutput('a needle here', checks);
        expect(!!b).toBe(!!a);
    });
});
