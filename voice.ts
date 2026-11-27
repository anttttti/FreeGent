// voice.js — FreeGent: speech input (STT) and speech output (TTS)
import { KEYS, voiceApivKey, renameRetiredVoiceModels } from './storage-keys.js';

let _mediaRecorder: MediaRecorder | null = null;
let _speechRec: any        = null;    // the running Web Speech recognizer, so the mic button can stop it (codex R342)
let _micPending            = false;   // waiting for the microphone permission prompt
let _micCancelled          = false;   // the button was pressed again during that wait
let _ttsAudio: HTMLAudioElement | null      = null;
let _ttsUrl: string | null                  = null;
/** Stop the API TTS element and revoke its object URL (it used to be revoked only when playback ended). */
function _releaseTtsAudio() {
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
    if (_ttsUrl) { URL.revokeObjectURL(_ttsUrl); _ttsUrl = null; }
}

// ── Provider routing ─────────────────────────────────────────────────────────

function _providerKey(provider) {
    switch (provider) {
        case 'groq':       return typeof getGroqKey       === 'function' ? getGroqKey()       : null;
        case 'openrouter': return typeof getOpenRouterKey === 'function' ? getOpenRouterKey() : null;
        default: return null;
    }
}

function _transcribeUrl(provider) {
    switch (provider) {
        case 'groq':       return 'https://api.groq.com/openai/v1/audio/transcriptions';
        case 'openrouter': return 'https://openrouter.ai/api/v1/audio/transcriptions';
        default:           return null;
    }
}

function _speechUrl(provider) {
    switch (provider) {
        case 'openrouter': return 'https://openrouter.ai/api/v1/audio/speech';
        default:           return null;
    }
}

// Sensible default voice IDs per model (OpenAI-compat /audio/speech)
// The voice names are each model's own (a wrong one is a 400, or for Voxtral a 404); "alloy" is only the OpenAI one.
const _TTS_VOICE_DEFAULTS = {
    'openrouter|hexgrad/kokoro-82m':                  'af_sarah',
    'openrouter|google/gemini-3.8-flash-tts':         'Aoede',
    'openrouter|google/gemini-3.1-flash-tts-preview': 'Aoede',
    'openrouter|mistralai/voxtral-mini-tts-3-0':      'en_paul_neutral',
    'openrouter|mistralai/voxtral-mini-tts-2603':     'en_paul_neutral',
    'openrouter|qwen/qwen3-tts-1.7b':                 'ryan',
    'openrouter|canopylabs/orpheus-3b-0.1-ft':        'tara',
    'openrouter|x-ai/grok-voice-tts-1.0':             'eve',
};

/** OpenRouter answers a speech request with raw 16-bit PCM (`audio/pcm;rate=24000;channels=1`) unless a format is asked for, and each model
 *  supports a different set of formats. An <audio> element cannot play raw PCM, so it is given a WAV header and plays. */
export function pcmToWav(pcm: Uint8Array, rate = 24000, channels = 1): Uint8Array {
    const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
    const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
}
/** The playable form of a speech response: raw PCM becomes WAV, anything else is already a container the browser plays. */
export async function playableSpeech(r: { headers: { get(n: string): string | null }; blob(): Promise<Blob> }): Promise<Blob> {
    const type = r.headers.get('content-type') || '';
    const blob = await r.blob();
    if (!/^audio\/(?:l16|pcm)/i.test(type)) return blob;
    const num = (k: string, d: number) => Number(new RegExp(`${k}=(\\d+)`, 'i').exec(type)?.[1]) || d;
    return new Blob([pcmToWav(new Uint8Array(await blob.arrayBuffer()), num('rate', 24000), num('channels', 1)) as BlobPart], { type: 'audio/wav' });
}

function _getSttList() {
    try {
        const l = JSON.parse(localStorage.getItem(KEYS.VOICE_STT_LIST) || 'null');
        return Array.isArray(l) ? renameRetiredVoiceModels(l) : ['groq|whisper-large-v3-turbo', 'browser|webspeech'];
    } catch { return ['groq|whisper-large-v3-turbo', 'browser|webspeech']; }
}

function _getTtsList() {
    try {
        return JSON.parse(localStorage.getItem(KEYS.VOICE_TTS_LIST) || 'null')
            || ['browser|webspeech'];
    } catch { return ['browser|webspeech']; }
}

// ── STT ──────────────────────────────────────────────────────────────────────

// A failed mic attempt used to be a console line only: the button looked untouched (cline report
// 2026-10-19 D2). Non-blocking, announced to screen readers, gone after a few seconds.
function _micNotice(msg: string) {
    try {
        document.getElementById('mic-notice')?.remove();
        const el = document.createElement('div');
        el.id = 'mic-notice'; el.className = 'mic-notice';
        el.setAttribute('role', 'status');
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 7000);
    } catch {}
}

