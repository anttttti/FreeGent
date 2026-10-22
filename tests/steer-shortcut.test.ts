// Ctrl+X Ctrl+S: send the next waiting message into the running work now (WebUI and TUI share steerNextQueued).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as MsgQueue from '../msg-queue.ts';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
    await import('../settings-ui.ts');
    await import('../agent-core.ts');
    await import('../chat-state.ts');
});
beforeEach(() => { MsgQueue.clear(); W.setAgentStreaming(false); W.setAiJob(''); });
afterEach(() => { MsgQueue.clear(); W.setAgentStreaming(false); W.setAiJob(''); });

describe('steerNextQueued', () => {
    it('the first waiting message becomes a steering message at the head', () => {
        MsgQueue.enqueue('first', 'queued');
        const b = MsgQueue.enqueue('second', 'queued');
        const r = W.steerNextQueued('');
        expect(r).toEqual({ did: 'queued', text: 'first' });
        expect(MsgQueue.getAll().map(m => [m.text, m.mode])).toEqual([['first', 'steering'], ['second', 'queued']]);
        expect(MsgQueue.getAll()[1].id).toBe(b.id);
    });
    it('a message behind a steering one moves up to the head when steered', () => {
        const a = MsgQueue.enqueue('already', 'steering');
        MsgQueue.enqueue('later', 'queued');
        const r = W.steerNextQueued('');
        expect(r.text).toBe('later');
        expect(MsgQueue.getAll()[0].text).toBe('later');
        expect(MsgQueue.getAll().every(m => m.mode === 'steering')).toBe(true);
        expect(MsgQueue.getAll().some(m => m.id === a.id)).toBe(true);
    });
    it('with nothing queued, the box text is sent as a steering message while something runs', () => {
        W.setAgentStreaming(true);
        const r = W.steerNextQueued('  change course  ');
        expect(r).toEqual({ did: 'composer', text: 'change course' });
        expect(MsgQueue.getAll().map(m => [m.text, m.mode])).toEqual([['change course', 'steering']]);
    });
    it('does nothing when nothing runs, or there is nothing to send', () => {
        expect(W.steerNextQueued('hello').did).toBe('none');   // idle: Enter sends it
        W.setAgentStreaming(true);
        expect(W.steerNextQueued('   ').did).toBe('none');
        expect(MsgQueue.size()).toBe(0);
    });
    it('a message already steering is reported, not queued twice', () => {
        MsgQueue.enqueue('go', 'steering');
        expect(W.steerNextQueued('typed').did).toBe('queued');
        expect(MsgQueue.size()).toBe(1);
    });
});

describe('the key chords', () => {
    it('the browser listens for Ctrl+X then Ctrl+S, and claims Ctrl+X only while busy with nothing selected', () => {
        const src = readFileSync('init.ts', 'utf8');
        expect(src).toMatch(/e\.ctrlKey[^\n]*key\.toLowerCase\(\) === 'x'/);
        expect(src).toMatch(/Date\.now\(\) - _steerChordAt < 2000/);
        expect(src).toMatch(/busy && window\.getSelection\(\)\?\.isCollapsed !== false/);
    });
    it('the terminal input handles the chord, typed or arriving in one read', () => {
        const src = readFileSync('tui-app.tsx', 'utf8');
        expect(src).toMatch(/input === 'x'\) chordAt\.current = Date\.now\(\)/);
        expect(src).toMatch(/input === 's' && Date\.now\(\) - chordAt\.current < 2000/);
        expect(src).toContain("\\x15\\x18\\x13");
        expect(src).toContain('Ctrl+X Ctrl+S');
    });
});

describe('TUI composer keys', () => {
    const src = readFileSync('tui-app.tsx', 'utf8');
    it('Home and End move the cursor to the start and end of the message', () => {
        expect(src).toContain('if (key.home) { setCursor(0); return; }');
        expect(src).toContain('if (key.end)  { setCursor(v.length); return; }');
    });
    it('Home / End sequences that arrive inside a typed-ahead chunk act too, and other key sequences are not typed as text', () => {
        expect(src).toContain('{ tc = 0; continue; }');
        expect(src).toContain('{ tc = tv.length; continue; }');
        expect(src).toContain('never typed as text');
    });
});

describe('TUI step header', () => {
    it('shows the provider with the model (provider:model), not only the last path segment', () => {
        const src = readFileSync('tui-app.tsx', 'utf8');
        expect(src).toContain("const model = step.model ? ` [${step.model}]` : '';");
        expect(src).not.toContain("step.model.split('/').pop()");
    });
});
