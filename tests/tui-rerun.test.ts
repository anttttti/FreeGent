// TUI: the same Rewind / Rerun buttons per AI turn and Rerun per step as the WebUI. The store and placeholder side (what a turn remembers about
// the message it answers and where each step's model call started), and the screen edits a rewind or a rerun makes.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Store from '../tui-store.ts';
import { makeTuiPlaceholder } from '../tui-placeholder.ts';

const origin = (text: string, historyLen: number, ckptId = 1): Store.TurnOrigin => ({ text, historyLen, ckptId, model: 'openai · m' });
beforeEach(() => { Store.replaceEntries([]); Store.setNextTurnOrigin(null); Store.askConfirm(null); });
const turns = () => Store.getState().entries.filter((e): e is Extract<Store.Entry, { type: 'turn' }> => e.type === 'turn').map(e => e.turn);

describe('what a turn remembers', () => {
    it('the turn that answers a message carries that message, the history length before it and its workspace copy; the next turn does not', () => {
        Store.setNextTurnOrigin(origin('fix it', 4, 7));
        makeTuiPlaceholder(); makeTuiPlaceholder();
        const [a, b] = turns();
        expect(a.origin).toEqual(origin('fix it', 4, 7));
        expect(b.origin).toBeUndefined();
    });
    it('a notice never takes the origin of the message being sent', () => {
        Store.setNextTurnOrigin(origin('x', 0));
        Store.addNotice('hello');
        makeTuiPlaceholder();
        expect(turns().map(t => !!t.origin)).toEqual([false, true]);
    });
    it('a resumed conversation can be rewound and rerun from its messages: the origin is the message\'s place in the history', () => {
        const hist = [
            { role: 'user', content: 'first' }, { role: 'assistant', content: 'A1' },
            { role: 'user', content: '<nudge>keep going</nudge>' }, { role: 'assistant', content: 'A1b' },
            { role: 'user', content: 'second' }, { role: 'assistant', content: 'A2' },
        ];
        const entries = Store.entriesFromHistory(hist, { user: s => s, answer: s => s });
        const origins = entries.filter(e => e.type === 'turn').map(e => (e as any).turn.origin);
        expect(origins).toEqual([{ text: 'first', historyLen: 0, ckptId: null, model: '' }, { text: 'second', historyLen: 4, ckptId: null, model: '' }]);
    });
});

describe('where a step can be rerun from', () => {
    it('a model call remembers the history it started from; the tool steps it made point back at it', () => {
        const ph: any = makeTuiPlaceholder();
        const t1 = ph.addThinkingTask({ histLen: 3 });
        const [tool] = ph.addToolStep(['read:a.ts'], { main: true });
        const t2 = ph.addThinkingTask({ histLen: 6 });
        const [tool2] = ph.addToolStep(['exec(bash)'], { main: true });
        const [w1, w2] = ph.addToolStep(['worker:W1:coder', 'worker:W2:coder']);                 // workers' steps: no Rerun, as in the WebUI
        const steps = turns()[0].steps;
        expect(steps.map(s => s.histLen)).toEqual([3, 3, 6, 6, null, null]);
        expect(steps[0].anchor).toBe(steps[0]);
        expect(steps[1].anchor).toBe(steps[0]);
        expect(steps[3].anchor).toBe(steps[2]);
        expect(steps[4].anchor).toBeNull();
        void t1; void tool; void t2; void tool2; void w1; void w2;
    });
    it('a model call that was not told its history length cannot be rerun', () => {
        const ph: any = makeTuiPlaceholder();
        ph.addThinkingTask();
        expect(turns()[0].steps[0].histLen).toBeNull();
    });
});

