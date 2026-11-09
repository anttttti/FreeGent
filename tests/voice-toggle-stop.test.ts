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
});
