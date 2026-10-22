// opencode report 5, bug #8: auto-speak reads the answer only, and only once the answer exists.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
const W: any = window;
let spoken: string[];
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../voice.ts');
});
beforeEach(() => {
    spoken = [];
    localStorage.setItem('fg_voice_tts_auto', '1');
    localStorage.setItem('fg_voice_tts_list', JSON.stringify(['browser|default']));
    W.SpeechSynthesisUtterance = function (this: any, t: string) { this.text = t; };
    W.speechSynthesis = { speak: (u: any) => spoken.push(u.text), cancel() {}, getVoices: () => [] };
});
const msg = (inner: string) => { document.body.innerHTML = `<div class="agent-msg agent-msg-model"><div class="agent-msg-bubble">${inner}</div></div>`; };
const jsdomText = () => document.querySelectorAll<HTMLElement>('.agent-msg-bubble *').forEach(el => Object.defineProperty(el, 'innerText', { get() { return el.textContent; }, configurable: true }));

describe('addVoiceButtons', () => {
    it('speaks the answer, not the step chrome', () => {
        msg('<div class="stepbox">STEP GRAPH Rewind Rerun</div><div class="agent-response-text">The answer.</div>'); jsdomText();
        W.addVoiceButtons();
        expect(spoken).toEqual(['The answer.']);
        expect(document.querySelector('.has-speak-btn')).not.toBeNull();
    });
    it('leaves a placeholder without text unmarked, so the final call can speak it', () => {
        msg('<div class="stepbox">STEP GRAPH</div><div class="agent-response-text"></div>'); jsdomText();
        W.addVoiceButtons();
        expect(document.querySelector('.has-speak-btn')).toBeNull();
        document.querySelector('.agent-response-text')!.textContent = 'Done.';
        W.addVoiceButtons();
        expect(document.querySelector('.has-speak-btn')).not.toBeNull();
    });
});