describe('screen edits', () => {
    function conversation() {
        const out: Store.TurnState[] = [];
        for (const [i, text] of ['one', 'two', 'three'].entries()) {
            Store.addUserMessage(text);
            Store.setNextTurnOrigin(origin(text, i * 4, i + 1));
            const ph: any = makeTuiPlaceholder();
            ph.addThinkingTask({ histLen: i * 4 + 1 });
            ph.addToolStep(['read:x'], { main: true });
            ph.addThinkingTask({ histLen: i * 4 + 3 });
            ph.finalize(`answer ${text}`);
            out.push(turns()[i]);
        }
        return out;
    }
    it('a rerun from a step keeps the steps before it, removes it and what follows, and reopens the turn; later messages go', () => {
        const [, t2] = conversation();
        const second = t2.steps[2];                              // the last model call of the second turn
        Store.truncateFromStep(t2, second);
        expect(t2.steps.map(s => s.label.split(':')[0])).toEqual(['Thinking', 'read']);
        expect(t2.done).toBe(false);
        expect(t2.finalText).toBeNull();
        expect(Store.getState().entries.map(e => e.type === 'user' ? e.text : 'turn')).toEqual(['one', 'turn', 'two', 'turn']);
    });
    it('continuing the cut turn adds its new steps to the same turn, without a second turn or a new origin', () => {
        const [, t2] = conversation();
        Store.truncateFromStep(t2, t2.steps[2]);
        const before = turns().length;
        Store.setNextTurnOrigin(null);
        const ph: any = makeTuiPlaceholder({ continueTurn: t2 });
        ph.addThinkingTask({ histLen: 7 });
        ph.finalize('answer two, again');
        expect(turns().length).toBe(before);
        expect(t2.steps.length).toBe(3);
        expect(t2.steps[2].histLen).toBe(7);
        expect(t2.done).toBe(true);
        expect(t2.origin?.text).toBe('two');
    });
    it('a rewind takes away the message, its turn and everything after', () => {
        const [, t2] = conversation();
        Store.truncateFromTurn(t2);
        expect(Store.getState().entries.map(e => e.type === 'user' ? e.text : 'turn')).toEqual(['one', 'turn']);
    });
    it('the last turn that answers a sent message is the one /rewind and /rerun go back to', () => {
        const [, , t3] = conversation();
        Store.addNotice('Resumed');                              // a notice after it does not count
        expect(Store.lastOriginTurn()).toBe(t3);
    });
});

describe('the question before a rewind or a rerun from a step', () => {
    it('is held in the store until answered', () => {
        let ran = '';
        Store.askConfirm({ text: 'sure?', choices: [{ key: 'y', label: 'Yes', run: () => { ran = 'y'; } }] });
        expect(Store.getState().confirm?.text).toBe('sure?');
        Store.getState().confirm!.choices[0].run();
        Store.askConfirm(null);
        expect(ran).toBe('y');
        expect(Store.getState().confirm).toBeNull();
    });
});

describe('wired into the TUI', () => {
    const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
    const app = src('tui-app.tsx'), main = src('fg-tui.tsx'), core = src('agent-core.ts');
    it('the turn header has Rewind (asks first) and Rerun, the step has Rerun (asks whether to reset the workspace)', () => {
        expect(app).toMatch(/label="\[⏮ Rewind\]" onClick=\{\(\) => _askRewind\(turn\)\}/);
        expect(app).toMatch(/label="\[↺ Rerun\]" onClick=\{\(\) => \{ void rerunTurn\(turn\); \}\}/);
        expect(app).toMatch(/label="\[↺ Rerun\]" onClick=\{\(\) => _askRerunStep\(turn, step\)\}/);
        expect(app).toMatch(/Rerun and reset the workspace to the start of the turn/);
    });
    it('the narrowest button under the pointer is the one clicked, and a question swallows other keys', () => {
        expect(app).toMatch(/ct - cf < best\.width/);
        expect(app).toMatch(/const pending = Store\.getState\(\)\.confirm;/);
        expect(app).toMatch(/if \(Store\.getState\(\)\.confirm\) return;/);
    });
    it('the step rerun is the WebUI\'s: the same tail of a turn runs on the cut history', () => {
        expect(core).toMatch(/async function runTurnFromHistory\(makePlaceholder/);
        expect(core).toMatch(/await runTurnFromHistory\(\(\) => \{\s+const ph: RenderAdapter = createResponsePlaceholder\(null, \{ continueFrom/);
        expect(core).toMatch(/rerunTurnFromHistory: runTurnFromHistory/);
        expect(main).toMatch(/rerunTurnFromHistory\(\(\) => makeTuiPlaceholder\(\{ continueTurn: turn \}\)\)/);
    });
    it('every send takes a copy first and hands its origin to the turn', () => {
        expect(main).toMatch(/await _takeCheckpoint\(text\)/);
        expect(main).toMatch(/await _takeCheckpoint\(msg\.text\)/);
        expect(main).toMatch(/Store\.setNextTurnOrigin\(\{ text, historyLen, ckptId: id, model: _modelLabel\(\) \}\)/);
    });
});

describe('the log does not measure the whole conversation on every redraw', () => {
    const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
    const app = src('tui-app.tsx');
    it('heights are lazy, and the cleaned and wrapped text of a finished turn is kept', () => {
        expect(app).toMatch(/const heights  = lazyHeights\(items\.length, i => \{/);
        expect(app).toMatch(/return _memo\(_cleanedFinal, text, \(\) => \{/);
        expect(app).toMatch(/_rowsOf\(_finalRows, _cleanFinalText\(item\.turn\.finalText!\), width - 2\)/);
        expect(app).not.toMatch(/items\.map\(it =>\s+it\.kind === 'user'/);
    });
});
