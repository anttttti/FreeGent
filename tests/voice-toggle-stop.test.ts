// codex R342: the mic button said "Stop recording" but could not stop Web Speech or cancel a pending permission prompt.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

describe('voice input toggle', () => {
    beforeAll(async () => { await import('../voice.ts'); });
    afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); });

    it('a second press stops a running Web Speech recognizer instead of starting another', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['browser|webspeech']));
        const made: any[] = [];
        (window as any).SpeechRecognition = function (this: any) { this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); made.push(this); };
        await (window as any).toggleVoiceInput();
        await (window as any).toggleVoiceInput();
        expect(made).toHaveLength(1);
        expect(made[0].stop).toHaveBeenCalledTimes(1);
        await (window as any).toggleVoiceInput();   // ended: a new press starts again
        expect(made).toHaveLength(2);
        made[1].onend?.();
    });

    it('a second press during the permission prompt releases the stream when it arrives', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['groq|whisper-large-v3-turbo']));
        localStorage.setItem('fg_groq_key', 'k');
        const track = { stop: vi.fn() };
        let grant: (s: any) => void = () => {};
        (navigator as any).mediaDevices = { getUserMedia: vi.fn(() => new Promise(r => { grant = r; })) };
        const MR = vi.fn(); (window as any).MediaRecorder = (globalThis as any).MediaRecorder = MR;
        const first = (window as any).toggleVoiceInput();
        await (window as any).toggleVoiceInput();   // pressed again while the prompt is open
        grant({ getTracks: () => [track] });
        await first;
        expect(track.stop).toHaveBeenCalled();
        expect(MR).not.toHaveBeenCalled();
    });

    it('a transcript that finishes in another chat is not put into the open chat (codex R481)', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['browser|webspeech']));
        document.body.innerHTML = '<div id="agent-input" contenteditable="true"></div><div id="mic-notice"></div>';
        const made: any[] = [];
        (window as any).SpeechRecognition = function (this: any) { this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); made.push(this); };
        const prev = (window as any).activeChatId;
        (window as any).activeChatId = 'chat-a';
        try {
            await (window as any).toggleVoiceInput();
            (window as any).activeChatId = 'chat-b';   // the user switched chats while it listened
            made[0].onresult({ results: [[{ transcript: 'hello there' }]] });
            expect(document.getElementById('mic-notice')?.textContent ?? '').toMatch(/another chat/);
            made[0].onend?.();
        } finally { (window as any).activeChatId = prev; }
    });

    it('a stop event that arrives after the next recording started neither clears its indicator nor takes its audio (Y010, R618)', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['groq|whisper-large-v3-turbo']));
        localStorage.setItem('fg_groq_key', 'k');
        document.body.innerHTML = '<button id="agent-mic-btn"></button>';
        const recorders: any[] = [];
        class FakeRecorder {
            state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: any; onstop: any;
            constructor() { recorders.push(this); }
            start() { this.state = 'recording'; }
            stop() { this.state = 'inactive'; }   // the stop event is delivered later, by the test
        }
        (window as any).MediaRecorder = (globalThis as any).MediaRecorder = FakeRecorder;
        const tracks = () => ({ getTracks: () => [{ stop: vi.fn() }] });
        (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => tracks()) };
        const sent: number[] = [];
        const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_u: any, init: any) => { sent.push((init.body.get('file') as Blob).size); return new Response(JSON.stringify({ text: 'x' })); }) as any);
        const btn = () => document.getElementById('agent-mic-btn')!;
        await (window as any).toggleVoiceInput();            // recording 1
        recorders[0].ondataavailable({ data: new Blob(['one']) });
        await (window as any).toggleVoiceInput();            // stop 1: inactive now, its stop event still to come
        await (window as any).toggleVoiceInput();            // recording 2 starts first
        recorders[1].ondataavailable({ data: new Blob(['twotwo']) });
        await recorders[0].onstop();                          // the old stop event arrives
        expect(btn().classList.contains('mic-active')).toBe(true);   // recording 2 is still on the indicator
        expect(sent).toEqual([3]);                            // 'one' only, not recording 2's bytes
        fetched.mockRestore();
    });
});

