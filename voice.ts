// voice.js — FreeGent: speech input (STT) and speech output (TTS)

let _mediaRecorder: MediaRecorder | null = null;
let _audioChunks: Blob[]   = [];
let _ttsAudio: HTMLAudioElement | null      = null;

// ── Provider routing ─────────────────────────────────────────────────────────

function _providerKey(provider) {
    switch (provider) {
        case 'groq':       return typeof getGroqKey       === 'function' ? getGroqKey()       : null;
        case 'mistral':    return typeof getMistralKey    === 'function' ? getMistralKey()    : null;
        case 'openrouter': return typeof getOpenRouterKey === 'function' ? getOpenRouterKey() : null;
        default: return null;
    }
}

function _transcribeUrl(provider) {
    switch (provider) {
        case 'groq':       return 'https://api.groq.com/openai/v1/audio/transcriptions';
        case 'mistral':    return 'https://api.mistral.ai/v1/audio/transcriptions';
        case 'openrouter': return 'https://openrouter.ai/api/v1/audio/transcriptions';
        default:           return null;
    }
}

function _speechUrl(provider) {
    switch (provider) {
        case 'mistral':    return 'https://api.mistral.ai/v1/audio/speech';
        case 'openrouter': return 'https://openrouter.ai/api/v1/audio/speech';
        default:           return null;
    }
}

// Sensible default voice IDs per model (OpenAI-compat /audio/speech)
const _TTS_VOICE_DEFAULTS = {
    'openrouter|hexgrad/kokoro-82m':                  'af_sarah',
    'openrouter|google/gemini-3.1-flash-tts-preview': 'Aoede',
};

function _getSttList() {
    try {
        return JSON.parse(localStorage.getItem('fg_voice_stt_list') || 'null')
            || ['groq|whisper-large-v3-turbo', 'browser|webspeech'];
    } catch { return ['groq|whisper-large-v3-turbo', 'browser|webspeech']; }
}

function _getTtsList() {
    try {
        return JSON.parse(localStorage.getItem('fg_voice_tts_list') || 'null')
            || ['browser|webspeech'];
    } catch { return ['browser|webspeech']; }
}

// ── STT ──────────────────────────────────────────────────────────────────────

async function toggleVoiceInput() {
    if (_mediaRecorder?.state === 'recording') {
        _mediaRecorder.stop();
        return;
    }
    for (const entry of _getSttList()) {
        const [provider, model] = entry.split('|');
        if (provider === 'browser') { _startWebSpeech(); return; }
        const key = _providerKey(provider);
        if (key) { await _startMediaRecorder(key, provider, model); return; }
    }
    alert('No STT provider available. Add a Groq, Mistral, or OpenRouter key in Settings → Models, or add Web Speech to the STT list.');
}

async function _startMediaRecorder(key, provider, model) {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.error('[voice] mic access denied:', e); return; }

    _audioChunks = [];
    try { _mediaRecorder = new MediaRecorder(stream); }
    catch (e) {
        stream.getTracks().forEach(t => t.stop()); // release the mic — otherwise it stays hot
        console.error('[voice] MediaRecorder init failed:', e);
        return;
    }
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        _setMicState(false);
        const blob = new Blob(_audioChunks, { type: 'audio/webm' });
        const text = await _apiTranscribe(blob, key, provider, model);
        if (text) _insertVoiceText(text);
    };
    _mediaRecorder.start();
    _setMicState(true);
}

function _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        alert('Web Speech requires Chrome or Edge. Add a Groq/Mistral/OpenRouter key for cross-browser STT.');
        return;
    }
    const rec = new SR();
    rec.continuous     = false;
    rec.interimResults = false;
    const lang = localStorage.getItem('fg_voice_stt_lang');
    if (lang) rec.lang = lang;
    rec.onstart  = () => _setMicState(true);
    rec.onend    = () => _setMicState(false);
    rec.onerror  = () => _setMicState(false);
    rec.onresult = e => _insertVoiceText(e.results[0][0].transcript);
    rec.start();
}

async function _apiTranscribe(blob, key, provider, model) {
    const url = _transcribeUrl(provider);
    if (!url) return '';
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    const lang = localStorage.getItem('fg_voice_stt_lang');
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

function _insertVoiceText(text) {
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
    const voiceName = localStorage.getItem('fg_voice_tts_voice');
    if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find(v => v.name === voiceName);
        if (voice) utt.voice = voice;
    }
    utt.rate  = parseFloat(localStorage.getItem('fg_voice_tts_rate')  || '1');
    utt.pitch = parseFloat(localStorage.getItem('fg_voice_tts_pitch') || '1');
    window.speechSynthesis.speak(utt);
}

async function _apiSpeak(text, key, provider, model, entryKey) {
    const url = _speechUrl(provider);
    if (!url) return;
    const voiceId = localStorage.getItem(`fg_voice_apiv_${entryKey}`)
                 || _TTS_VOICE_DEFAULTS[entryKey]
                 || 'alloy';
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: text, voice: voiceId }),
        });
        if (!r.ok) { console.error('[voice] TTS error:', await r.text()); return; }
        const blob    = await r.blob();
        const audioUrl = URL.createObjectURL(blob);
        _ttsAudio = new Audio(audioUrl);
        _ttsAudio.onended = () => URL.revokeObjectURL(audioUrl);
        await _ttsAudio.play();
    } catch (e) {
        console.error('[voice] TTS error:', e);
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
    window.speechSynthesis?.cancel();
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
}

// ── Speaker buttons ──────────────────────────────────────────────────────────

function addVoiceButtons() {
    let didAdd: boolean = false;
    document.querySelectorAll('.agent-msg-model:not(.has-speak-btn)').forEach(div => {
        const bubble = div.querySelector('.agent-msg-bubble') as HTMLElement | null;
        if (!bubble) return;
        div.classList.add('has-speak-btn');
        didAdd = true;
    });
    if (didAdd && localStorage.getItem('fg_voice_tts_auto') === '1') {
        const last = document.querySelector('.agent-msg-model.has-speak-btn:last-of-type .agent-msg-bubble') as HTMLElement | null;
        if (last) speakText(last.innerText);
    }
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { toggleVoiceInput, speakText, stopSpeaking, addVoiceButtons });
