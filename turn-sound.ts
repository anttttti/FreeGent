// turn-sound.ts — FreeGent: short chime when Autopilot finishes a task's chat in the WebUI.
// A device preference (not part of profiles); on by default, switch in Settings → Agent → Agent Loop.

export const TURN_SOUND_KEY = 'fg_turn_sound';

export function turnSoundEnabled(): boolean {
    try { return localStorage.getItem(TURN_SOUND_KEY) !== '0'; } catch { return true; }
}

let _ctx: AudioContext | null = null;

/** Two soft rising notes. Silent when disabled, when the browser has no Web Audio, or when
 *  autoplay is blocked (no user gesture yet; a turn is always started by one, so this is rare). */
export function playTurnSound(): void {
    if (!turnSoundEnabled()) return;
    try {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        _ctx ??= new AC();
        const ctx = _ctx;
        const start = () => {
            const t0 = ctx.currentTime;
            [[659, 0], [880, 0.12]].forEach(([freq, at]) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, t0 + at);
                gain.gain.exponentialRampToValueAtTime(0.15, t0 + at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t0 + at);
                osc.stop(t0 + at + 0.3);
            });
        };
        ctx.state === 'suspended' ? ctx.resume().then(start, () => {}) : start();
    } catch { /* sound is best-effort */ }
}

export function onTurnSoundChange(checked: boolean): void {
    try { localStorage.setItem(TURN_SOUND_KEY, checked ? '1' : '0'); } catch { /* ignore */ }
    if (checked) playTurnSound();
}

Object.assign(window, { onTurnSoundChange });