function _micErrorText(e: any): string {
    const n = e?.name;
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone found.';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone access was denied. Allow it in the browser\'s site settings and try again.';
    if (n === 'NotReadableError') return 'The microphone is in use by another application.';
    return 'Could not start the microphone' + (e?.message ? `: ${e.message}` : '.');
}

async function toggleVoiceInput() {
    if (_mediaRecorder?.state === 'recording') {
        _mediaRecorder.stop();
        return;
    }
    if (_speechRec) { try { _speechRec.stop(); } catch {} return; }
    if (_micPending) { _micCancelled = true; return; }
    for (const entry of _getSttList()) {
        const [provider, model] = entry.split('|');
        if (provider === 'browser') { _startWebSpeech(); return; }
        const key = _providerKey(provider);
        if (key) { await _startMediaRecorder(key, provider, model); return; }
    }
    _micNotice('No speech-to-text provider available. Add a Groq or OpenRouter key in Settings → Credentials, or add Web Speech to the STT list.');
}

async function _startMediaRecorder(key, provider, model) {
    let stream: MediaStream;
    _micPending = true; _micCancelled = false;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.error('[voice] mic access denied:', e); _micNotice(_micErrorText(e)); return; }
    finally { _micPending = false; }
    if (_micCancelled) { _micCancelled = false; stream.getTracks().forEach(t => t.stop()); return; }   // stopped while the permission prompt was open

    const owner = _activeChat();   // the chat the recording was made in (codex R481)
    // This recording's own recorder and chunks: a stop event can arrive after the next recording has started, and must neither read its chunks
    // nor clear its indicator (explorations Y010, R618).
    let rec: MediaRecorder;
    const chunks: Blob[] = [];
    try { rec = _mediaRecorder = new MediaRecorder(stream); }
    catch (e) {
        stream.getTracks().forEach(t => t.stop()); // release the mic — otherwise it stays hot
        console.error('[voice] MediaRecorder init failed:', e);
        _micNotice('This browser cannot record audio.');
        return;
    }
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (_mediaRecorder === rec) _setMicState(false);
        // The browser picks the container (WebM, or MP4 on Safari): say what it is, not always WebM (codex R484).
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        chunks.length = 0;   // the recording is in the Blob now; do not keep a second copy (codex R485)
        const text = await _apiTranscribe(blob, key, provider, model);
        if (text) _insertVoiceText(text, owner);
        else _micNotice('Transcription failed — nothing was inserted.');
    };
    rec.start();
    _setMicState(true);
}

function _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        _micNotice('Web Speech needs Chrome or Edge. Add a Groq or OpenRouter key in Settings → Credentials for speech-to-text in this browser.');
        return;
    }
    const rec = new SR();
    rec.continuous     = false;
    rec.interimResults = false;
    const lang = localStorage.getItem(KEYS.VOICE_STT_LANG);
    if (lang) rec.lang = lang;
    rec.onstart  = () => _setMicState(true);
    rec.onend    = () => { if (_speechRec === rec) _speechRec = null; _setMicState(false); };
    rec.onerror  = (ev: any) => {
        if (_speechRec === rec) _speechRec = null;
        _setMicState(false);
        if (ev?.error && ev.error !== 'aborted' && ev.error !== 'no-speech') _micNotice(ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ? _micErrorText({ name: 'NotAllowedError' }) : `Voice input failed (${ev.error}).`);
    };
    const owner = _activeChat();
    rec.onresult = e => _insertVoiceText(e.results[0][0].transcript, owner);
    _speechRec = rec;
    try { rec.start(); } catch (e) { _speechRec = null; _micNotice(_micErrorText(e)); }
}

