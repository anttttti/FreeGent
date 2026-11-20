// A chime queued behind a resuming audio context is dropped when the preference is switched off meanwhile (explorations W008).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { playTurnSound, TURN_SOUND_KEY } from '../turn-sound.ts';

afterEach(() => { localStorage.clear(); delete (window as any).AudioContext; });

describe('playTurnSound', () => {
    it('plays when resumed with the sound on, stays silent when it was switched off while resuming', async () => {
        const made = vi.fn();
        let resume!: () => void;
        class FakeAudio {
            state = 'suspended'; currentTime = 0; destination = {};
            resume() { return new Promise<void>(r => { resume = r; }); }
            createOscillator() { made(); return { type: '', frequency: { value: 0 }, connect: () => ({ connect: () => {} }), start() {}, stop() {} }; }
            createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect: () => {} }) }; }
        }
        (window as any).AudioContext = FakeAudio;
        playTurnSound(); resume(); await Promise.resolve(); await Promise.resolve();
        expect(made).toHaveBeenCalledTimes(2);
        made.mockClear();
        playTurnSound(); localStorage.setItem(TURN_SOUND_KEY, '0'); resume(); await Promise.resolve(); await Promise.resolve();
        expect(made).not.toHaveBeenCalled();
    });
});