async function _apiTranscribe(blob, key, provider, model) {
    const url = _transcribeUrl(provider);
    if (!url) return '';
    const form = new FormData();
    form.append('file', blob, /mp4|aac|m4a/i.test(blob.type) ? 'audio.mp4' : /ogg/i.test(blob.type) ? 'audio.ogg' : 'audio.webm');
    form.append('model', model);
    const lang = localStorage.getItem(KEYS.VOICE_STT_LANG);
    if (lang) form.append('language', lang);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}` },
            body: form,
        });
        if (!r.ok) throw new Error(await r.text());
        return (await r.json()).text?.trim() || '';
    } catch (e) {
        console.error('[voice] transcription error:', e);
        return '';
    }
}

const _activeChat = (): string | null => (typeof window !== 'undefined' ? (window as any).activeChatId ?? null : null);
function _insertVoiceText(text, owner: string | null = null) {
    // The composer shows the chat that is open now: a transcript that finished after a switch would be sent in the wrong conversation (codex R481).
    if (owner && _activeChat() && owner !== _activeChat()) { _micNotice('Voice input finished in another chat, so it was not inserted here.'); return; }
    const el = document.getElementById('agent-input');
    if (!el) return;
    const cur = (el.innerText || '').trim();
    if (typeof _setInputText === 'function') _setInputText(el, cur ? cur + ' ' + text : text);
    if (typeof autoResizeTextarea === 'function') autoResizeTextarea(el);
    el.focus();
}

function _setMicState(recording) {
    const btn = document.getElementById('agent-mic-btn');
    if (!btn) return;
    const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    btn.classList.toggle('mic-active', recording);
    btn.title     = recording ? 'Stop recording' : 'Voice input';
    btn.innerHTML = recording ? '⏹' : MIC_SVG;
}

// ── TTS ──────────────────────────────────────────────────────────────────────

async function speakText(text) {
    stopSpeaking();
    const clean = _cleanForSpeech(text);
    for (const entry of _getTtsList()) {
        const [provider, model] = entry.split('|');
        if (provider === 'browser') { _webSpeechSpeak(clean); return; }
        const key = _providerKey(provider);
        if (key) { await _apiSpeak(clean, key, provider, model, entry); return; }
    }
}

function _webSpeechSpeak(text) {
    if (!window.speechSynthesis) return;
    const utt = new SpeechSynthesisUtterance(text);
    const voiceName = localStorage.getItem(KEYS.VOICE_TTS_VOICE);
    if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find(v => v.name === voiceName);
        if (voice) utt.voice = voice;
    }
    utt.rate  = parseFloat(localStorage.getItem(KEYS.VOICE_TTS_RATE)  || '1');
    utt.pitch = parseFloat(localStorage.getItem(KEYS.VOICE_TTS_PITCH) || '1');
    window.speechSynthesis.speak(utt);
}

let _ttsSeq = 0;   // the newest speech request: an older one that answers late, or one made before Stop, does not play (review of de28506)
async function _apiSpeak(text, key, provider, model, entryKey) {
    const url = _speechUrl(provider);
    if (!url) return;
    const mine = ++_ttsSeq;
    const voiceId = localStorage.getItem(voiceApivKey(entryKey))
                 || _TTS_VOICE_DEFAULTS[entryKey]
                 || 'alloy';
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: text, voice: voiceId }),
        });
        if (!r.ok) { console.error('[voice] TTS error:', await r.text()); return; }
        const blob    = await playableSpeech(r);
        if (mine !== _ttsSeq) return;
        _releaseTtsAudio();
        _ttsUrl = URL.createObjectURL(blob);
        const audio = _ttsAudio = new Audio(_ttsUrl);
        audio.onended = () => { if (_ttsAudio === audio) _releaseTtsAudio(); };
        await audio.play();
    } catch (e) {
        console.error('[voice] TTS error:', e);
        _releaseTtsAudio();   // a rejected play() (autoplay policy) must not keep the Blob (codex R341)
    }
}

function _cleanForSpeech(text) {
    return text
        .replace(/```[\s\S]*?```/g,              'code block.')
        .replace(/`([^`]+)`/g,                   '$1')
        .replace(/#{1,6} /g,                     '')
        .replace(/\*{1,3}([^*\n]+)\*{1,3}/g,    '$1')
        .replace(/_([^_\n]+)_/g,                 '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g,       '$1')
        .replace(/\n{2,}/g,                      '. ')
        .replace(/\n/g,                          ' ')
        .trim();
}

function stopSpeaking() {
    _ttsSeq++;
    window.speechSynthesis?.cancel();
    _releaseTtsAudio();
}

// ── Speaker buttons ──────────────────────────────────────────────────────────

// A model message is marked once its answer text exists, and the answer alone is spoken: the bubble also holds the step graph,
// event log and Rewind/Rerun controls, which auto-speak read out, and an empty placeholder marked before its text arrived
// was never spoken (opencode bug #8).
function addVoiceButtons() {
    const spoken: string[] = [];
    document.querySelectorAll('.agent-msg-model:not(.has-speak-btn)').forEach(div => {
        const bubble = div.querySelector('.agent-msg-bubble') as HTMLElement | null;
        if (!bubble) return;
        const parts = Array.from(bubble.querySelectorAll('.agent-response-text:not(.agent-stream-preview)'));
        const answer = (parts.length ? parts.map(el => (el as HTMLElement).innerText ?? el.textContent ?? '').join('\n') : (bubble.innerText ?? bubble.textContent ?? '')).trim();
        if (!answer && bubble.querySelector('.agent-response-text')) return;      // a reply still being written: marked when its text is final
        div.classList.add('has-speak-btn');
        if (answer) spoken.push(answer);
    });
    if (spoken.length && localStorage.getItem(KEYS.VOICE_TTS_AUTO) === '1') speakText(spoken[spoken.length - 1]);
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { toggleVoiceInput, speakText, stopSpeaking, addVoiceButtons });
