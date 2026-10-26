import { escapeHtml, jsArg } from './html-escape.js';
import { turnSoundEnabled } from './turn-sound.js';
import { setPref, onPrefChange } from './prefs.js';
import { getDevKey, DEV_KEY_LS } from './proxy.js';
import { getPrivacyLevel, setPrivacyLevel, parsePrivacyLevel, PRIVACY_LABELS, PRIVACY_HELP } from './privacy.js';
import { specBlockedByPrivacy } from './config.js';
import { clearAllCooldowns } from './model-router.js';
import { fmtDelay } from './retry.js';
import { bestLadder, formatLadder, MODEL_LADDER_DATE } from './ladder-info.js';
import { modelPageUrl as _modelPageUrl } from './model-page-url.js';
import { detectEndpoint, LOCAL_ENDPOINT_PRESETS } from './endpoint-detect.js';
// settings-ui.js — FreeGent: settings modal, populateSettingsForm, header model displays
// Depends on: config.js, llm-loops.js

// Guard for populateSettingsForm — prevents auto-save during programmatic population.
// Written to window so init.ts can read it by name without importing this module.
window._settingsPopulating = false;

function switchSettingsTab(tab) {
    document.querySelectorAll('.settings-tab-btn').forEach(btn =>
        btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab));
    document.querySelectorAll('.settings-tab-panel').forEach(panel =>
        panel.classList.toggle('active', (panel as HTMLElement).dataset.tab === tab));
}

// ── Voice model catalogs ─────────────────────────────────────────────────────

const _VOICE_STT_CATALOG = [
    { key: 'browser|webspeech',                       label: 'Web Speech API',             provider: 'browser',    note: 'Free · browser built-in' },
    { key: 'groq|whisper-large-v3-turbo',             label: 'Whisper Large v3 Turbo',     provider: 'groq',       note: 'Fast · multilingual' },
    { key: 'groq|whisper-large-v3',                   label: 'Whisper Large v3',           provider: 'groq',       note: 'Most accurate' },
    { key: 'groq|distil-whisper-large-v3-en',         label: 'Distil Whisper v3 EN',       provider: 'groq',       note: 'English · fastest' },
    { key: 'openrouter|nvidia/parakeet-tdt-0.6b-v3',  label: 'Parakeet TDT 0.6B v3',       provider: 'openrouter', note: 'NVIDIA · multilingual · free tier' },
    { key: 'openrouter|qwen/qwen3-asr-flash',         label: 'Qwen3 ASR Flash',            provider: 'openrouter', note: 'Alibaba · 11 languages · free tier' },
];

const _VOICE_TTS_CATALOG = [
    { key: 'browser|webspeech',                                  label: 'Web Speech Synthesis',     provider: 'browser',    note: 'Free · browser built-in' },
    { key: 'openrouter|mistralai/voxtral-mini-tts-2603',         label: 'Voxtral Mini TTS',         provider: 'openrouter', note: 'Via OpenRouter · free tier' },
    { key: 'openrouter|hexgrad/kokoro-82m',                      label: 'Kokoro 82M',               provider: 'openrouter', note: 'Open-weight · 8 languages · free tier' },
    { key: 'openrouter|google/gemini-3.1-flash-tts-preview',     label: 'Gemini 3.1 Flash TTS',     provider: 'openrouter', note: '70+ languages' },
];

function _getVoiceList(storageKey, defaultList) {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null') || defaultList; }
    catch { return defaultList; }
}

function _saveVoiceList(storageKey, arr) {
    localStorage.setItem(storageKey, JSON.stringify(arr));
}

function _renderVoicePriorityList(containerId, catalog, storageKey, defaultList) {
    const container = (document.getElementById(containerId) as HTMLInputElement);
    if (!container) return;
    const list = _getVoiceList(storageKey, defaultList);
    const byKey = Object.fromEntries(catalog.map(e => [e.key, e]));

    let html = '<div class="model-priority-list">';
    if (!list.length) {
        html += '<div class="model-priority-empty">(none)</div>';
    }
    for (let i = 0; i < list.length; i++) {
        const entry = byKey[list[i]] || { key: list[i], label: list[i], provider: list[i].split('|')[0], note: '' };
        const rankCls = i === 0 ? ' model-priority-rank-1' : '';
        html += `<div class="model-priority-row${rankCls}">
  <span class="model-priority-rank">${i + 1}</span>
  <span class="model-priority-label">${escapeHtml(entry.label)}</span>
  <span class="model-priority-provider">${_providerLabel(entry.provider)}</span>
  <span class="model-priority-cool" style="font-size:10px;color:var(--muted)">${escapeHtml(entry.note)}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" title="Move to the top" onclick="_moveVoiceItem('${storageKey}',${i},-1,'${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" title="Move to the bottom" onclick="_moveVoiceItem('${storageKey}',${i},1,'${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
    <button class="model-table-btn" onclick="_removeVoiceItem('${storageKey}',${i},'${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">✕</button>
  </span>
</div>`;
    }
    html += '</div>';

    const available = catalog.filter(e => !list.includes(e.key));
    html += `<div style="margin-top:6px;display:flex;gap:8px;align-items:center">
  <select class="settings-input model-priority-add-select" id="${containerId}-add-sel" style="flex:1">
    <option value="">— Add model —</option>
    ${available.map(e => `<option value="${e.key}">${_providerLabel(e.provider)} — ${e.label}</option>`).join('')}
  </select>
  <button class="ws-action-btn" onclick="_addVoiceItem('${storageKey}','${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">Add</button>
</div>`;

    container.innerHTML = html;
}

function _addVoiceItem(storageKey, containerId, type) {
    const sel = (document.getElementById(`${containerId}-add-sel`) as HTMLInputElement);
    if (!sel?.value) return;
    const list = _getVoiceList(storageKey, type === 'stt' ? ['groq|whisper-large-v3-turbo','browser|webspeech'] : ['browser|webspeech']);
    if (!list.includes(sel.value)) { list.push(sel.value); _saveVoiceList(storageKey, list); }
    _renderVoicePriorityList(containerId, type === 'stt' ? _VOICE_STT_CATALOG : _VOICE_TTS_CATALOG, storageKey, list);
}

function _removeVoiceItem(storageKey, idx, containerId, type) {
    const def = type === 'stt' ? ['groq|whisper-large-v3-turbo','browser|webspeech'] : ['browser|webspeech'];
    const list = _getVoiceList(storageKey, def);
    list.splice(idx, 1);
    _saveVoiceList(storageKey, list);
    _renderVoicePriorityList(containerId, type === 'stt' ? _VOICE_STT_CATALOG : _VOICE_TTS_CATALOG, storageKey, def);
}

function _moveVoiceItem(storageKey, idx, dir, containerId, type) {
    const def = type === 'stt' ? ['groq|whisper-large-v3-turbo','browser|webspeech'] : ['browser|webspeech'];
    const list = _getVoiceList(storageKey, def);
    if (idx < 0 || idx >= list.length) return;
    // ↑ moves the item to the top of the ranking, ↓ to the bottom.
    const [item] = list.splice(idx, 1);
    if (dir < 0) list.unshift(item); else list.push(item);
    _saveVoiceList(storageKey, list);
    _renderVoicePriorityList(containerId, type === 'stt' ? _VOICE_STT_CATALOG : _VOICE_TTS_CATALOG, storageKey, def);
}

// ── Voice settings save / populate ──────────────────────────────────────────

function saveVoiceSettings() {
    const get = id => (document.getElementById(id) as HTMLInputElement);
    localStorage.setItem('fg_voice_stt_lang',  get('voice-stt-lang')?.value  || '');
    localStorage.setItem('fg_voice_tts_auto',  get('voice-tts-auto')?.checked ? '1' : '0');
    localStorage.setItem('fg_voice_tts_voice', get('voice-tts-voice')?.value  || '');
    localStorage.setItem('fg_voice_tts_rate',  get('voice-tts-rate')?.value   || '1');
    localStorage.setItem('fg_voice_tts_pitch', get('voice-tts-pitch')?.value  || '1');
}

function populateVoiceTab() {
    _renderVoicePriorityList('voice-stt-list', _VOICE_STT_CATALOG, 'fg_voice_stt_list',
        ['groq|whisper-large-v3-turbo', 'browser|webspeech']);
    _renderVoicePriorityList('voice-tts-list', _VOICE_TTS_CATALOG, 'fg_voice_tts_list',
        ['browser|webspeech']);

    const set = (id, val) => { const el = (document.getElementById(id) as HTMLInputElement); if (el) el.value = val; };
    set('voice-stt-lang',  localStorage.getItem('fg_voice_stt_lang')  || '');
    set('voice-tts-rate',  localStorage.getItem('fg_voice_tts_rate')  || '1');
    set('voice-tts-pitch', localStorage.getItem('fg_voice_tts_pitch') || '1');
    const autoEl = (document.getElementById('voice-tts-auto') as HTMLInputElement);
    if (autoEl) autoEl.checked = localStorage.getItem('fg_voice_tts_auto') === '1';
    const rateVal  = (document.getElementById('voice-tts-rate-val') as HTMLInputElement);
    if (rateVal)  rateVal.textContent  = localStorage.getItem('fg_voice_tts_rate')  || '1';
    const pitchVal = (document.getElementById('voice-tts-pitch-val') as HTMLInputElement);
    if (pitchVal) pitchVal.textContent = localStorage.getItem('fg_voice_tts_pitch') || '1';

    // Populate browser voice list
    const voiceSel = (document.getElementById('voice-tts-voice') as HTMLInputElement);
    if (!voiceSel) return;
    const savedVoice = localStorage.getItem('fg_voice_tts_voice') || '';
    const fillVoices = () => {
        const voices = window.speechSynthesis?.getVoices() || [];
        voiceSel.innerHTML = '<option value="">(browser default)</option>';
        voices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (v.name === savedVoice) opt.selected = true;
            voiceSel.appendChild(opt);
        });
    };
    fillVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = fillVoices;
}

// Opens Settings on the Models tab: its callers send the person there to choose a model or add a key
// (activateTab alone lands on Profiles).
function showSettings() {
    activateTab('settings');
    switchSettingsTab('model');
}

function _applySandboxProviderUI(val) {
    const wasmHint  = (document.getElementById('sandbox-wasm-hint') as HTMLElement);
    const localHint = (document.getElementById('sandbox-local-hint') as HTMLElement);
    if (wasmHint)  wasmHint.style.display  = val === 'wasm'  ? '' : 'none';
    if (localHint) localHint.style.display = val === 'local' ? '' : 'none';
}

// Settings → Privacy and the sidebar's Privacy button: one of 'routed' | 'provider' | 'local' (privacy.ts). Takes effect at once.
const _PRIVACY_NOTES: Record<string, string> = {
    routed:   '',
    provider: 'Models that browsers cannot call directly (NVIDIA, Kilo) are left out of the rotation on a hosted page. Shared keys held by the Worker are not available.',
    local:    'Only local models are usable. Add one under Models → Add custom model (for example http://localhost:11434/v1).',
};
function _applyPrivacyLevelUI(level: string) {
    document.querySelectorAll<HTMLInputElement>('input[name="privacy-level"]').forEach(r => { r.checked = r.value === level; });
    const note = document.getElementById('privacy-level-note');
    if (note) note.textContent = _PRIVACY_NOTES[level] || '';
    const restricted = level !== 'routed';
    for (const id of ['privacy-geo', 'privacy-analytics', 'search-proxy']) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        // The page-view counter is a browser-side request to a third party, so only Local switches it off.
        if (el) el.disabled = id === 'privacy-analytics' ? level === 'local' : restricted;
    }
    // Sidebar button: shows the current level, and the menu marks it.
    const lbl = document.getElementById('privacy-btn-label');
    if (lbl) lbl.textContent = 'Privacy: ' + (PRIVACY_LABELS[level as keyof typeof PRIVACY_LABELS] || level);
    const btn = document.getElementById('privacy-btn');
    if (btn) btn.dataset.level = level;
    if (btn) btn.title = 'Privacy: ' + (PRIVACY_LABELS[level as keyof typeof PRIVACY_LABELS] || level) + '. ' + (PRIVACY_HELP[level as keyof typeof PRIVACY_HELP] || '');
    document.querySelectorAll<HTMLElement>('#privacy-menu [data-level]').forEach(o => {
        const on = o.dataset.level === level;
        o.classList.toggle('active', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
    });
}
function onPrivacyLevelChange(level: string) {
    setPrivacyLevel(parsePrivacyLevel(level) ?? 'provider');
    const now = getPrivacyLevel();
    _applyPrivacyLevelUI(now);
    // Shared Worker keys come and go with the level, and so do the models that can be reached.
    (window as any).loadCfWorkerKeys?.()?.catch?.(() => {});
    renderMainModelList?.();
    renderModelCatalogTable?.();
    updateActiveModelDisplay?.();
}

function onPrivacyChange(which: 'geo' | 'analytics', checked: boolean) {
    if (which === 'geo') {
        localStorage.setItem('fg_geo_lookup', checked ? '1' : '0');
        if (checked) prefetchGeoCache?.().catch(() => {});
    } else {
        localStorage.setItem('fg_analytics', checked ? '1' : '0');
    }
}

function onPyodideAutoloadChange(checked) {
    localStorage.setItem('fg_pyodide_autoload', checked ? '1' : '0');
    if (checked && (typeof pyodideStatus === 'undefined' || pyodideStatus === 'idle'))
        startPyodide?.();
}

function onSandboxProviderChange() {
    const sel = (document.getElementById('sandbox-provider') as HTMLInputElement);
    const val = sel?.value || 'none';
    _applySandboxProviderUI(val);
    setPref('fg_sandbox_provider', val);
    saveSettings();
}

// Mapping from .env variable names → { localStorage key, settings input id, label, key prefixes }.
// Prefixes let the paste box recognise bare keys; Stack Exchange keys have none.
const ENV_KEY_MAP: Record<string, { ls: string; input: string; label: string; prefixes: string[] }> = {
    GEMINI_API_KEY:       { ls: 'fg_gemini_key',        input: 'gemini-key',        label: 'Gemini',        prefixes: ['AIza'] },
    GROQ_API_KEY:         { ls: 'fg_groq_key',          input: 'groq-key',          label: 'Groq',          prefixes: ['gsk_'] },
    OPENROUTER_API_KEY:   { ls: 'fg_openrouter_key',    input: 'openrouter-key',    label: 'OpenRouter',    prefixes: ['sk-or-'] },
    NVIDIA_API_KEY:       { ls: 'fg_nvidia_key',        input: 'nvidia-key',        label: 'NVIDIA',        prefixes: ['nvapi-'] },
    TOKENHARBOR_API_KEY:  { ls: 'fg_tokenharbor_key',   input: 'tokenharbor-key',   label: 'TokenHarbor',   prefixes: ['thk_'] },
    KILO_API_KEY:         { ls: 'fg_kilo_key',          input: 'kilo-key',          label: 'Kilo',          prefixes: ['sk-kilo-'] },
    VERCEL_API_KEY:       { ls: 'fg_vercel_key',        input: 'vercel-key',        label: 'Vercel',        prefixes: ['aig_'] },
    NOUSPORTAL_API_KEY:   { ls: 'fg_nous_key',          input: 'nous-key',          label: 'Nous Portal',   prefixes: ['nsk-'] },
    HF_API_KEY:           { ls: 'fg_hf_key',            input: 'hf-key',            label: 'HuggingFace',   prefixes: ['hf_'] },
    TAVILY_API_KEY:       { ls: 'fg_tavily_key',        input: 'tavily-key',        label: 'Tavily',        prefixes: ['tvly-'] },
    BRAVE_API_KEY:        { ls: 'fg_brave_key',         input: 'brave-key',         label: 'Brave',         prefixes: ['BSA'] },
    GITHUB_TOKEN:         { ls: 'fg_github_token',      input: 'github-token',      label: 'GitHub',        prefixes: ['ghp_', 'github_pat_'] },
    STACKEXCHANGE_API_KEY:{ ls: 'fg_stackexchange_key', input: 'stackexchange-key', label: 'Stack Exchange', prefixes: [] },
};

// Parse KEY=VALUE lines for known variables; strip quotes and inline comments.
function parseEnvText(text: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/^export\s+/, '');
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        if (!ENV_KEY_MAP[key]) continue;          // ignore unknown vars
        let val = line.slice(eq + 1).trim();
        val = val.replace(/^['"]|['"]$/g, '');    // strip surrounding quotes
        val = val.replace(/\s*#.*$/, '').trim();  // strip inline comments
        if (val) found[key] = val;
    }
    return found;
}

// Find every recognised key in free text (bare keys, .env lines, JSON, prose).
// Each token of key characters is matched against all prefixes, longest first;
// the first key per provider wins. NAME=value lines fill in prefix-less keys.
export function findKeysInText(text: string): Record<string, string> {
    const prefixes = Object.entries(ENV_KEY_MAP)
        .flatMap(([env, { prefixes }]) => prefixes.map(p => ({ env, p })))
        .sort((a, b) => b.p.length - a.p.length);
    const found: Record<string, string> = {};
    for (const tok of text.match(/[A-Za-z0-9_-]{20,}/g) || []) {
        const hit = prefixes.find(({ p }) => tok.startsWith(p));
        if (hit && !found[hit.env]) found[hit.env] = tok;
    }
    for (const [env, val] of Object.entries(parseEnvText(text))) {
        if (!found[env]) found[env] = val;
    }
    return found;
}

function applyFoundKeys(found: Record<string, string>) {
    for (const [envVar, val] of Object.entries(found)) {
        const { ls, input: inputId } = ENV_KEY_MAP[envVar];
        localStorage.setItem(ls, val);
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        if (el) { el.value = val; el.dataset.fgLoaded = '1'; }
    }
    (window as any).renderModelCatalogTable?.();
    (window as any).renderMainModelList?.();
}

// "Extract from file": same prefix scan as the paste box, over any text file.
(window as any).importEnvFile = function(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        fillKeysFromText((e.target?.result as string) || '');
        input.value = '';  // reset so same file can be re-imported if needed
    };
    reader.readAsText(file);
};

function fillKeysFromText(text: string) {
    const status = document.getElementById('key-paste-status');
    const box = document.getElementById('key-paste') as HTMLTextAreaElement | null;
    const found = findKeysInText(text);
    const labels = Object.keys(found).map(env => ENV_KEY_MAP[env].label);
    // Filling an empty field needs no question; replacing a working key with a different one does
    // (a log excerpt or another project's .env pasted by mistake would otherwise overwrite it).
    const replaced = Object.entries(found)
        .filter(([env, val]) => { const old = localStorage.getItem(ENV_KEY_MAP[env].ls); return !!old && old !== val; })
        .map(([env]) => ENV_KEY_MAP[env].label);
    if (replaced.length && !confirm(`This replaces the saved key for: ${replaced.join(', ')}. Continue?`)) {
        if (box) { box.value = ''; _keyPasteLen = 0; }
        if (status) status.textContent = 'Cancelled — no keys changed.';
        return;
    }
    if (labels.length) {
        applyFoundKeys(found);
        if (box) { box.value = ''; _keyPasteLen = 0; }  // don't leave keys sitting in plain text
    }
    // One short line that is not a provider key is most likely the Worker's Developer key (this box
    // used to take it): do not leave it sitting in plain text here, and say where it goes.
    const t = text.trim();
    const looksLikeDevKey = !labels.length && t.length >= 4 && t.length <= 200 && !t.includes('\n') && !t.includes('=');
    if (looksLikeDevKey) {
        if (box) { box.value = ''; _keyPasteLen = 0; }
        if (status) status.textContent = 'Not a provider API key. A Developer key goes in the "Developer key" field below.';
        try { (document.getElementById('dev-key') as HTMLInputElement | null)?.focus(); } catch {}
        return;
    }
    if (status) status.textContent = labels.length
        ? `✓ Filled ${labels.length}: ${labels.join(', ')}${replaced.length ? ` (replaced: ${replaced.join(', ')})` : ''}`
        : 'No recognised keys found.';
}

// Scan whenever ≥20 chars arrive at once: paste, drop, or a mobile keyboard's clipboard
// chip (which inserts as typing, with no paste event). Keystrokes never trigger a scan.
let _keyPasteLen = 0;
(window as any).onKeyPasteInput = function(box: HTMLTextAreaElement) {
    const grew = box.value.length - _keyPasteLen;
    if (grew >= 20) fillKeysFromText(box.value);
    _keyPasteLen = box.value.length;
};
(window as any).fillKeysFromBox = function(box: HTMLTextAreaElement) {
    if (box.value.trim()) return fillKeysFromText(box.value);
    _keyPasteLen = 0;
};
// The Developer key field (end of API Credentials): unlocks the Worker's shared keys and turns on
// developer logging. Empty removes it.
(window as any).saveDevKey = function(input: HTMLInputElement) {
    const v = input.value.trim();
    // A newly saved Developer key only works through the Worker, so it moves the level to Routed (it can be changed back).
    const wasEmpty = !getDevKey();
    try { if (v) localStorage.setItem(DEV_KEY_LS, v); else { localStorage.removeItem(DEV_KEY_LS); localStorage.removeItem('fg_pass'); } } catch {}
    try { (window as any).refreshCloudSyncButton?.(); } catch {}
    if (v && wasEmpty) { onPrivacyLevelChange('routed'); return; }
    (window as any).loadCfWorkerKeys?.()?.catch?.(() => {});
    (window as any).renderMainModelList?.();
};
// Clipboard reads need a secure context (https or localhost), browser support and
// permission. On failure, say which and focus the box so a manual paste is one keystroke.
(window as any).pasteKeysFromClipboard = async function() {
    const fail = (why: string) => {
        const status = document.getElementById('key-paste-status');
        if (status) status.textContent = `${why} — paste into the box (Ctrl+V / long-press).`;
        document.getElementById('key-paste')?.focus();
    };
    if (!window.isSecureContext) return fail('Clipboard needs https or localhost');
    if (!navigator.clipboard?.readText) return fail('This browser does not allow reading the clipboard');
    try {
        fillKeysFromText(await navigator.clipboard.readText());
    } catch (e: any) {
        fail(e?.name === 'NotAllowedError' ? 'Clipboard permission denied' : `Clipboard read failed (${e?.name || e})`);
    }
};

function saveSettings() {
    // Guard: only write API key fields when the input has a value OR was explicitly
    // populated by populateSettingsForm (data-fg-loaded="1") and then cleared.
    // An empty field without data-fg-loaded means the form opened before the keys
    // endpoint returned — preserve whatever is stored rather than overwriting with ''.
    const saveKey = (lsKey: string, inputId: string) => {
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        const val = el ? el.value.trim() : '';
        // A server-key placeholder is never stored: the server keeps the key.
        if (typeof isServerKeyPlaceholder === 'function' && isServerKeyPlaceholder(val)) return;
        // Unchanged since the form was filled: not this control's write. A tab whose form was filled before another tab
        // stored a newer key wrote its old key back whenever any other field was edited (codex 243/244).
        if (el && el.dataset.fgBase !== undefined && val === el.dataset.fgBase) return;
        if (val) {
            setPref(lsKey, val);
            if (el) el.dataset.fgBase = val;
        } else if (el?.dataset.fgLoaded) {
            // Field was shown with a value and user deliberately cleared it — honour that.
            setPref(lsKey, '');
            el.dataset.fgBase = '';
        }
        // else: field never populated (race with keys endpoint) — leave stored value intact.
    };
    // The two provider selects the same way: written only when this form changed them.
    const saveSelect = (lsKey: string, inputId: string, fallback: string) => {
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        const val = el?.value || fallback;
        if (el && el.dataset.fgBase !== undefined && val === el.dataset.fgBase) return;
        setPref(lsKey, val);
        if (el) el.dataset.fgBase = val;
    };

    saveKey('fg_gemini_key',        'gemini-key');
    saveKey('fg_groq_key',          'groq-key');
    saveKey('fg_nvidia_key',        'nvidia-key');
    saveKey('fg_openrouter_key',    'openrouter-key');
    saveKey('fg_tokenharbor_key',   'tokenharbor-key');
    saveKey('fg_kilo_key',          'kilo-key');
    saveKey('fg_vercel_key',        'vercel-key');
    saveKey('fg_nous_key',          'nous-key');
    saveSelect('fg_sandbox_provider', 'sandbox-provider', 'wasm');
    saveSelect('fg_search_provider', 'search-provider', 'auto');
    saveKey('fg_tavily_key',        'tavily-key');
    saveKey('fg_hf_key',            'hf-key');
    saveKey('fg_search_proxy',      'search-proxy');
    saveKey('fg_brave_key',         'brave-key');
    saveKey('fg_github_token',      'github-token');
    saveKey('fg_stackexchange_key', 'stackexchange-key');

    // Key changes flip "no key" / ✗ status in the model lists.
    renderModelCatalogTable();
    renderMainModelList();
    updateModelLabel();
    updateActiveModelDisplay();
}

function populateSettingsForm() {
    window._settingsPopulating = true;
    // Mark each input as populated so saveKey() can distinguish a deliberately-cleared
    // field from one that was never shown a value (race with the keys endpoint).
    const set = (id, val) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return;
        // Keys held by the dev server reach the page only as placeholders: leave the field empty
        // and say where the key comes from. Typing a key here overrides the server's.
        if (typeof isServerKeyPlaceholder === 'function' && isServerKeyPlaceholder(val)) {
            el.value = '';
            el.placeholder = 'Set in ~/.config/freegent/credentials (kept on the server)';
            return;
        }
        el.value = val;
        el.dataset.fgBase = String(val ?? '');   // what this form showed: saveSettings() writes a control only when it differs
        if (val) el.dataset.fgLoaded = '1';
    };
    set('dev-key',        getDevKey());
    set('gemini-key',     getGeminiKey());
    set('groq-key',       getGroqKey());
    set('nvidia-key',     getNvidiaKey());
    set('openrouter-key', getOpenRouterKey());
    set('tokenharbor-key',   getTokenHarborKey());
    set('kilo-key',          getKiloKey());
    set('vercel-key',        getVercelKey());
    set('nous-key',          getNousKey());
    const pyAuto = (document.getElementById('pyodide-autoload') as HTMLInputElement);
    if (pyAuto) pyAuto.checked = localStorage.getItem('fg_pyodide_autoload') !== '0';
    _applyPrivacyLevelUI(getPrivacyLevel());
    const geoCb = (document.getElementById('privacy-geo') as HTMLInputElement);
    if (geoCb) geoCb.checked = localStorage.getItem('fg_geo_lookup') !== '0';
    const anCb = (document.getElementById('privacy-analytics') as HTMLInputElement);
    if (anCb) anCb.checked = localStorage.getItem('fg_analytics') !== '0' && navigator.doNotTrack !== '1';
    const sbp = (document.getElementById('sandbox-provider') as HTMLInputElement);
    if (sbp) {
        let sbpVal = getSandboxProvider();
        if (!['none', 'local', 'wasm'].includes(sbpVal)) { sbpVal = 'wasm'; localStorage.setItem('fg_sandbox_provider', 'wasm'); }
        sbp.value = sbpVal;
        sbp.dataset.fgBase = sbpVal;
    }
    _applySandboxProviderUI(sbp?.value || getSandboxProvider());
    const sp = (document.getElementById('search-provider') as HTMLInputElement);
    if (sp) { sp.value = getSearchProvider(); sp.dataset.fgBase = sp.value; }
    set('tavily-key',   getTavilyKey());
    set('hf-key',       getHFKey());
    set('search-proxy', getSearchProxy());
    set('brave-key',    getBraveKey());
    set('github-token', getGithubToken());
    set('stackexchange-key', getStackExchangeKey());
    renderModelCatalogTable();
    renderMainModelList();
    renderSkillsChecklist();
    renderToolsChecklist();
    populateAgentSettings();
    renderMediaModelSelectors();
    renderWorkerModelSelector();
    renderUtilityModelSelector();
    populateSamplingSettings();
    window._settingsPopulating = false;
}


function updateActiveModelDisplay() {
    const mainEl = (document.getElementById('hdr-model-display') as HTMLInputElement);
    if (!mainEl) return;

    const list = getActiveMainModelList();
    let activeKey = list[0] || '';
    for (const key of list) {
        if (getCooldownRemaining(key) === 0) { activeKey = key; break; }
    }

    const label = modelFriendlyName(activeKey) || activeKey;
    const rem   = getCooldownRemaining(activeKey);
    mainEl.textContent = rem > 0 ? `${label} ⏳${rem}s` : label;
    mainEl.classList.toggle('hdr-model-cooling', rem > 0);

    updateReasoningSelect();
    updateInputModelBtn(); // keep input-bar button in sync with header
}

// The header's compaction select shows the threshold in force. A value that is not one of its presets (60000 typed in
// Settings → Agent) gets an option of its own, so the header never names a different preset than the setting holds.
function syncHdrCompactSelect() {
    const sel = document.getElementById('hdr-compact-tokens') as HTMLSelectElement | null;
    if (!sel) return;
    const v = String(getAgentCompactTokens());
    sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    if (![...sel.options].some(o => o.value === v)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
            const o = document.createElement('option');
            o.value = v; o.dataset.custom = '1';
            o.textContent = `Compact: ${n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)}K`;
            const after = [...sel.options].find(x => Number(x.value) > n);
            sel.insertBefore(o, after ?? null);
        }
    }
    sel.value = v;
}

function initHdrPicker() {
    updateActiveModelDisplay();
    syncHdrCompactSelect();
}

function refreshCooldowns() { if (typeof getActiveMainModelList === 'function') updateActiveModelDisplay(); }

// 1 Hz on desktop; 5 s on touch-only devices (phones/tablets) to reduce CPU pressure.
// Model cooldown countdown doesn't need sub-second precision on mobile.
const _cooldownTickMs = ('ontouchstart' in window && !window.matchMedia('(hover: hover)').matches) ? 5000 : 1000;
setInterval(() => { if (!document.hidden) refreshCooldowns(); }, _cooldownTickMs);

// ── Model cooldown popup ──────────────────────────────────────────────────
let _cooldownPopupTimer: number | null = null;

function _renderCooldownPopup() {
    const popup = (document.getElementById('model-cooldown-popup') as HTMLInputElement);
    if (!popup) return;
    const list = getActiveMainModelList();
    const rows = [];
    const activeIdx = list.findIndex(k => getCooldownRemaining(k) === 0);
    list.forEach((k, i) => {
        const rem   = getCooldownRemaining(k);
        const label = modelFriendlyName(k) || k.split('|').pop();
        const isActive = i === (activeIdx === -1 ? 0 : activeIdx);
        // A quota that resets in hours or days reads as "3.2h", not "11520s".
        const badge = rem > 0 ? `<span class="mcp-cooling">${fmtDelay(rem * 1000)}</span>` : `<span class="mcp-ok">✓</span>`;
        rows.push(`<div class="mcp-row"><span class="mcp-name${isActive ? ' mcp-active' : ''}">${escapeHtml(label)}</span>${badge}</div>`);
    });
    // Cooldowns now survive a reload, so reloading is no longer a way to retry at once.
    if (list.some(k => getCooldownRemaining(k) > 0))
        rows.push(`<div class="mcp-row"><button type="button" class="mcp-clear" onmousedown="clearModelCooldowns()" title="Forget which models are rate limited or out of quota and try them again">Clear cooldowns</button></div>`);
    popup.innerHTML = rows.join('');
}
function clearModelCooldowns() { clearAllCooldowns(); _renderCooldownPopup(); (window as any).renderMainModelList?.(); }

function showModelCooldownPopup() {
    const popup = (document.getElementById('model-cooldown-popup') as HTMLInputElement);
    if (!popup) return;
    _renderCooldownPopup();
    popup.classList.add('visible');
    _cooldownPopupTimer = setInterval(_renderCooldownPopup, 1000);
}

function hideModelCooldownPopup() {
    (document.getElementById('model-cooldown-popup') as HTMLInputElement)?.classList.remove('visible');
    clearInterval(_cooldownPopupTimer);
    _cooldownPopupTimer = null;
}

function applyHdrCompactTokens() {
    const val = (document.getElementById('hdr-compact-tokens') as HTMLSelectElement)?.value ?? '20000';
    setPref('fg_agent_compact_tokens', val);
    syncHdrCompactSelect();
    // Keep settings panel in sync
    const el = (document.getElementById('agent-compact-tokens') as HTMLInputElement);
    if (el) el.value = val;
}

function applyHdrReasoning() {
    const sel = (document.getElementById('hdr-reasoning') as HTMLInputElement);
    if (sel) setPref('fg_thinking_level', sel.value);
}

function saveSamplingSetting(key, value) {
    // An emptied field is kept as empty: the parameter is then not sent. Removing the key made FreeGent's default come back.
    setPref(key, value.trim());
}
function populateSamplingSettings() {
    const set = (id, lsKey, getter) => {
        const el = (document.getElementById(id) as HTMLInputElement);
        if (!el) return;
        const saved = localStorage.getItem(lsKey);
        el.value = saved !== null ? saved : (typeof getter === 'function' ? String(getter() ?? '') : '');
    };
    set('smp-temperature', 'fg_temperature', getTemperature);
    set('smp-top-p', 'fg_top_p', getTopP);
    set('smp-top-k', 'fg_top_k', getTopK);
    set('smp-min-p', 'fg_min_p', getMinP);
    set('smp-presence-penalty', 'fg_presence_penalty', getPresencePenalty);
    set('smp-repetition-penalty', 'fg_repetition_penalty', getRepetitionPenalty);
}

function getReasoningOptions() {
    return [
        { label: 'Thinking: Default', value: 'default' }, // no thinking arg sent — endpoint uses its own default
        { label: 'Thinking: Off',     value: 'off'    },
        { label: 'Thinking: Low',     value: 'low'    },
        { label: 'Thinking: Medium',  value: 'medium' },
        { label: 'Thinking: High',    value: 'high'   },
    ];
}

function updateReasoningSelect() {
    const sel = (document.getElementById('hdr-reasoning') as HTMLInputElement);
    if (!sel) return;
    const current = getThinkingLevel();
    sel.innerHTML = getReasoningOptions().map(o =>
        `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
    ).join('');
    sel.style.display = '';
}


function _providerLabel(p) {
    return { google:'Google', groq:'Groq', nvidia:'NVIDIA', openrouter:'OpenRouter', nous:'Nous Portal', tokenharbor:'TokenHarbor', kilo:'Kilo', vercel:'Vercel AI Gateway', custom:'Custom' }[p] || p;
}

let _modelSort: { col: string | null; dir: string } = { col: null, dir: 'asc' };


function _sortModelCatalog(col) {
    if (_modelSort.col === col) {
        _modelSort = _modelSort.dir === 'asc' ? { col, dir: 'desc' } : { col: null, dir: 'asc' };
    } else {
        _modelSort = { col, dir: 'asc' };
    }
    renderModelCatalogTable();
}

function renderModelCatalogTable() {
    const container = (document.getElementById('model-catalog-table') as HTMLInputElement);
    if (!container) return;

    if (typeof fillMissingReleased === 'function') fillMissingReleased();
    const all = getAllModels();

    const _fmtParams = p => p == null ? '—' : p >= 1000 ? `${(p/1000).toFixed(0)}T` : `${p}B`;

    // Stable sort — JS Array.sort is stable, so equal values preserve original order.
    const rows = _modelSort.col
        ? [...all].sort((a, b) => {
            const av = a[_modelSort.col], bv = b[_modelSort.col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;   // nulls always last
            if (bv == null) return -1;
            const cmp = typeof av === 'number'  ? av - bv
                      : typeof av === 'boolean' ? (av ? 1 : 0) - (bv ? 1 : 0)
                      : String(av).localeCompare(String(bv));
            return _modelSort.dir === 'desc' ? -cmp : cmp;
        })
        : all;

    const _th = (col, label, tip = '') => {
        const active = _modelSort.col === col;
        const arrow  = active ? (_modelSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        const ta     = tip ? ` title="${tip}"` : '';
        return `<th class="model-table-sortable${active ? ' model-table-sorted' : ''}"${ta} onclick="_sortModelCatalog('${col}')">${label}${arrow}</th>`;
    };

    let html = `<table class="model-table">
<thead><tr>
  ${_th('provider', 'Provider',  'AI provider or API gateway')}
  ${_th('model',    'Model ID',  'Provider-internal model identifier')}
  ${_th('label',    'Label',     'Display name')}
  ${_th('params',   'Params',    'Parameter count (B = billion, T = trillion). Larger generally means more capable but slower.')}
  ${_th('contextK', 'CtxK',      'Context window in thousands of tokens. Larger = can handle longer conversations and documents.')}
  ${_th('released', 'Released',  'Approximate public release date (YYYY-MM)')}
  ${_th('tools',    'Tools',     'Supports function/tool calling (structured API calls to external tools)')}
  ${_th('thinking', 'Think',     'Supports extended thinking / chain-of-thought reasoning mode')}
  ${_th('noKey',    'Key',       'API key status. — = no key needed. ✓ = key configured (local or CF Worker). ✗ = key required but not configured.')}
  ${_th('note',     'Note',      'Capability summary and notable features')}
  <th></th>
</tr></thead><tbody>`;

    for (const m of rows) {
        const key      = `${m.provider}|${m.model}`;
        const editBtn = `<button class="model-table-btn model-table-btn-edit" title="Edit model" onclick="openEditModelDialog(${jsArg(key)})">⚙</button>`;
        const delBtn  = `<button class="model-table-btn" onclick="deleteModel(${jsArg(key)})">✕</button>`;
        const _pageUrl = _modelPageUrl(m.provider, m.model);
        const _idText  = m.model.length > 30 ? m.model.slice(0, 28) + '…' : m.model;
        const _lnk = (text: string, url: string, ttl = url) =>
            url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(ttl)}" class="model-table-link">${escapeHtml(text)}</a>` : escapeHtml(text);
        html += `<tr data-key="${escapeHtml(key)}">
  <td>${_lnk(_providerLabel(m.provider), _pageUrl)}</td>
  <td class="model-table-id">${_lnk(_idText, _pageUrl, m.model)}</td>
  <td>${escapeHtml(m.label)}</td>
  <td class="model-table-params">${_fmtParams(m.params ?? null)}</td>
  <td>${m.contextK}K</td>
  <td${m.releasedEstimated ? ' style="color:var(--muted)" title="Estimated: the provider gave no release date, so this is when the model was first found"' : ''}>${escapeHtml(m.released || '')}</td>
  <td>${m.tools ? '✓' : ''}</td>
  <td>${m.thinking ? '✓' : ''}</td>
  <td>${entryNeedsNoKey(m) ? '<span title="No API key needed (free tier / open access)">—</span>' : _modelHasKey(m) ? '<span style="color:var(--ok,#4a4)" title="Key configured (local or CF Worker)">✓</span>' : '<span style="color:var(--err,#c44)" title="Key required — configure in Settings → API Credentials or add to CF Worker">✗</span>'}</td>
  <td class="model-table-note">${escapeHtml(m.note || '')}</td>
  <td style="white-space:nowrap">${editBtn}${delBtn}</td>
</tr>`;
    }

    html += `</tbody></table>
<div class="model-table-add-row">
  <button class="ws-action-btn" onclick="showAddCustomModelForm()">+ Add custom model</button>
</div>
<div id="add-custom-model-form" style="display:none;margin-top:8px">
  <table class="settings-table" style="width:100%"><tbody>
    <tr><td class="settings-table-label">Provider</td>
        <td><select class="settings-input" id="new-model-provider" style="width:100%" onchange="_onNewModelProviderChange()">
          <option value="openrouter">OpenRouter</option>
          <option value="nous">Nous Portal</option>
          <option value="google">Google</option>
          <option value="nvidia">NVIDIA</option>
          <option value="custom">Custom</option>
        </select></td></tr>
    <tr><td class="settings-table-label">Model ID</td>
        <td><input class="settings-input" id="new-model-id" type="text" list="new-model-id-list" placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free" style="width:100%" onchange="_onNewModelIdChange()"><datalist id="new-model-id-list"></datalist></td></tr>
    <tr><td class="settings-table-label">Label</td>
        <td><input class="settings-input" id="new-model-label" type="text" placeholder="Display name" style="width:100%"></td></tr>
    <tr><td class="settings-table-label">Context (K)</td>
        <td><input class="settings-input" id="new-model-ctx" type="number" value="128" min="1" style="width:100%"></td></tr>
    <tr><td class="settings-table-label">Tools</td>
        <td><input type="checkbox" id="new-model-tools" checked></td></tr>
    <tr><td class="settings-table-label">Thinking</td>
        <td><input type="checkbox" id="new-model-thinking"></td></tr>
    <tr id="new-model-url-row" style="display:none"><td class="settings-table-label">URL</td>
        <td><div style="display:flex;gap:6px"><input class="settings-input" id="new-model-url" type="url" placeholder="http://localhost:8000/v1" style="flex:1"><button class="ws-action-btn" type="button" onclick="detectNewModel()">Detect</button></div>
        <div style="margin-top:4px;font-size:11px;color:var(--muted)">Try: ${LOCAL_ENDPOINT_PRESETS.map(p => `<a href="#" onclick="document.getElementById('new-model-url').value=${jsArg(p.url)};detectNewModel();return false">${escapeHtml(p.label)}</a>`).join(' · ')}</div>
        <div id="new-model-detect-status" style="margin-top:4px;font-size:11px;color:var(--muted)"></div></td></tr>
    <tr id="new-model-key-row" style="display:none"><td class="settings-table-label">Key</td>
        <td><input class="settings-input" id="new-model-key" type="password" placeholder="(leave blank if not required)" style="width:100%"></td></tr>
    <tr id="new-model-api-row" style="display:none"><td class="settings-table-label">API</td>
        <td><select class="settings-input" id="new-model-api" style="width:100%">
          <option value="openai">OpenAI-compatible (default)</option>
          <option value="vllm">vLLM</option>
          <option value="ollama">Ollama (its OpenAI-compatible /v1 API)</option>
        </select></td></tr>
    <tr><td class="settings-table-label">Note</td>
        <td><input class="settings-input" id="new-model-note" type="text" style="width:100%"></td></tr>
  </tbody></table>
  <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
    <button class="btn-save" onclick="addCustomModel()">Add</button>
    <button class="ws-action-btn" onclick="document.getElementById('add-custom-model-form').style.display='none'">Cancel</button>
  </div>
</div>`;

    container.innerHTML = html;
}

function _onNewModelProviderChange() {
    const v = (document.getElementById('new-model-provider') as HTMLInputElement)?.value;
    const show = v === 'custom';
    ['new-model-url-row', 'new-model-key-row', 'new-model-api-row'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
    });
}

function showAddCustomModelForm() {
    const f = (document.getElementById('add-custom-model-form') as HTMLInputElement);
    if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
    _onNewModelProviderChange();
}

// Last detection of the add form, so that choosing another detected model fills its context window.
let _newModelDetected: Array<{ id: string; contextK?: number }> = [];

function _setDetectStatus(id: string, text: string, bad = false) {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.style.color = bad ? 'var(--err,#c44)' : 'var(--muted)'; }
}

async function detectNewModel() {
    const val = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim();
    _setDetectStatus('new-model-detect-status', 'Detecting…');
    const r = await detectEndpoint(val('new-model-url'), val('new-model-key'), { pageProtocol: location.protocol });
    if (!r.ok) { _setDetectStatus('new-model-detect-status', r.error || 'Detection failed.', true); return; }
    _newModelDetected = r.models;
    const dl = document.getElementById('new-model-id-list');
    if (dl) dl.innerHTML = r.models.map(m => `<option value="${escapeHtml(m.id)}"></option>`).join('');
    const set = (id: string, v: string) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = v; };
    set('new-model-api', r.apiFormat);
    const first = r.models[0];
    set('new-model-id', first.id);
    _onNewModelIdChange();
    if (!val('new-model-note')) set('new-model-note', r.server);
    _setDetectStatus('new-model-detect-status', `${r.server}: ${r.models.length} model${r.models.length === 1 ? '' : 's'} found${r.models.length > 1 ? ' (pick one in the Model ID list)' : ''}.`);
}

function _onNewModelIdChange() {
    const id = ((document.getElementById('new-model-id') as HTMLInputElement | null)?.value || '').trim();
    const m = _newModelDetected.find(x => x.id === id);
    if (!m) return;
    const label = document.getElementById('new-model-label') as HTMLInputElement | null;
    if (label) label.value = id.split('/').pop() || id;
    const ctx = document.getElementById('new-model-ctx') as HTMLInputElement | null;
    if (ctx && m.contextK) ctx.value = String(m.contextK);
}

// Edit dialog: asks the server again what it serves and sets the context window (a vLLM server often gets another model at the same address).
async function redetectEditModel() {
    const val = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim();
    const key = val('emd-model-key');
    const model = key.slice(key.indexOf('|') + 1);
    _setDetectStatus('emd-detect-status', 'Detecting…');
    const r = await detectEndpoint(val('emd-url'), val('emd-api-key'), { pageProtocol: location.protocol });
    if (!r.ok) { _setDetectStatus('emd-detect-status', r.error || 'Detection failed.', true); return; }
    const m = r.models.find(x => x.id === model);
    if (!m) { _setDetectStatus('emd-detect-status', `${r.server} serves ${r.models.map(x => x.id).join(', ')}, not "${model}".`, true); return; }
    const fmt = document.getElementById('emd-api-fmt') as HTMLInputElement | null;
    if (fmt) fmt.value = r.apiFormat;
    const ctx = document.getElementById('emd-ctx') as HTMLInputElement | null;
    if (ctx && m.contextK) ctx.value = String(m.contextK);
    _setDetectStatus('emd-detect-status', `${r.server}: context ${m.contextK ? m.contextK + 'K' : 'not reported'}.`);
}

function addCustomModel() {
    const provider  = (document.getElementById('new-model-provider') as HTMLInputElement)?.value || 'custom';
    const model     = ((document.getElementById('new-model-id') as HTMLInputElement)?.value || '').trim();
    const label     = ((document.getElementById('new-model-label') as HTMLInputElement)?.value || model).trim();
    const contextK  = parseInt((document.getElementById('new-model-ctx') as HTMLInputElement)?.value || '128', 10);
    const tools     = (document.getElementById('new-model-tools') as HTMLInputElement)?.checked ?? true;
    const thinking  = (document.getElementById('new-model-thinking') as HTMLInputElement)?.checked ?? false;
    const note      = ((document.getElementById('new-model-note') as HTMLInputElement)?.value || '').trim();
    if (!model) return;
    const entry: any = { provider, model, label, contextK, media:['text'], tools, thinking, note, released:new Date().toISOString().slice(0,7) };
    if (provider === 'custom') {
        const url = ((document.getElementById('new-model-url') as HTMLInputElement)?.value || '').trim();
        const key = ((document.getElementById('new-model-key') as HTMLInputElement)?.value || '').trim();
        const apiFormat = (document.getElementById('new-model-api') as HTMLInputElement)?.value || 'openai';
        if (url) entry.url = url;
        if (key) entry.key = key;
        entry.apiFormat = apiFormat;
    }
    const custom = getCustomModels();
    if (custom.some(c => c.provider === provider && c.model === model)) return;
    custom.push(entry);
    saveCustomModels(custom);
    (document.getElementById('add-custom-model-form') as HTMLInputElement).style.display = 'none';
    renderModelCatalogTable();
    renderMainModelList();
}

function deleteModel(key: string) {
    // Custom models: remove from fg_custom_models
    const custom = getCustomModels();
    const isCustom = custom.some(c => `${c.provider}|${c.model}` === key);
    if (isCustom) {
        saveCustomModels(custom.filter(c => `${c.provider}|${c.model}` !== key));
    } else {
        // Built-in models: add to the hidden-models exclusion set
        hideBuiltinModel?.(key);
    }
    saveMainModelList(getMainModelList().filter(k => k !== key));
    renderModelCatalogTable();
    renderMainModelList();
    updateActiveModelDisplay();
}

// Legacy alias kept for any lingering inline onclick references
function deleteCustomModel(key) { deleteModel(key); }

// ── Edit model dialog ────────────────────────────────────────────────────────

function openEditModelDialog(key: string) {
    const all = getAllModels();
    const m   = all.find(x => `${x.provider}|${x.model}` === key);
    if (!m) return;
    const isCustomProvider = m.provider === 'custom' || m.provider === 'vllm';

    document.getElementById('fg-edit-model-dialog')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'fg-edit-model-dialog';
    overlay.className = 'fg-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.innerHTML = `<div class="fg-modal" style="max-width:520px;width:95%">
  <div class="fg-modal-header">
    <span class="fg-modal-title">Edit — ${escapeHtml(m.provider)}:${escapeHtml(m.model)}</span>
    <button class="fg-modal-close" onclick="document.getElementById('fg-edit-model-dialog')?.remove()">✕</button>
  </div>
  <div class="fg-modal-body" style="padding:12px 16px">
    <input type="hidden" id="emd-model-key" value="${escapeHtml(key)}">
    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap;width:90px">Label</td>
          <td><input class="settings-input" id="emd-label" type="text" value="${escapeHtml(m.label)}" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Params (B)</td>
          <td><input class="settings-input" id="emd-params" type="number" min="0" step="any" value="${m.params ?? ''}" placeholder="blank = unknown" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Context (K)</td>
          <td><input class="settings-input" id="emd-ctx" type="number" min="1" value="${m.contextK || 128}" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Released</td>
          <td><input class="settings-input" id="emd-released" type="text" value="${escapeHtml(m.released)}" placeholder="YYYY-MM" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">RPM limit</td>
          <td><input class="settings-input" id="emd-rpm" type="number" min="0" value="${m.rpm ?? ''}" placeholder="(no limit)" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">RPD limit</td>
          <td><input class="settings-input" id="emd-rpd" type="number" min="0" value="${m.rpd ?? ''}" placeholder="(no limit)" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Tools</td>
          <td style="padding-top:4px"><input type="checkbox" id="emd-tools" ${m.tools ? 'checked' : ''}></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Thinking</td>
          <td style="padding-top:4px"><input type="checkbox" id="emd-thinking" ${m.thinking ? 'checked' : ''}></td></tr>
      ${isCustomProvider ? `
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">URL</td>
          <td><input class="settings-input" id="emd-url" type="url" value="${escapeHtml(m.url)}" placeholder="http://localhost:8000/v1" style="margin:0;width:100%">
          <div style="margin-top:4px"><button class="ws-action-btn" type="button" onclick="redetectEditModel()">Re-detect</button> <span id="emd-detect-status" style="font-size:11px;color:var(--muted)"></span></div></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">API key</td>
          <td><input class="settings-input" id="emd-api-key" type="password" value="${escapeHtml(m.key)}" placeholder="(blank = not required)" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">API format</td>
          <td><select class="settings-input" id="emd-api-fmt" style="margin:0;width:100%">
            <option value="openai" ${(m.apiFormat || 'openai') === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
            <option value="vllm"   ${m.apiFormat === 'vllm'   ? 'selected' : ''}>vLLM</option>
            <option value="ollama" ${m.apiFormat === 'ollama' ? 'selected' : ''}>Ollama (its OpenAI-compatible /v1 API)</option>
          </select></td></tr>` : ''}
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Note</td>
          <td><input class="settings-input" id="emd-note" type="text" value="${escapeHtml(m.note)}" style="margin:0;width:100%"></td></tr>
    </tbody></table>
  </div>
  <div class="fg-modal-btns">
    <button class="fg-modal-btn fg-modal-btn-cancel" onclick="document.getElementById('fg-edit-model-dialog')?.remove()">Cancel</button>
    <button class="fg-modal-btn fg-modal-btn-ok" onclick="saveEditModel()">Save</button>
  </div>
</div>`;

    document.body.appendChild(overlay);
    overlay.dataset.base = JSON.stringify(_readEditModelForm());
    (document.getElementById('emd-label') as HTMLInputElement)?.focus();
}

// What the edit dialog's form holds, as strings and booleans (also what it held when it opened: Save writes only what changed since).
function _readEditModelForm(): Record<string, string | boolean> {
    const v = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value ?? '');
    const c = (id: string) => !!(document.getElementById(id) as HTMLInputElement | null)?.checked;
    const out: Record<string, string | boolean> = {
        label: v('emd-label').trim(), params: v('emd-params').trim(), ctx: v('emd-ctx').trim(), released: v('emd-released').trim(),
        rpm: v('emd-rpm').trim(), rpd: v('emd-rpd').trim(), tools: c('emd-tools'), thinking: c('emd-thinking'), note: v('emd-note').trim(),
    };
    if (document.getElementById('emd-url'))     out.url = v('emd-url').trim();
    if (document.getElementById('emd-api-key')) out.key = v('emd-api-key').trim();
    if (document.getElementById('emd-api-fmt')) out.apiFormat = v('emd-api-fmt');
    return out;
}

// Save writes the fields this form changed, onto the entry as it is stored now. A form left open while another tab edited or
// deleted the model used to write all its old values back (context and note reverted, codex 357), recreate a deleted model as a
// hidden entry (349), or leave a cleared optional field at its old value (351).
function saveEditModel() {
    const dialog = document.getElementById('fg-edit-model-dialog');
    const key = (document.getElementById('emd-model-key') as HTMLInputElement)?.value;
    if (!key) return;
    let base: Record<string, string | boolean> = {};
    try { base = JSON.parse(dialog?.dataset.base || '{}'); } catch {}
    const cur = _readEditModelForm();
    const changed = (k: string) => k in cur && cur[k] !== base[k];

    const sep      = key.indexOf('|');
    const provider = key.slice(0, sep);
    const model    = key.slice(sep + 1);

    const custom = getCustomModels();
    const idx    = custom.findIndex(c => `${c.provider}|${c.model}` === key);
    const orig   = idx === -1 ? getAllModels().find(x => `${x.provider}|${x.model}` === key) : null;
    if (idx === -1 && !orig) {
        dialog?.remove();
        alert('This model no longer exists (it was removed in another tab), so nothing was saved.');
        renderModelCatalogTable(); renderMainModelList?.();
        return;
    }

    const set: any = {}, drop: string[] = [];
    if (changed('label'))    set.label = cur.label;
    if (changed('ctx'))      set.contextK = parseInt(String(cur.ctx) || '128', 10) || 128;
    if (changed('tools'))    set.tools = cur.tools;
    if (changed('thinking')) set.thinking = cur.thinking;
    if (changed('note'))     set.note = cur.note;
    if (changed('released')) { if (cur.released) { set.released = cur.released; set.releasedEstimated = false; } else drop.push('released'); }
    for (const [field, parse] of [['params', parseFloat], ['rpm', (x: string) => parseInt(x, 10)], ['rpd', (x: string) => parseInt(x, 10)]] as const) {
        if (!changed(field)) continue;
        const raw = String(cur[field]);
        if (raw) set[field] = (parse as any)(raw); else drop.push(field);   // blank = unknown / no limit: the field leaves the entry
    }
    // Emptied means removed, as for the other optional fields: a rotated or revoked key, or an address given up, could not be cleared here and the old
    // value kept being sent (opencode §9). (An untouched field is not "changed", so a key that is never shown in full is not wiped by an unrelated edit.)
    if (changed('url')) { if (cur.url) set.url = cur.url; else drop.push('url'); }
    if (changed('key')) { if (cur.key) set.key = cur.key; else drop.push('key'); }
    if (changed('apiFormat'))            set.apiFormat = cur.apiFormat;
    const apply = (entry: any) => { const e = { ...entry, ...set }; for (const f of drop) delete e[f]; return e; };

    if (idx !== -1) {
        // Update existing custom entry, keeping fields not exposed in the form (e.g. cooldownMs)
        custom[idx] = apply(custom[idx]);
        saveCustomModels(custom);
    } else {
        // Built-in model: hide the original and keep an edited custom copy under the same key
        const merged = apply({ ...orig, provider, model });
        hideBuiltinModel?.(key);
        custom.push(merged);
        saveCustomModels(custom);
    }

    document.getElementById('fg-edit-model-dialog')?.remove();
    renderModelCatalogTable();
    renderMainModelList?.();
}

// ── Multi-selection state for the priority list ──────────────────────────────
// Selections survive re-renders (renderMainModelList replaces DOM but preserves this set).
// Stale keys (no longer in the list) are pruned at render time.
let _prioritySelected = new Set<string>();
let _priorityLastClicked: string | null = null;

// ── Touch drag state for priority list ───────────────────────────────────────
// iOS Safari: draggable="true" on a parent intercepts all touch events from
// child elements — clicking ↑/↓ buttons inside a draggable row is impossible.
// Fix: on touch devices, omit draggable="" and use touchstart/touchmove/touchend
// on a dedicated drag handle element for reordering.
// navigator.maxTouchPoints is undefined on iOS ≤12 (Safari 13+ only); rely on ontouchstart.
const _isTouchDevice: boolean = typeof window !== 'undefined'
    && 'ontouchstart' in window;

interface _TouchDragState {
    containerId: string;
    srcIdx: number;
    srcEl: Element;
}
let _touchDrag: _TouchDragState | null = null;

function _priorityTouchStart(event: TouchEvent, containerId: string, idx: number): void {
    if (event.touches.length !== 1) return;
    const row = (event.currentTarget as Element).closest('.model-priority-row');
    if (!row) return;
    _touchDrag = { containerId, srcIdx: idx, srcEl: row };
    row.classList.add('model-priority-dragging');
}

function _priorityTouchMove(event: TouchEvent): void {
    if (!_touchDrag || event.touches.length !== 1) return;
    event.preventDefault(); // prevent page scroll while drag-reordering
    const { clientX, clientY } = event.touches[0];
    document.querySelectorAll('.model-priority-drag-over')
        .forEach(el => el.classList.remove('model-priority-drag-over'));
    const el = document.elementFromPoint(clientX, clientY);
    const row = el?.closest('.model-priority-row');
    if (row && row !== _touchDrag.srcEl) row.classList.add('model-priority-drag-over');
}

function _priorityTouchEnd(event: TouchEvent): void {
    if (!_touchDrag) return;
    const { srcIdx, srcEl } = _touchDrag;
    _touchDrag = null;
    srcEl.classList.remove('model-priority-dragging');
    document.querySelectorAll('.model-priority-drag-over')
        .forEach(el => el.classList.remove('model-priority-drag-over'));

    const touch = event.changedTouches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const targetRow = el?.closest('.model-priority-row') as HTMLElement | null;
    const targetIdx = targetRow ? parseInt(targetRow.dataset.idx ?? '-1', 10) : -1;
    if (targetIdx >= 0 && targetIdx !== srcIdx) {
        const list = getMainModelList();
        if (srcIdx >= 0 && srcIdx < list.length && targetIdx < list.length) {
            const item = list[srcIdx];
            list.splice(srcIdx, 1);
            list.splice(targetIdx, 0, item);
            saveMainModelList(list);
            renderMainModelList();
            updateActiveModelDisplay();
        }
    }
}

function _priorityRowClick(event: MouseEvent, key: string): void {
    // Ignore clicks on action buttons — let them fall through to their own handlers.
    if ((event.target as Element).closest('button')) return;
    const allKeys = getMainModelList();
    if (event.shiftKey && _priorityLastClicked !== null) {
        // Range: select everything between last-clicked and this row.
        const fromIdx = allKeys.indexOf(_priorityLastClicked);
        const toIdx   = allKeys.indexOf(key);
        if (fromIdx !== -1 && toIdx !== -1) {
            const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
            for (let i = lo; i <= hi; i++) _prioritySelected.add(allKeys[i]);
        }
    } else {
        // Toggle this row.
        if (_prioritySelected.has(key)) _prioritySelected.delete(key);
        else _prioritySelected.add(key);
    }
    if (!event.shiftKey) _priorityLastClicked = key;
    renderMainModelList();
}

function _handleDragStart(event, containerId, idx) {
    event.dataTransfer.setData('text/plain', idx);
    event.target.classList.add('model-priority-dragging');
    event.dataTransfer.effectAllowed = 'move';
}

function _handleDragEnd(event) {
    // Always clean up the dragging highlight — fires whether or not a drop occurred.
    event.target.classList.remove('model-priority-dragging');
    // Also clear any stale drag-over highlights left on other rows.
    document.querySelectorAll('.model-priority-drag-over')
        .forEach(el => el.classList.remove('model-priority-drag-over'));
}

// Return the closest .model-priority-row ancestor (or self) so that
// drag-over/drag-leave operate on the row element, not a child span.
function _priorityRow(el: EventTarget | null): Element | null {
    if (!(el instanceof Element)) return null;
    return el.closest('.model-priority-row') ?? el;
}

function _handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    _priorityRow(event.target)?.classList.add('model-priority-drag-over');
}

function _handleDragLeave(event) {
    _priorityRow(event.target)?.classList.remove('model-priority-drag-over');
}

function _handleDrop(event, containerId, targetIdx) {
    event.preventDefault();
    _priorityRow(event.target)?.classList.remove('model-priority-drag-over');
    const list = getMainModelList();
    const sourceIdx = parseInt(event.dataTransfer.getData('text/plain'), 10);
    if (sourceIdx < 0 || sourceIdx >= list.length || targetIdx < 0 || targetIdx >= list.length) return;

    if (_prioritySelected.size > 1 && _prioritySelected.has(list[sourceIdx])) {
        // Multi-drag: move all selected items to the drop position.
        if (sourceIdx === targetIdx) return;
        const selectedKeys = list.filter(k => _prioritySelected.has(k)); // preserve relative order
        const remaining    = list.filter(k => !_prioritySelected.has(k));
        // Count non-selected items strictly before targetIdx — that's the insertion point in `remaining`.
        const insertionPoint = list.slice(0, targetIdx).filter(k => !_prioritySelected.has(k)).length;
        remaining.splice(insertionPoint, 0, ...selectedKeys);
        saveMainModelList(remaining);
    } else {
        // Single drag.
        if (sourceIdx === targetIdx) return;
        const item = list[sourceIdx];
        list.splice(sourceIdx, 1);
        list.splice(targetIdx, 0, item);
        saveMainModelList(list);
    }
    renderMainModelList();
    updateActiveModelDisplay();
}


// Returns true when a model entry can be used with the current key configuration:
// either it needs no key (entryNeedsNoKey) or its provider has a key set in localStorage.
// custom/vllm entries are always included — the user added them and may have a per-entry key.
// Thin wrapper so callers that have a model entry object can use specHasKey
// (defined in config.ts, which is the single source of truth for key checks).
function _modelHasKey(m: any): boolean {
    return typeof specHasKey === 'function'
        ? specHasKey(`${m.provider}|${m.model}`)
        : true;
}

function _renderPriorityList(containerId, list) {
    const container = (document.getElementById(containerId) as HTMLInputElement);
    if (!container) return;

    // Prune stale selection keys (model was removed from list).
    const listSet = new Set(list);
    for (const k of _prioritySelected) if (!listSet.has(k)) _prioritySelected.delete(k);
    if (!listSet.has(_priorityLastClicked!)) _priorityLastClicked = null;

    // Entries without a key stay visible, shown inactive like paused ones. They used to be filtered
    // out here, which made a saved entry silently vanish (an NVIDIA provider missing from a ranked
    // model's group) and skewed the row indices the move/remove buttons pass for the saved list.
    const _allModelMap = new Map((getAllModels() as any[]).map(m => [`${m.provider}|${m.model}`, m]));
    const noKeySet  = new Set(list.filter(k => { const m = _allModelMap.get(k); return !!m && !_modelHasKey(m); }));
    // Settings → Privacy rules these out of routing too (Kilo and NVIDIA at Provider-only on a static host). They were drawn
    // as active, so a new user saw ranked Kilo models while the chat said "no model", and adding a key changed nothing.
    const blockedSet = new Set(list.filter(k => specBlockedByPrivacy(k)));
    const pausedSet = new Set(getPausedMainModels());
    const _inactive = (k: string) => pausedSet.has(k) || noKeySet.has(k) || blockedSet.has(k);
    const multiSel  = _prioritySelected.size > 1;

    let html = `<div class="model-priority-list">`;
    if (!list.length) {
        html += `<div class="model-priority-empty">(none — all requests will fail)</div>`;
    }
    for (let i = 0; i < list.length; i++) {
        const key = list[i];
        const paused   = pausedSet.has(key);
        const noKey    = noKeySet.has(key);
        const blocked  = blockedSet.has(key);
        const selected = _prioritySelected.has(key);
        const lbl = modelFriendlyName(key) || key;
        const rem = typeof getCooldownRemaining === 'function' ? getCooldownRemaining(key) : 0;
        const coolTag = rem > 0 ? `<span class="model-priority-cool">⏳${rem}s</span>` : '';
        const keyTag  = blocked ? `<span class="model-priority-cool" title="Settings → Privacy (${escapeHtml(PRIVACY_LABELS[getPrivacyLevel()])}) does not allow this provider. Set Privacy to Routed to use it.">blocked by Privacy</span>`
                      : noKey ? `<span class="model-priority-cool" title="No API key for this provider — add one in Settings → Models">no key</span>` : '';
        const rankCls     = (i === 0 && !_inactive(key)) ? ' model-priority-rank-1' : '';
        const pausedCls   = (paused || noKey || blocked) ? ' model-priority-paused'   : '';
        const selectedCls = selected  ? ' model-priority-selected' : '';
        // ↑/↓ title hints: when multiple rows are selected, the button moves them all.
        const upTitle   = (multiSel && selected) ? 'Move selected to the top'    : 'Move to the top';
        const downTitle = (multiSel && selected) ? 'Move selected to the bottom' : 'Move to the bottom';
        // On touch devices, draggable="true" on the row intercepts all child touch
        // events, making the ↑/↓ buttons unresponsive (iOS Safari bug).
        // Instead: omit draggable and use a touch-drag handle with touchstart/touchmove/touchend.
        if (_isTouchDevice) {
            html += `<div class="model-priority-row${rankCls}${pausedCls}${selectedCls}" data-idx="${i}"
            onclick="_priorityRowClick(event,${jsArg(key)})"
            ontouchmove="_priorityTouchMove(event)"
            ontouchend="_priorityTouchEnd(event)">
  <span class="model-priority-drag-handle" title="Drag to reorder"
        ontouchstart="_priorityTouchStart(event,'${containerId}',${i})"
        ontouchmove="_priorityTouchMove(event)"
        ontouchend="_priorityTouchEnd(event)">⠿</span>
  <span class="model-priority-rank">${_inactive(key) ? '–' : i + 1 - [...list.slice(0, i)].filter(_inactive).length}</span>
  <span class="model-priority-label">${escapeHtml(lbl)}${coolTag}${keyTag}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" title="${upTitle}" onclick="_movePriorityItem('${containerId}',${i},-1)">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" title="${downTitle}" onclick="_movePriorityItem('${containerId}',${i},1)">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
    <button class="model-table-btn model-table-btn-pause${paused ? ' active' : ''}" title="${paused ? 'Resume' : 'Pause'}" onclick="_togglePauseItem(${jsArg(key)})">${paused ? '+' : '–'}</button>
    <button class="model-table-btn" title="Remove" onclick="_removePriorityItem('${containerId}',${i})">✕</button>
  </span>
</div>`;
        } else {
            html += `<div class="model-priority-row${rankCls}${pausedCls}${selectedCls}" data-idx="${i}"
            draggable="true"
            onclick="_priorityRowClick(event,${jsArg(key)})"
            ondragstart="_handleDragStart(event, '${containerId}', ${i})"
            ondragover="_handleDragOver(event)"
            ondragleave="_handleDragLeave(event)"
            ondragend="_handleDragEnd(event)"
            ondrop="_handleDrop(event, '${containerId}', ${i})">
  <span class="model-priority-rank">${_inactive(key) ? '–' : i + 1 - [...list.slice(0, i)].filter(_inactive).length}</span>
  <span class="model-priority-label">${escapeHtml(lbl)}${coolTag}${keyTag}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" title="${upTitle}" onclick="_movePriorityItem('${containerId}',${i},-1)">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" title="${downTitle}" onclick="_movePriorityItem('${containerId}',${i},1)">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
    <button class="model-table-btn model-table-btn-pause${paused ? ' active' : ''}" title="${paused ? 'Resume' : 'Pause'}" onclick="_togglePauseItem(${jsArg(key)})">${paused ? '+' : '–'}</button>
    <button class="model-table-btn" title="Remove" onclick="_removePriorityItem('${containerId}',${i})">✕</button>
  </span>
</div>`;
        }
    }
    const _addModels = getAllModels()
        .filter(m => !list.includes(`${m.provider}|${m.model}`) && (!!getDevKey() || _modelHasKey(m)))
        .sort((a, b) => `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`))
        .map(m => ({ value: `${m.provider}|${m.model}`, label: modelFriendlyName(`${m.provider}|${m.model}`) }));
    html += `</div>
<div style="margin-top:6px">
  <div class="model-combo" id="${containerId}-add-combo"
       data-options="${escapeHtml(JSON.stringify(_addModels))}"
       data-addmode="true">
    <input type="text" class="settings-input model-combo-input" placeholder="— Search to add models —" autocomplete="off"
      oninput="_comboFilter('${containerId}-add-combo')"
      onfocus="_comboOpen('${containerId}-add-combo')"
      onblur="_comboBlur('${containerId}-add-combo')"
      onkeydown="_comboKey(event,'${containerId}-add-combo')">
    <div class="model-combo-dropdown" hidden></div>
  </div>
</div>`;

    container.innerHTML = html;
}

function _togglePauseItem(key) {
    const paused = getPausedMainModels();
    const idx = paused.indexOf(key);
    if (idx === -1) paused.push(key); else paused.splice(idx, 1);
    savePausedMainModels(paused);
    renderMainModelList();
    updateActiveModelDisplay();
}

function renderMainModelList() {
    _renderPriorityList('main-model-list', getMainModelList());
    updateInputModelBtn();
}

// ── Input-bar model quick-picker ─────────────────────────────────────────────

function updateInputModelBtn(): void {
    const btn = document.getElementById('input-model-btn');
    if (!btn) return;
    // Mirror the same active-model logic as updateActiveModelDisplay: walk the
    // active (non-paused) list and pick the first model not currently on cooldown.
    const list = typeof getActiveMainModelList === 'function' ? getActiveMainModelList() : [];
    let active = list[0] || '';
    for (const key of list) {
        if (typeof getCooldownRemaining === 'function' && getCooldownRemaining(key) === 0) { active = key; break; }
    }
    const idx      = active.indexOf('|');
    const provider = idx !== -1 ? active.slice(0, idx) : active;
    const modelId  = idx !== -1 ? active.slice(idx + 1) : active;
    const rem      = typeof getCooldownRemaining === 'function' ? getCooldownRemaining(active) : 0;
    const coolSfx  = rem > 0 ? ` ⏳${rem}s` : '';
    const trim     = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
    btn.innerHTML  = active
        ? `<span class="ibtn-provider">${escapeHtml(trim(provider, 16))}</span><span class="ibtn-model">${escapeHtml(trim(modelId, 28))}${coolSfx}</span>`
        : `<span class="ibtn-model">no model</span>`;
    // The visible text is only the model; the name also says what the button does.
    btn.setAttribute('aria-label', active ? `Switch model (current: ${provider} ${modelId})` : 'Switch model (none selected)');
    btn.title = active ? 'Switch model' : _noModelReason();
    // Send is enabled only while a model can answer: the model list just changed (paused, resumed, added, removed).
    (window as any)._updateSendBtnVisibility?.();
}

// Why no model in the priority list can be used, for the input bar's "no model" button and its picker.
function _noModelReason(): string {
    const list = typeof getMainModelList === 'function' ? getMainModelList() : [];
    if (!list.length) return 'The priority list is empty: add a model in Settings → Models.';
    if (list.some(k => specBlockedByPrivacy(k)))
        return `Settings → Privacy is ${PRIVACY_LABELS[getPrivacyLevel()]}, which rules out ${getPrivacyLevel() === 'local' ? 'every cloud model' : 'Kilo and NVIDIA (they cannot be called from a browser without the Worker)'}. Set Privacy to Routed, or add a model from another provider.`;
    return 'Every model in the priority list is paused or has no API key: resume one or add a key in Settings → Models.';
}

function toggleInputModelPicker(): void {
    const picker = document.getElementById('input-model-picker');
    if (!picker) return;
    if (picker.classList.contains('picker-open')) {
        picker.classList.remove('picker-open');
        return;
    }
    _renderInputModelPicker(picker);
    picker.classList.add('picker-open');
    (picker.querySelector('.picker-active, .picker-model-item') as HTMLElement | null)?.focus();   // keyboard: start on the current model
}

function _renderInputModelPicker(picker: HTMLElement): void {
    const raw  = typeof getMainModelList === 'function' ? getMainModelList() : [];
    const all  = typeof getAllModels === 'function' ? getAllModels() : [];
    // Filter to models the user has a key for (mirrors _renderPriorityList behaviour), and to those the privacy level allows.
    const _allModelMap = new Map((all as any[]).map(m => [`${m.provider}|${m.model}`, m]));
    const list = raw.filter(k => { const m = _allModelMap.get(k); return (!m || _modelHasKey(m)) && !specBlockedByPrivacy(k); });
    // The highlighted model is the one requests are routed to: the first that is not paused, not the first in the list.
    const paused = new Set(getPausedMainModels());
    const active = (typeof getActiveMainModelList === 'function' ? getActiveMainModelList() : list)[0] || '';
    const seen = new Set<string>();
    const items: Array<{spec: string; label: string; paused: boolean}> = [];
    for (const spec of list) {
        if (seen.has(spec)) continue;
        seen.add(spec);
        items.push({ spec, label: modelFriendlyName(spec) || spec.replace('|', '/'), paused: paused.has(spec) });
    }
    // Options are real list options: reachable by Tab / arrow keys and chosen with Enter or Space (they were
    // plain divs with a click handler, so a keyboard could open the picker but never pick from it).
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', 'Model');
    picker.innerHTML = items.map(it =>
        `<div class="picker-model-item${it.spec === active ? ' picker-active' : ''}" role="option" tabindex="0" aria-selected="${it.spec === active}"
              onclick="_selectInputModel(${jsArg(it.spec)})">
            <span>${escapeHtml(it.label)}</span>${it.paused ? '<span class="picker-paused" title="Paused: choosing it resumes it"> · paused</span>' : ''}
         </div>`
    ).join('') +
    // With nothing to choose from, say why, and offer the Privacy tab when that is the cause.
    (items.length ? '' : `<div class="picker-note">${escapeHtml(_noModelReason())}</div>` +
        (raw.some(k => specBlockedByPrivacy(k)) ? `<div class="picker-model-item picker-all-link" role="option" tabindex="0" onclick="activateTab('settings');switchSettingsTab('privacy');document.getElementById('input-model-picker')?.classList.remove('picker-open')">Privacy settings…</div>` : '')) +
    `<div class="picker-model-item picker-all-link" role="option" tabindex="0" onclick="showSettings();document.getElementById('input-model-picker')?.classList.remove('picker-open')">Browse all models…</div>`;
    if (!(picker as any)._kbd) {
        (picker as any)._kbd = true;
        picker.addEventListener('keydown', (e: KeyboardEvent) => {
            const opts = [...picker.querySelectorAll<HTMLElement>('.picker-model-item')];
            const i = opts.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(i - 1, 0)]?.focus(); }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (document.activeElement as HTMLElement)?.click(); }
            else if (e.key === 'Escape') { e.preventDefault(); picker.classList.remove('picker-open'); document.getElementById('input-model-btn')?.focus(); }
        });
    }
}

function _selectInputModel(spec: string): void {
    // Choosing a model is choosing to use it: a paused one is resumed. (It used to move to the front and stay paused,
    // so the button, the highlight and the routing disagreed about which model was in use.)
    const paused = getPausedMainModels();
    if (paused.includes(spec)) savePausedMainModels(paused.filter(s => s !== spec));
    const list    = typeof getMainModelList === 'function' ? getMainModelList() : [];
    const newList = [spec, ...list.filter(s => s !== spec)];
    if (typeof saveMainModelList === 'function') saveMainModelList(newList);
    updateInputModelBtn();
    if (typeof updateModelLabel     === 'function') updateModelLabel();
    if (typeof updateActiveModelDisplay === 'function') updateActiveModelDisplay();
    document.getElementById('input-model-picker')?.classList.remove('picker-open');
}

function saveMediaModel(type, value) {
    if (type === 'image') saveImageModel(value);
    else if (type === 'audio') saveAudioModel(value);
    else if (type === 'video') saveVideoModel(value);
}

// ── Model ranking helpers ─────────────────────────────────────────────────
// Total/active parameter counts (billions) from a model description or id:
// "55B active parameters out of 550B total", "118B total parameter", "27B dense",
// or ids like nemotron-3-ultra-550b-a55b / gemma-4-26b-a4b-it / qwen3.8-27b.
export function parseParamsB(desc: string, id: string): { total: number | null; active: number | null } {
    const d = String(desc ?? '');
    const num = (re: RegExp) => { const m = d.match(re); return m ? parseFloat(m[1]) : null; };
    let total = num(/out of (\d+(?:\.\d+)?)\s*B\b/i)
        ?? num(/(\d+(?:\.\d+)?)\s*B\s+total/i)
        ?? num(/(\d+(?:\.\d+)?)\s*B[- ]param/i)
        ?? num(/(\d+(?:\.\d+)?)\s*billion[- ]param/i);
    let active = num(/(\d+(?:\.\d+)?)\s*B\s+active/i);
    const idm = String(id ?? '').toLowerCase().match(/(?:^|[-_.])(\d+(?:\.\d+)?)b(?:-a(\d+(?:\.\d+)?)b)?(?=$|[-_.:])/);
    if (idm) { total ??= parseFloat(idm[1]); if (idm[2]) active ??= parseFloat(idm[2]); }
    return { total, active };
}

type ModelRankGroup = {
    id: string;                 // shown to the ranker: an org/model id without provider suffixes
    entries: any[];             // catalog entries (one per provider) serving this model
    contextK: number | null; paramsB: number | null; activeB: number | null;
    tools: boolean; thinking: boolean; released: string | null;
    aa: { intelligence: number | null; coding: number | null; agentic: number | null } | null;
    live: boolean;              // details came from the live OpenRouter list
    successes: number;          // successful main-agent requests to this model, all providers (recordModelSuccess)
    ladder: string;             // measured microtask/context ladder summary (model ladder), '' when never run
};

// Group available catalog entries by canonical model id and merge their features — live
// OpenRouter details where the model is listed there, else the catalog entries combined
// (largest context and parameter count; tools/thinking if any provider has them; the most
// common release month). Order: first appearance in the catalog.
export function buildModelRankGroups(available: any[], orModels: any[] = [], successCounts: Record<string, number> = {}): ModelRankGroup[] {
    const live = new Map<string, any>();   // canonical id → best OpenRouter record (prefer non-:free)
    const liveCtx = new Map<string, number>();   // canonical id → largest context over all its listings
    for (const om of orModels) {
        if (typeof om?.id !== 'string') continue;
        const cid = canonicalModelId(om.id);
        if (typeof om.context_length === 'number') liveCtx.set(cid, Math.max(liveCtx.get(cid) ?? 0, om.context_length));
        const prev = live.get(cid);
        const hasAA = (x: any) => typeof x?.benchmarks?.artificial_analysis?.intelligence_index === 'number';
        if (!prev || (!hasAA(prev) && hasAA(om)) || (hasAA(prev) === hasAA(om) && /:free$/.test(prev.id) && !/:free$/.test(om.id)))
            live.set(cid, om);
    }
    const byId = new Map<string, ModelRankGroup>();
    for (const m of available) {
        const cid = canonicalModelId(m.model);
        let g = byId.get(cid);
        if (!g) {
            g = { id: cid, entries: [], contextK: null, paramsB: null, activeB: null, tools: false, thinking: false, released: null, aa: null, live: false,
                  successes: Number(successCounts[cid]) || 0, ladder: '' };
            byId.set(cid, g);
        }
        g.entries.push(m);
    }
    const _max = (xs: any[]) => { const v = xs.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? Math.max(...v) : null; };
    const _mode = (xs: any[]) => {
        const c = new Map<string, number>();
        for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
        return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null;
    };
    for (const g of byId.values()) {
        g.ladder = formatLadder(bestLadder(g.entries.map((e: any) => `${e.provider}|${e.model}`)));
        const om = live.get(g.id);
        // Display id: the org/model form when any source has one, minus :free/-free suffixes.
        const withOrg = [om?.id, ...g.entries.map(e => e.model)].find(x => typeof x === 'string' && x.includes('/'));
        g.id = withOrg ? withOrg.replace(/:[a-z0-9-]+$/i, '').replace(/-free$/i, '') : g.id;
        const catParams = _max(g.entries.map(e => e.params));
        const fromCat = parseParamsB('', g.id);
        if (om) {
            g.live = true;
            const sp: string[] = Array.isArray(om.supported_parameters) ? om.supported_parameters : [];
            const p = parseParamsB(om.description ?? '', om.id);
            // Largest context of any listing (e.g. a :free variant offering 1M vs 262K paid).
            g.contextK = liveCtx.has(canonicalModelId(om.id)) ? Math.round(liveCtx.get(canonicalModelId(om.id))! / 1000) : _max(g.entries.map(e => e.contextK));
            g.tools    = sp.includes('tools');
            g.thinking = sp.includes('reasoning') || sp.includes('include_reasoning');
            g.released = typeof om.created === 'number' ? new Date(om.created * 1000).toISOString().slice(0, 7) : _mode(g.entries.map(e => e.released));
            g.paramsB  = p.total ?? catParams ?? fromCat.total;
            g.activeB  = p.active ?? fromCat.active;
            const aa = om.benchmarks?.artificial_analysis;
            if (aa && typeof aa.intelligence_index === 'number')
                g.aa = { intelligence: aa.intelligence_index, coding: aa.coding_index ?? null, agentic: aa.agentic_index ?? null };
        } else {
            g.contextK = _max(g.entries.map(e => e.contextK));
            g.tools    = g.entries.some(e => e.tools);
            g.thinking = g.entries.some(e => e.thinking);
            g.released = _mode(g.entries.map(e => e.released));
            g.paramsB  = catParams ?? fromCat.total;
            g.activeB  = fromCat.active;
        }
    }
    return [...byId.values()];
}

// Release month "YYYY-MM" descending; groups without a date go last.
export function sortModelRankGroupsNewestFirst(groups: ModelRankGroup[]): ModelRankGroup[] {
    return [...groups].sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''));
}

export function formatModelRankLine(n: number, g: ModelRankGroup): string {
    const params = g.paramsB != null ? `${g.paramsB}B${g.activeB != null ? ` (${g.activeB}B active)` : ''}` : 'size unknown';
    const caps = [g.tools ? 'tools' : 'no tools', g.thinking && 'reasoning'].filter(Boolean).join(', ');
    const aa = g.aa ? `, AA intelligence ${g.aa.intelligence}${g.aa.coding != null ? ` / coding ${g.aa.coding}` : ''}${g.aa.agentic != null ? ` / agentic ${g.aa.agentic}` : ''}` : '';
    const ladder = g.ladder ? `, ${g.ladder}` : '';
    const used = g.successes > 0 ? `, ${g.successes} successful request${g.successes === 1 ? '' : 's'} here` : ', not used here yet';
    return `${n}. ${g.id} — ${params}, ${g.contextK != null ? `${g.contextK}K ctx` : 'ctx unknown'}, ${caps}${g.released ? `, released ${g.released}` : ''}${aa}${ladder}${used}`;
}

function resetModelPriorityDefaults() {
    if (!confirm('Replace the Model Priority list with the default list? Paused models are resumed.')) return;
    resetMainModelList();
    _prioritySelected.clear();
    renderMainModelList();
    updateActiveModelDisplay();
}

async function autoPopulateModelPriority() {
    const btn = document.getElementById('auto-rank-btn') as HTMLButtonElement;
    const _IDLE_LABEL = '<span style="color:#a855f7">✦</span> Populate';
    if (btn) { btn.disabled = true; btn.innerHTML = '⟳ Ranking…'; }
    const _fail = (detail?: string) => {
        console.error('[auto-rank]', detail ?? 'failed');
        alert('Model ranking failed. Try a different utility model.');
    };
    try {
        if (typeof buildChatPayload !== 'function' || typeof callLLM !== 'function') {
            return _fail('buildChatPayload or callLLM not available');
        }

        // All text-capable models, including ones cooling down after a rate limit: a cooldown is
        // temporary while the priority list is long-lived (rotation already skips cooling entries).
        // Filtering them out dropped providers from a model's group — Nemotron Ultra was ranked
        // with only 2 of its 4 providers while OpenRouter and NVIDIA were rate-limited.
        const all = typeof getAllModels === 'function' ? getAllModels() : [];
        const available = all.filter(m => !m.media || m.media.includes('text'));
        if (!available.length) { alert('No text models found in the catalog.'); return; }

        // Current model details from OpenRouter's public model list (no auth, CORS open): context
        // length, tool/reasoning support, release date, parameter counts from the description, and
        // Artificial Analysis indices. Matched to catalog models by canonical id, so it also fills in
        // models served by other providers. Proceeds on catalog data alone if the fetch fails.
        let orModels: any[] = [];
        try {
            const orResp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(10_000),
            });
            if (orResp.ok) {
                const orJson = await orResp.json().catch(() => null);
                orModels = Array.isArray(orJson?.data) ? orJson.data : [];
            }
        } catch { /* network error — catalog data only */ }

        // One entry per model, whichever providers serve it; the ranking sees model ids only.
        // Newest release first (undated last; the sort is stable), so the ranker's attention goes to
        // the latest models. The list numbers below follow this order.
        const groups = sortModelRankGroupsNewestFirst(buildModelRankGroups(available, orModels,
            typeof getModelSuccessCounts === 'function' ? getModelSuccessCounts() : {}));

        // Reference scale: top Artificial Analysis intelligence scores across all OpenRouter models
        // (paid ones included), by canonical id, so the ranker can place the free models on it.
        const refBest = new Map<string, number>();
        for (const om of orModels) {
            const ii = om?.benchmarks?.artificial_analysis?.intelligence_index;
            if (typeof ii !== 'number' || typeof om?.id !== 'string') continue;
            const cid = canonicalModelId(om.id);
            if (!refBest.has(cid) || refBest.get(cid)! < ii) refBest.set(cid, ii);
        }
        const orRefLeaderboard = [...refBest.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20)
            .map(([id, ii]) => `  ${id}: ${ii}`).join('\n');

        // Number the list so the LLM returns integers — avoids id-format corruption.
        const modelLines = groups.map((g, i) => formatModelRankLine(i + 1, g)).join('\n');

        const refSection = orRefLeaderboard
            ? `\nFor reference — Artificial Analysis Intelligence Index (higher = more capable; includes paid models as a calibration scale):\n${orRefLeaderboard}\n`
            : '';

        const userMsg =
`Rank these AI models by overall capability for general-purpose agent work (coding, reasoning, instruction following, tool use). Weigh the Artificial Analysis indices most where shown (intelligence, then coding and agentic); otherwise use total/active parameter counts, recency, context length, and tool/reasoning support. Also weigh proven reliability: "successful requests here" counts completed agent requests this app has made to that model — a model with many is known to work here; one with none is untried. "long chats: …" is a measurement from FreeGent's own long-context test (run ${MODEL_LADDER_DATE}): up to three conversations per model, started from 10K, 20K and 50K tokens of context, in which agentic coding, real-world knowledge and reasoning tasks alternate while the context grows to 250K tokens or the model's free-tier limit; "solved" counts graded tasks, "held" is the largest context it kept working at in each conversation, and tok/s is its output speed. A model that solved few tasks, or whose free tier stopped a conversation early, is less reliable than its size suggests, and one that solved most is proven to work; models without this line are untested. A model without tool support is unsuitable for agent work — rank it last. The models are listed newest release first, so the latest ones come first; concentrate on those, and favour a recent model over an older one of similar capability.
${refSection}
${modelLines}

Call rank_models with a ranked list of the model NUMBERS above (1-indexed integers), up to 10, most capable first.`;

        // Tool schema: integers only — model cannot corrupt the spec format
        const rankTool = {
            type: 'function',
            function: {
                name: 'rank_models',
                description: 'Return the list numbers of the top models ranked from most to least capable.',
                parameters: {
                    type: 'object',
                    properties: {
                        rankings: {
                            type: 'array',
                            description: 'Model list numbers (1-indexed integers from the list above), up to 10, most capable first.',
                            items: { type: 'integer', minimum: 1, maximum: groups.length },
                        },
                    },
                    required: ['rankings'],
                },
            },
        };

        // Collect candidate endpoints in preference order, deduped by provider|model.
        // Auto-rank sends a tool_choice call, so only use models with tools:true in the catalog.
        // Unknown/custom models (not in catalog) are assumed capable.
        const _rankModelMap = new Map(
            (typeof getAllModels === 'function' ? getAllModels() as any[] : [])
                .map(m => [`${m.provider}|${m.model}`, m])
        );
        const _supportsTools = (ep: any) => {
            const entry = _rankModelMap.get(`${ep.provider}|${ep.model}`);
            return !entry || !!entry.tools;
        };
        const _seen = new Set<string>();
        const epCandidates: any[] = [];
        for (const getter of [
            typeof utilityEndpoint   === 'function' ? utilityEndpoint   : null,
            typeof firstFreeEndpoint === 'function' ? firstFreeEndpoint : null,
            typeof oaiEndpoint       === 'function' ? oaiEndpoint       : null,
        ]) {
            if (!getter) continue;
            const ep = getter();
            if (!ep) continue;
            if (!_supportsTools(ep)) continue; // skip models that don't support tool_choice
            const key = `${ep.provider}|${ep.model}`;
            if (!_seen.has(key)) { _seen.add(key); epCandidates.push(ep); }
        }
        if (!epCandidates.length) return _fail('no tool-capable endpoint available');

        let result: any;
        let lastErr: any;
        for (const ep of epCandidates) {
            const payload = buildChatPayload(ep, {
                messages: [{ role: 'user', content: userMsg }],
                tools: [rankTool],
                temperature: 0.1,
                maxTokens: 200,    // 10 integers needs almost nothing
                stream: true,
                thinkingBudget: 0,
                forceToolCall: true,
            });
            try {
                result = await callLLM(ep, payload, () => {});
                break; // success — stop trying
            } catch (err: any) {
                console.warn(`[auto-rank] [${ep.provider}|${ep.model}] failed, trying next: ${err?.message}`);
                lastErr = err;
            }
        }
        if (!result) return _fail(lastErr?.message ?? 'all endpoints failed');

        // ── Map indices → catalog specs ──────────────────────────────────────────
        const _stripComments = (s: string) =>
            s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

        let rawIndices: number[] = [];

        const argsStr = result?.tool_calls?.[0]?.function?.arguments;
        if (argsStr) {
            let parsed: any;
            try { parsed = JSON.parse(argsStr); } catch {
                try { parsed = JSON.parse(_stripComments(argsStr)); } catch {
                    console.warn('[auto-rank] JSON parse failed:', argsStr?.slice(0, 120));
                }
            }
            const rankings = parsed?.rankings;
            if (Array.isArray(rankings)) {
                rawIndices = rankings.filter((n: any) => Number.isInteger(n));
            }
        }

        // Prose fallback: scan for digit sequences that could be list indices.
        // Normalise content — may be a plain string or an array of content blocks.
        if (!rawIndices.length) {
            const rawContent = result?.content;
            const contentStr = typeof rawContent === 'string'
                ? rawContent
                : Array.isArray(rawContent)
                    ? rawContent.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
                    : '';
            if (contentStr) {
                console.warn('[auto-rank] no tool_calls — parsing prose for numbers:', contentStr.slice(0, 200));
                const seen = new Set<number>();
                for (const m of contentStr.matchAll(/\b(\d{1,3})\b/g)) {
                    const n = parseInt(m[1], 10);
                    if (n >= 1 && n <= groups.length && !seen.has(n)) { seen.add(n); rawIndices.push(n); }
                }
            } else {
                console.warn('[auto-rank] no parseable content — result:', JSON.stringify(result)?.slice(0, 300));
            }
        }

        // Each ranked model expands to all of its providers, kept together so rotation falls
        // back to the same model elsewhere before moving to the next one. Within a model: its
        // current priority order first, then providers with a key/no-key access, then the rest.
        const current = typeof getMainModelList === 'function' ? getMainModelList() : [];
        const _order = (spec: string) => {
            const i = current.indexOf(spec);
            if (i >= 0) return i;
            return 1000 + (typeof specHasKey === 'function' && specHasKey(spec) ? 0 : 1000);
        };
        const picked: string[] = [];
        const pickedGroups = new Set<number>();
        for (const idx of rawIndices) {
            if (idx < 1 || idx > groups.length || pickedGroups.has(idx)) continue;
            pickedGroups.add(idx);
            const specs = groups[idx - 1].entries.map((m: any) => `${m.provider}|${m.model}`);
            specs.sort((x: string, y: string) => _order(x) - _order(y));
            for (const spec of specs) if (!picked.includes(spec)) picked.push(spec);
            if (pickedGroups.size >= 10) break;
        }
        if (!picked.length) return _fail(`no valid indices in response — got: ${JSON.stringify(rawIndices).slice(0, 120)}`);

        // Per-model log: which providers were added, and any provider of the same model left out
        // (hidden in Settings → Models, i.e. removed or edited) or added without a key.
        const _hidden = typeof getHiddenModels === 'function' ? [...getHiddenModels()] : [];
        let _rank = 0;
        for (const idx of pickedGroups) {
            const g = groups[idx - 1];
            const specs = g.entries.map((m: any) => `${m.provider}|${m.model}`);
            const hidden = _hidden.filter(k => canonicalModelId(k.slice(k.indexOf('|') + 1)) === canonicalModelId(g.entries[0].model));
            const noKey = specs.filter((k: string) => typeof specHasKey === 'function' && !specHasKey(k));
            console.info(`[auto-rank] #${++_rank} ${g.id} → ${specs.join(', ')}`
                + (hidden.length ? ` | hidden in Settings → Models (removed/edited), not added: ${hidden.join(', ')}` : '')
                + (noKey.length ? ` | no key, shown inactive: ${noKey.join(', ')}` : ''));
        }

        saveMainModelList(picked);
        renderMainModelList();
        updateActiveModelDisplay();
    } catch (err: any) {
        _fail(err?.message ?? String(err));
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = _IDLE_LABEL; }
    }
}

function renderMediaModelSelectors() {
    const container = (document.getElementById('media-model-selectors') as HTMLInputElement);
    if (!container) return;
    const rows = [
        { type: 'image', label: '🖼 Image', get: getImageModel },
        { type: 'audio', label: '🎵 Audio', get: getAudioModel },
        { type: 'video', label: '🎬 Video', get: getVideoModel },
    ];
    container.innerHTML = rows.map(({ type, label, get }) => {
        const models = getAllModelsForMedia(type);
        const current = get();
        const opts = [`<option value="">Auto</option>`]
            .concat(models.map(m => {
                const spec = `${m.provider}|${m.model}`;
                const sel  = current === spec ? ' selected' : '';
                return `<option value="${escapeHtml(spec)}"${sel}>${escapeHtml(`${m.provider}/${m.model}`)}</option>`;
            })).join('');
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="width:56px;font-size:12px;color:var(--muted);flex-shrink:0">${label}</span>
            <select class="settings-input" style="flex:1" onchange="saveMediaModel('${type}',this.value)">${opts}</select>
        </div>`;
    }).join('');
}

function renderWorkerModelSelector() {
    const container = (document.getElementById('worker-model-selector') as HTMLElement);
    if (!container) return;
    const all  = typeof getAllModels === 'function' ? getAllModels() : [];
    const models = all.filter(m => !m.media || m.media.includes('text'));
    const current = typeof getWorkerModel === 'function' ? getWorkerModel() : '';
    const fixedOpts = [
        { value: '', label: 'Default (next in model priority)', fixed: true },
        { value: 'priority', label: 'Priority model', fixed: true },
    ];
    const modelOpts = models.slice().sort((a, b) =>
        `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`)
    ).map(m => ({ value: `${m.provider}|${m.model}`, label: modelFriendlyName(`${m.provider}|${m.model}`) }));
    const allOpts = (fixedOpts as ComboOption[]).concat(modelOpts);
    const currentLabel = allOpts.find(o => o.value === current)?.label ?? current;
    container.innerHTML = `<div class="model-combo" id="worker-model-combo"
     style="flex:1"
     data-options="${escapeHtml(JSON.stringify(allOpts))}"
     data-onselect="saveWorkerModel">
  <input type="text" class="settings-input model-combo-input" autocomplete="off"
    value="${currentLabel.replace(/"/g, '&quot;')}"
    oninput="_comboFilter('worker-model-combo')"
    onfocus="_comboOpen('worker-model-combo')"
    onblur="_comboBlur('worker-model-combo')"
    onkeydown="_comboKey(event,'worker-model-combo')">
  <input type="hidden" class="model-combo-value" value="${current.replace(/"/g, '&quot;')}">
  <div class="model-combo-dropdown" hidden></div>
</div>`;
}

function renderUtilityModelSelector() {
    const container = (document.getElementById('utility-model-selector') as HTMLElement);
    if (!container) return;
    // List text-capable models only (all models support text — filter those whose media
    // array is absent or includes 'text').
    const all  = typeof getAllModels === 'function' ? getAllModels() : [];
    const models = all.filter(m => !m.media || m.media.includes('text'));
    const current = typeof getUtilityModel === 'function' ? getUtilityModel() : '';
    // Fixed options always visible regardless of filter query.
    const fixedOpts = [
        { value: '', label: 'Default (use priority list)', fixed: true },
        { value: 'none', label: 'None (no utility LLM calls)', fixed: true },
    ];
    const modelOpts = models.slice().sort((a, b) =>
        `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`)
    ).map(m => ({ value: `${m.provider}|${m.model}`, label: modelFriendlyName(`${m.provider}|${m.model}`) }));
    const allOpts = (fixedOpts as ComboOption[]).concat(modelOpts);
    const currentLabel = allOpts.find(o => o.value === current)?.label ?? current;
    container.innerHTML = `<div class="model-combo" id="utility-model-combo"
     style="flex:1"
     data-options="${escapeHtml(JSON.stringify(allOpts))}"
     data-onselect="saveUtilityModel">
  <input type="text" class="settings-input model-combo-input" autocomplete="off"
    value="${currentLabel.replace(/"/g, '&quot;')}"
    oninput="_comboFilter('utility-model-combo')"
    onfocus="_comboOpen('utility-model-combo')"
    onblur="_comboBlur('utility-model-combo')"
    onkeydown="_comboKey(event,'utility-model-combo')">
  <input type="hidden" class="model-combo-value" value="${current.replace(/"/g, '&quot;')}">
  <div class="model-combo-dropdown" hidden></div>
</div>`;
}

/** ↑ (dir -1) moves the row to the top of the ranking, ↓ (dir 1) to the bottom. With several rows selected, all of them move, keeping their order. */
function _movePriorityItem(containerId, idx, dir) {
    const list = getMainModelList();
    if (idx < 0 || idx >= list.length) return;
    const moving = _prioritySelected.size > 1 && _prioritySelected.has(list[idx])
        ? list.filter(k => _prioritySelected.has(k))
        : [list[idx]];
    const rest = list.filter(k => !moving.includes(k));
    saveMainModelList(dir < 0 ? [...moving, ...rest] : [...rest, ...moving]);
    renderMainModelList();
    updateActiveModelDisplay();
}

function _removePriorityItem(containerId, idx) {
    const list = getMainModelList();
    const key = list[idx];
    list.splice(idx, 1);
    saveMainModelList(list);
    savePausedMainModels(getPausedMainModels().filter(k => k !== key));
    renderMainModelList();
    updateActiveModelDisplay();
}

function _addPriorityItem(containerId) {
    const sel = (document.getElementById(`${containerId}-add-sel`) as HTMLInputElement);
    const key = sel?.value;
    if (!key) return;
    const list = getMainModelList();
    if (!list.includes(key)) list.push(key);
    saveMainModelList(list);
    // Unpause: adding a model explicitly should make it active immediately.
    if (typeof savePausedMainModels === 'function' && typeof getPausedMainModels === 'function') {
        const paused = getPausedMainModels().filter((k: string) => k !== key);
        savePausedMainModels(paused);
    }
    renderMainModelList();
    updateActiveModelDisplay();
}


function saveAgentSetting(key, value) {
    if (typeof value === 'boolean') value = value ? 'true' : 'false';
    setPref(key, String(value));
    if (key === 'fg_agent_compact_tokens') { try { syncHdrCompactSelect(); } catch {} }
}

function populateAgentSettings() {
    const cb  = (id, val) => { const el = (document.getElementById(id) as HTMLInputElement); if (el) el.checked = val; };
    const num = (id, val) => { const el = (document.getElementById(id) as HTMLInputElement); if (el) el.value = val; };
    const sel = (id, val) => { const el = (document.getElementById(id) as HTMLInputElement); if (el) el.value = String(val); };

    cb('agent-tool-truncation',   getAgentToolTruncation());
    num('agent-tool-result-size', getAgentMaxToolResult());
    num('director-max-tool-result', getDirectorMaxToolResult());
    cb('agent-proactive-compact', getAgentProactiveCompact());
    sel('agent-compact-at',       getAgentCompactAt());
    num('agent-compact-tokens',   getAgentCompactTokens());
    syncHdrCompactSelect();   // the header's select follows the setting

    cb('agent-concise-prompts',   getAgentConcisePrompts());
    num('agent-max-rounds',       getAgentMaxSteps());
    num('rate-limit-cooldown-min', parseInt(ls('fg_rate_limit_cooldown_min', '2'), 10));
    cb('agent-lean-workers',      getAgentLeanWorkers());
    cb('turn-sound',              turnSoundEnabled());
    cb('agent-worker-history',    getAgentWorkerHistory());
    cb('agent-worker-reduce',     getAgentWorkerReduce());
    cb('agent-role-model-routing',       getAgentRoleModelRouting());
    cb('endpoint-rotation',              getEndpointRotation());
    cb('single-request-per-endpoint',    getSingleRequestPerEndpoint());
    num('rotation-step-n',               getRotationStepN());
    cb('agent-ledger',                   getAgentLedger());
    cb('agent-review-logs',              getAgentReviewLogs());
    sel('agent-max-delegation-depth', ls('fg_agent_max_delegation_depth', '1'));
    sel('worker-thinking-budget',     ls('fg_worker_thinking_budget', '24576'));
    cb('preserve-thinking',           ls('fg_preserve_thinking', 'true') !== 'false');
    // entity memory removed
    cb('runner-qa',                getRunnerQa());
    num('runner-max-failures',     getRunnerMaxConsecutiveFails());
    cb('qa-enabled',           getQaEnabled());
    cb('qa-acceptance-review', getQaAcceptanceReview());
    cb('qa-test-runner',       getQaTestRunner());
    cb('qa-regression-guard',  getQaRegressionGuard());
    num('qa-rework-limit',     getQaReworkLimit());
    cb('edit-review-enabled',  getEditReviewEnabled());
    cb('show-nudges',     getShowNudges());
    sel('intent-validation',      getIntentValidation());
    sel('tool-approval',          getToolApproval());
    cb('git-enabled',             getGitEnabled());
    cb('ast-enabled',             getAstEnabled());
    const tpl = (document.getElementById('agent-prompt-template') as HTMLInputElement);
    if (tpl) tpl.value = getAgentPromptTemplate();
}

function renderRolesTab() {
    const el = (document.getElementById('roles-tab-content') as HTMLInputElement);
    if (!el) return;
    el.innerHTML = '';

    if (typeof rolesRegistry === 'undefined') {
        el.innerHTML = '<p class="settings-hint">Roles not available.</p>';
        return;
    }

    for (const role of rolesRegistry.values()) {
        const card = document.createElement('div');
        card.className = 'settings-section';

        // ── Header: checkbox + name + tier badge ──
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isRoleEnabled(role.name);
        cb.addEventListener('change', () => {
            // Change one role of what is stored now: another tab may have disabled a different one since this form was drawn.
            try { disabledRoles.clear(); for (const n of JSON.parse(localStorage.getItem('fg_disabled_roles') || '[]')) disabledRoles.add(n); } catch {}
            if (cb.checked) disabledRoles.delete(role.name);
            else disabledRoles.add(role.name);
            setPref('fg_disabled_roles', JSON.stringify([...disabledRoles]));
        });

        const nameEl = document.createElement('span');
        nameEl.className = 'settings-label';
        nameEl.style.cssText = 'margin:0;font-size:14px;font-weight:600';
        nameEl.textContent = role.name;

        const tierBadge = document.createElement('span');
        tierBadge.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:var(--border);color:var(--muted)';
        tierBadge.textContent = role.tier || 'execution';

        header.append(cb, nameEl, tierBadge);
        card.appendChild(header);

        // ── Description ──
        if (role.description) {
            const desc = document.createElement('p');
            desc.className = 'settings-hint';
            desc.style.marginBottom = '10px';
            desc.textContent = role.description;
            card.appendChild(desc);
        }

        // ── Tools ──
        if (role.tools) {
            const toolsLabel = document.createElement('div');
            toolsLabel.className = 'settings-input-label';
            toolsLabel.textContent = 'Worker tool ceiling';
            card.appendChild(toolsLabel);

            const toolsWrap = document.createElement('div');
            toolsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px';
            // Director ceiling is ALL_TOOL_NAMES in the browser — show a concise note instead
            // of 20+ badges, which would be noise rather than signal.
            const ceilingSize = typeof role.tools.size === 'number' ? role.tools.size : 0;
            if (ceilingSize >= (typeof ALL_TOOL_NAMES !== 'undefined' ? ALL_TOOL_NAMES.length : 20)) {
                const note = document.createElement('span');
                note.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic';
                note.textContent = 'All user-enabled tools (no ceiling)';
                toolsWrap.appendChild(note);
            } else {
                for (const tool of role.tools) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'background:var(--border);color:var(--text);padding:2px 8px;border-radius:10px;font-size:11px;font-family:monospace';
                    badge.textContent = tool;
                    toolsWrap.appendChild(badge);
                }
            }
            card.appendChild(toolsWrap);
        }

        // ── Auto-injected skills ──
        const roleSkills = typeof skillsRegistry !== 'undefined'
            ? [...skillsRegistry.values()].filter(s => {
                if (!s.roles) return false;
                return s.roles.split(',').map(r => r.trim().toLowerCase()).includes(role.name.toLowerCase());
            })
            : [];

        if (roleSkills.length) {
            const skillsLabel = document.createElement('div');
            skillsLabel.className = 'settings-input-label';
            skillsLabel.textContent = 'Auto-injected skills';
            card.appendChild(skillsLabel);

            const skillsWrap = document.createElement('div');
            skillsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px';
            for (const skill of roleSkills) {
                const badge = document.createElement('span');
                badge.style.cssText = 'background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);padding:2px 8px;border-radius:10px;font-size:11px';
                badge.textContent = '/' + skill.name;
                skillsWrap.appendChild(badge);
            }
            card.appendChild(skillsWrap);
        }

        // ── System prompt ──
        // Dynamic roles (body_fn): show the JS source so the user can read and edit the code
        // that generates the prompt.  Saved JS source takes precedence over body_fn() at
        // runtime.  Static roles (body string): show the plain text as before.
        const isDynamic  = typeof role.body_fn === 'function';
        const isCustomFn = isDynamic && !!getRoleBodyFn(role.name);  // saved JS source
        const isCustom   = !isDynamic && !!getRoleBody(role.name);   // saved plain text

        // For dynamic roles, the default display is the full body_fn source (body_fn.toString()).
        // new Function(extractedBody)() at runtime; window globals (enabledTools etc.) are accessible.
        const defaultFnSrc: string | null = isDynamic ? role.body_fn.toString() : null;
        const defaultPlain: string = isDynamic ? '' : (role.body || '');

        const promptLabel = document.createElement('div');
        promptLabel.className = 'settings-input-label';
        function _promptLabelText() {
            if (isDynamic) return 'System prompt JS' + (isCustomFn ? ' (customised)' : '');
            return 'System prompt' + (isCustom ? ' (customised)' : '');
        }
        promptLabel.textContent = _promptLabelText();
        card.appendChild(promptLabel);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.style.cssText = 'margin:0 0 6px';
        if (isDynamic) {
            hint.textContent = isCustomFn
                ? 'Custom JS source — executed at runtime to produce this role\'s system prompt. Reset to revert to the built-in source.'
                : 'Built-in JS source — executed at runtime; segments adapt to your enabled tools. Edit and save to override.';
        } else {
            hint.hidden = true;
        }
        card.appendChild(hint);

        const textarea = document.createElement('textarea');
        textarea.className = 'settings-input';
        textarea.rows = isDynamic ? 20 : 10;
        textarea.style.cssText = 'resize:vertical;font-family:"SF Mono","Fira Code",monospace;font-size:12px;line-height:1.5;width:100%;box-sizing:border-box';
        if (isCustomFn || isCustom) textarea.style.borderColor = 'var(--accent)';
        textarea.value = isDynamic
            ? (getRoleBodyFn(role.name) || defaultFnSrc || '')
            : (getRoleBody(role.name) || defaultPlain);
        card.appendChild(textarea);

        // ── Save / Reset / Preview ──
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
            if (isDynamic) {
                setRoleBodyFn(role.name, textarea.value);
            } else {
                setRoleBody(role.name, textarea.value);
            }
            textarea.style.borderColor = 'var(--accent)';
            promptLabel.textContent = isDynamic ? 'System prompt JS (customised)' : 'System prompt (customised)';
            if (isDynamic) hint.textContent = 'Custom JS source — executed at runtime to produce this role\'s system prompt. Reset to revert to the built-in source.';
            saveBtn.textContent = 'Saved!';
            setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'ws-action-btn';
        resetBtn.textContent = 'Reset to default';
        resetBtn.addEventListener('click', () => {
            if (isDynamic) {
                setRoleBodyFn(role.name, null);
                textarea.value = defaultFnSrc || '';
                hint.textContent = 'Built-in JS source — executed at runtime; segments adapt to your enabled tools. Edit and save to override.';
                promptLabel.textContent = 'System prompt JS';
            } else {
                setRoleBody(role.name, null);
                textarea.value = defaultPlain;
                promptLabel.textContent = 'System prompt';
            }
            textarea.style.borderColor = '';
            resetBtn.textContent = 'Reset!';
            setTimeout(() => { resetBtn.textContent = 'Reset to default'; }, 1500);
        });

        btnRow.append(saveBtn, resetBtn);

        if (isDynamic) {
            // Preview button: runs the current textarea source and shows the rendered output.
            const previewBtn = document.createElement('button');
            previewBtn.className = 'ws-action-btn';
            previewBtn.textContent = 'Preview rendered';
            previewBtn.addEventListener('click', () => {
                try {
                    const _b = textarea.value.indexOf('{');
                    const _e = textarea.value.lastIndexOf('}');
                    const _fnBody = (_b !== -1 && _e > _b) ? textarea.value.slice(_b + 1, _e) : textarea.value;
                    // The shipped source is run as the function it came from: its text is body_fn.toString(), and in the minified
                    // bundle that text names bundle-scoped identifiers (`Pa`) that new Function cannot see (opencode bug #7).
                    // Only an edited source is evaluated from text, against the window globals.
                    // eslint-disable-next-line no-new-func
                    const rendered = (defaultFnSrc !== null && textarea.value.trim() === defaultFnSrc.trim()
                        ? role.body_fn() : new Function(_fnBody)()) as string;
                    const pre = document.createElement('pre');
                    pre.style.cssText = 'background:var(--bg2,#f5f5f5);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;line-height:1.5;overflow:auto;max-height:300px;white-space:pre-wrap;margin-top:8px';
                    pre.textContent = rendered || '(empty)';
                    // Replace any existing preview
                    const existing = card.querySelector('.fg-role-preview');
                    if (existing) existing.remove();
                    pre.className = 'fg-role-preview';
                    btnRow.insertAdjacentElement('afterend', pre);
                } catch (err) {
                    alert('Preview error: ' + (err instanceof Error ? err.message : String(err)));
                }
            });
            btnRow.appendChild(previewBtn);
        }

        card.appendChild(btnRow);

        el.appendChild(card);
    }
}

// ── Searchable combo-box for model selection ─────────────────────────────────

interface ComboOption { value: string; label: string; fixed?: boolean; }

function _comboGetOpts(combo: HTMLElement): ComboOption[] {
    try { return JSON.parse(combo.dataset.options || '[]'); } catch { return []; }
}

function _comboRenderDropdown(comboId: string, q: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    const opts = _comboGetOpts(combo);
    const ql = q.trim().toLowerCase();
    const re = ql ? new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
    const filtered = opts.filter(o => o.fixed || !ql || o.label.toLowerCase().includes(ql));
    const dd = combo.querySelector('.model-combo-dropdown') as HTMLElement;
    if (!dd) return;

    // Split fixed vs normal to draw a separator between them when both present.
    const fixed = filtered.filter(o => o.fixed);
    const normal = filtered.filter(o => !o.fixed);
    const sections: ComboOption[][] = [];
    if (fixed.length) sections.push(fixed);
    if (normal.length) sections.push(normal);

    const addMode = combo.dataset.addmode === 'true';
    if (!filtered.length) {
        dd.innerHTML = `<div class="model-combo-empty">No matches</div>`;
    } else {
        dd.innerHTML = sections.map((sec, si) =>
            (si > 0 ? '<div class="model-combo-sep"></div>' : '') +
            sec.map(o => {
                // Escaped after the matches are marked, so a label from a provider's model list is text.
                const hl = re
                    ? escapeHtml(o.label.replace(re, m => `\u0001${m}\u0002`)).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>')
                    : escapeHtml(o.label);
                if (addMode) {
                    // Inline-add mode: clicking anywhere on the row adds the model.
                    // onmousedown fires before onblur so the click is captured before
                    // the dropdown closes; preventDefault keeps focus on the input.
                    return `<div class="model-combo-option model-combo-option-add" data-value="${escapeHtml(o.value)}"` +
                        ` onmousedown="event.preventDefault();_comboAddItem('${comboId}',${jsArg(o.value)})">${hl}</div>`;
                }
                return `<div class="model-combo-option" data-value="${escapeHtml(o.value)}"
                    onmousedown="_comboSelect('${comboId}',${jsArg(o.value)})">${hl}</div>`;
            }).join('')
        ).join('');
    }
    dd.hidden = false;
}

// Add a model directly from the combo dropdown (add-mode) without closing it,
// so the user can keep adding more models from the same search.
function _comboAddItem(comboId: string, value: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    // Save the current search query — renderMainModelList() will replace the combo element.
    const input = combo.querySelector('.model-combo-input') as HTMLInputElement;
    const savedQuery = input?.value ?? '';
    // Add to the main model list (if not already present).
    const list = getMainModelList();
    if (!list.includes(value)) list.push(value);
    saveMainModelList(list);
    // Unpause: adding a model explicitly should make it active, not stay paused.
    if (typeof savePausedMainModels === 'function' && typeof getPausedMainModels === 'function') {
        const paused = getPausedMainModels().filter((k: string) => k !== value);
        savePausedMainModels(paused);
    }
    // Re-render the priority list (replaces the combo element with a fresh one).
    renderMainModelList();
    updateActiveModelDisplay();
    // Re-find the new combo, restore the search query, re-render the dropdown open.
    // Focus first so _comboOpen's clear runs, then overwrite with savedQuery.
    const newCombo = document.getElementById(comboId);
    if (!newCombo) return;
    const newInput = newCombo.querySelector('.model-combo-input') as HTMLInputElement;
    if (!newInput) return;
    newInput.focus();           // triggers _comboOpen → clears input, renders empty dropdown
    newInput.value = savedQuery;
    _comboRenderDropdown(comboId, savedQuery);  // re-render with restored query
}

function _comboFilter(comboId: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    const input = combo.querySelector('.model-combo-input') as HTMLInputElement;
    const hidden = combo.querySelector('.model-combo-value') as HTMLInputElement;
    if (hidden) hidden.value = '';  // clear selection while typing
    _comboRenderDropdown(comboId, input?.value ?? '');
}

function _comboOpen(comboId: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    const input  = combo.querySelector('.model-combo-input') as HTMLInputElement;
    const hidden = combo.querySelector('.model-combo-value') as HTMLInputElement;
    // Snapshot the committed value so blur can restore it if the user cancels.
    combo.dataset.savedValue = hidden?.value ?? '';
    // Clear the text field so the user can type a fresh query right away.
    if (input) input.value = '';
    _comboRenderDropdown(comboId, '');
}

function _comboBlur(comboId: string): void {
    // Delay so the mousedown on an option fires before the blur hides the dropdown.
    setTimeout(() => {
        const combo = document.getElementById(comboId);
        if (!combo) return;
        const input  = combo.querySelector('.model-combo-input') as HTMLInputElement;
        // If the input has already been re-focused (e.g. after an inline-add re-render),
        // the blur is stale — don't close the dropdown.
        if (input && document.activeElement === input) return;
        const dd = combo.querySelector('.model-combo-dropdown') as HTMLElement;
        if (dd) dd.hidden = true;
        // In add-mode there is no hidden value input — just clear the search text.
        if (combo.dataset.addmode === 'true') {
            if (input) input.value = '';
            return;
        }
        const hidden = combo.querySelector('.model-combo-value') as HTMLInputElement;
        if (!input) return;
        // If something was selected this session, display its label; otherwise restore
        // the value that was committed before the user opened the combo.
        const committed = hidden?.value ?? '';
        const restoreValue = committed || (combo.dataset.savedValue ?? '');
        if (hidden) hidden.value = restoreValue;
        const opts = _comboGetOpts(combo);
        input.value = opts.find(o => o.value === restoreValue)?.label ?? '';
    }, 150);
}

function _comboKey(event: KeyboardEvent, comboId: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    const dd = combo.querySelector('.model-combo-dropdown') as HTMLElement;
    if (!dd || dd.hidden) { if (event.key === 'ArrowDown') _comboOpen(comboId); return; }
    const items = Array.from(dd.querySelectorAll('.model-combo-option')) as HTMLElement[];
    let cur = items.findIndex(el => el.classList.contains('combo-kbd'));
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        cur = Math.min(cur + 1, items.length - 1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        cur = Math.max(cur - 1, 0);
    } else if (event.key === 'Enter' && cur >= 0 && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        const val = items[cur]?.dataset.value ?? '';
        if (combo.dataset.addmode === 'true') _comboAddItem(comboId, val);
        else _comboSelect(comboId, val);
        return;
    } else if (event.key === 'Escape') {
        dd.hidden = true;
        return;
    } else { return; }
    items.forEach((el, i) => el.classList.toggle('combo-kbd', i === cur));
    items[cur]?.scrollIntoView({ block: 'nearest' });
}

function _comboSelect(comboId: string, value: string): void {
    const combo = document.getElementById(comboId);
    if (!combo) return;
    const opts = _comboGetOpts(combo);
    const opt = opts.find(o => o.value === value);
    const label = opt?.label ?? value;
    const input = combo.querySelector('.model-combo-input') as HTMLInputElement;
    const hidden = combo.querySelector('.model-combo-value') as HTMLInputElement;
    const dd = combo.querySelector('.model-combo-dropdown') as HTMLElement;
    if (input) input.value = label;
    if (hidden) hidden.value = value;
    if (dd) dd.hidden = true;
    // Fire optional onselect callback registered on the combo element.
    const cbName = combo.dataset.onselect;
    if (cbName) {
        const cb = (window as any)[cbName];
        if (typeof cb === 'function') cb(value);
    }
}

// Window bridge for classic scripts and inline handlers (ESM migration).
// ── MCP servers tab ──────────────────────────────────────────────────────────
// Server entries and discovery live in mcp.ts; this renders them. Tool names and descriptions
// come from the external server, so they are set with textContent, never innerHTML.

function _mcpEl(tag: string, cls = '', text = ''): HTMLElement {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
}

// Standard-library entries: one card each, with a key field when the server needs one.
function _renderMcpLibrary(servers: any[]) {
    const el = document.getElementById('settings-mcp-library');
    if (!el) return;
    el.innerHTML = '';
    const library = getMcpLibrary();
    const section = document.getElementById('settings-mcp-library-section');
    if (section) section.style.display = library.length ? '' : 'none';
    for (const lib of library) {
        const box  = _mcpEl('div', 'mcps-server');
        const head = _mcpEl('div', 'mcps-head');
        const info = _mcpEl('div', 'model-item-info');
        info.appendChild(_mcpEl('div', 'model-item-name', lib.name));
        info.appendChild(_mcpEl('div', 'model-item-meta', lib.description));
        if (lib.notes) info.appendChild(_mcpEl('div', 'model-item-meta', lib.notes));
        head.appendChild(info);
        box.appendChild(head);

        const added = servers.some(s => s.libraryId === lib.id || s.url === lib.url);
        if (added) {
            head.appendChild(_mcpEl('span', 'model-item-meta', 'Added ✓'));
        } else {
            const form = _mcpEl('div', 'mcps-lib-form');
            let keyInput: HTMLInputElement | null = null;
            if (lib.auth) {
                keyInput = document.createElement('input');
                keyInput.type = 'password';
                keyInput.autocomplete = 'off';
                keyInput.className = 'settings-input';
                keyInput.placeholder = lib.auth.label;
                const link = _mcpEl('a', 'model-item-meta', 'Get a key') as HTMLAnchorElement;
                link.href = lib.auth.keyUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                form.append(keyInput, link);
            }
            const btn = _mcpEl('button', 'ws-action-btn', 'Add') as HTMLButtonElement;
            const status = _mcpEl('span', 'model-item-meta mcps-err');
            btn.addEventListener('click', async () => {
                btn.disabled = true; btn.textContent = 'Connecting…'; status.textContent = '';
                try {
                    await addMcpLibraryServer(lib.id, keyInput?.value || '');
                    renderMcpTab();
                } catch (e) {
                    status.textContent = `✗ ${e.message}`;
                    btn.disabled = false; btn.textContent = 'Add';
                }
            });
            form.append(btn, status);
            box.appendChild(form);
        }
        el.appendChild(box);
    }
}

function renderMcpTab() {
    const el = document.getElementById('settings-mcp-list');
    if (!el) return;
    el.innerHTML = '';
    const servers = getMcpServers();
    _renderMcpLibrary(servers);
    if (!servers.length) {
        el.appendChild(_mcpEl('p', 'settings-hint', 'No servers added yet.'));
        return;
    }
    for (const s of servers) {
        const box  = _mcpEl('div', 'mcps-server');
        const head = _mcpEl('div', 'mcps-head');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = s.enabled;
        cb.title = 'Offer this server\'s enabled tools to the agent';
        cb.addEventListener('change', () => { setMcpServerEnabled(s.id, cb.checked); });

        const info = _mcpEl('div', 'model-item-info');
        info.appendChild(_mcpEl('div', 'model-item-name', s.name));
        let host = s.url;
        try { host = new URL(s.url).host; } catch { /* keep raw */ }
        const tools = s.tools || [];
        const onCount = tools.filter(t => (s.enabledTools || []).includes(t.name)).length;
        const meta = _mcpEl('div', 'model-item-meta', `${host} · ${tools.length} tool${tools.length === 1 ? '' : 's'}, ${onCount} enabled`);
        if (s.error) meta.appendChild(_mcpEl('span', 'mcps-err', ` · ${s.error}`));
        info.appendChild(meta);

        const refresh = _mcpEl('button', 'ws-action-btn', 'Refresh') as HTMLButtonElement;
        refresh.title = 'Reconnect and reload the tool list';
        refresh.addEventListener('click', async () => {
            refresh.disabled = true; refresh.textContent = 'Connecting…';
            try { await refreshMcpServer(s.id); } catch { /* error saved on the entry */ }
            renderMcpTab();
        });
        const remove = _mcpEl('button', 'ws-action-btn', 'Remove') as HTMLButtonElement;
        remove.addEventListener('click', () => {
            if (!confirm(`Remove MCP server "${s.name}"?`)) return;
            removeMcpServer(s.id);
            renderMcpTab();
        });
        // Library servers have been checked; for any other server the read-only/destructive labels
        // are its own claim, used for approval only when the user says so.
        const trust = _mcpEl('label', 'mcps-trust');
        const tcbx = document.createElement('input');
        tcbx.type = 'checkbox';
        tcbx.checked = mcpAnnotationsTrusted(s);
        tcbx.addEventListener('change', () => { setMcpServerTrust(s.id, tcbx.checked); renderMcpTab(); });
        trust.title = 'Use this server\'s own "read-only" and "non-destructive" tool labels when deciding whether a call needs approval. Off: its tools are treated as able to change or delete data.';
        trust.append(tcbx, ' Trust labels');
        head.append(cb, info, trust, refresh, remove);
        box.appendChild(head);

        if (tools.length) {
            const det = _mcpEl('details', 'mcps-tools') as HTMLDetailsElement;
            det.appendChild(_mcpEl('summary', '', 'Tools'));
            for (const t of tools) {
                const row = _mcpEl('label', 'mcps-tool');
                const tcb = document.createElement('input');
                tcb.type = 'checkbox';
                tcb.checked = (s.enabledTools || []).includes(t.name);
                tcb.addEventListener('change', () => {
                    setMcpToolEnabled(s.id, t.name, tcb.checked);
                    const cur = getMcpServers().find(x => x.id === s.id);
                    const n = (cur?.enabledTools || []).length;
                    meta.firstChild!.textContent = `${host} · ${tools.length} tool${tools.length === 1 ? '' : 's'}, ${n} enabled`;
                });
                const ti = _mcpEl('div', 'model-item-info');
                const nm = _mcpEl('div', 'model-item-name', t.name);
                const risk  = mcpToolRisk(mcpExposedName(s.id, t.name));
                const claim = mcpToolClaim(mcpExposedName(s.id, t.name));
                // The server's label is shown either way; when it is not trusted it does not lower approval.
                const unused = claim !== risk;
                const claimLabel = claim === 'read' ? 'read-only' : claim === 'write' ? 'writes' : 'may modify';
                const riskLabel = unused ? `${claimLabel} (server's label, not used)` : risk === 'read' ? 'read-only' : risk === 'write' ? 'writes' : 'may modify';
                const badge = _mcpEl('span', `mcps-risk${risk === 'destructive' ? ' mcps-risk-destructive' : ''}`, riskLabel);
                badge.title = unused ? 'The server gives this label itself. It is not used until you tick "Trust labels" for this server, so the tool asks for approval when tool approval is on.'
                    : risk === 'read' ? 'Marked read-only'
                    : risk === 'write' ? 'The server marks this tool as changing data, non-destructively'
                    : 'Not marked read-only: may change or delete data. Asks for approval when tool approval is on.';
                nm.appendChild(badge);
                ti.appendChild(nm);
                if (t.description) ti.appendChild(_mcpEl('div', 'model-item-meta', t.description));
                row.append(tcb, ti);
                det.appendChild(row);
            }
            box.appendChild(det);
        }
        el.appendChild(box);
    }
}

function showAddMcpForm(show?: boolean) {
    const f = document.getElementById('add-mcp-form');
    if (!f) return;
    f.style.display = (show ?? f.style.display === 'none') ? '' : 'none';
    const st = document.getElementById('add-mcp-status');
    if (st) st.textContent = '';
    _onNewMcpAuthChange();
}

function _onNewMcpAuthChange() {
    const v = (document.getElementById('new-mcp-auth') as HTMLSelectElement)?.value || 'none';
    const hr = document.getElementById('new-mcp-header-row');
    const kr = document.getElementById('new-mcp-key-row');
    if (hr) hr.style.display = v === 'header' ? '' : 'none';
    if (kr) kr.style.display = v === 'none' ? 'none' : '';
}

async function submitAddMcpServer() {
    const val = (id: string) => ((document.getElementById(id) as HTMLInputElement)?.value || '').trim();
    const st  = document.getElementById('add-mcp-status');
    const btn = document.getElementById('add-mcp-btn') as HTMLButtonElement | null;
    const setStatus = (text: string, err = false) => { if (st) { st.textContent = text; st.classList.toggle('mcps-err', err); } };
    const url = val('new-mcp-url');
    if (!url) { setStatus('Enter the server URL.', true); return; }
    const auth = val('new-mcp-auth') || 'none';
    const key  = val('new-mcp-key');
    const headers: Record<string, string> = {};
    if (auth === 'bearer') {
        if (!key) { setStatus('Enter the token.', true); return; }
        headers['Authorization'] = `Bearer ${key}`;
    } else if (auth === 'header') {
        const h = val('new-mcp-header');
        if (!/^[A-Za-z0-9-]+$/.test(h)) { setStatus('Enter a valid header name.', true); return; }
        if (!key) { setStatus('Enter the key.', true); return; }
        headers[h] = key;
    }
    if (btn) btn.disabled = true;
    setStatus('Connecting…');
    try {
        const entry = await addMcpServer({ name: val('new-mcp-name'), url, headers });
        setStatus('');
        for (const id of ['new-mcp-name', 'new-mcp-url', 'new-mcp-key', 'new-mcp-header'])
            { const i = document.getElementById(id) as HTMLInputElement | null; if (i) i.value = ''; }
        showAddMcpForm(false);
        renderMcpTab();
        if (!entry.tools?.length) alert(`Connected to ${entry.name}, but it lists no tools.`);
    } catch (e) {
        setStatus(`✗ ${e.message}`, true);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Another tab changed a setting while this tab's Settings form is on screen: refresh the form (a field being typed in is left
// alone). Writes from this tab's own form are not echoed back into it.
{
    let _t: ReturnType<typeof setTimeout> | null = null;
    onPrefChange(k => !/^fg_(chat|draft|ckpt|active_chat|project)/.test(k), (_keys, origin) => {
        if (origin !== 'remote') return;
        if (_t) clearTimeout(_t);
        _t = setTimeout(() => {
            _t = null;
            try {
                const panel = document.querySelector('#tab-content [data-panel="settings"].active');
                if (!panel) return;   // a hidden form is filled in again when Settings is opened
                const a = document.activeElement as HTMLElement | null;
                if (a && panel.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(checkbox|radio|range|button)$/.test((a as HTMLInputElement).type)))) return;
                populateSettingsForm();
            } catch (err) { console.warn('[settings] refresh after another tab changed a setting failed:', (err as any)?.message); }
        }, 150);
    });
    // The model button names the first usable model: it follows the list, pauses and custom models, here and in other tabs.
    onPrefChange(/^fg_(main_models|paused_main|custom_models)$/, () => { try { updateInputModelBtn(); } catch {} });
}

Object.assign(window, { clearModelCooldowns, switchSettingsTab, _comboFilter, _comboOpen, _comboBlur, _comboKey, _comboSelect, _comboAddItem, _addVoiceItem, _removeVoiceItem, _moveVoiceItem, saveVoiceSettings, populateVoiceTab, showSettings, onPyodideAutoloadChange, onPrivacyChange, onPrivacyLevelChange, _applyPrivacyLevelUI, onSandboxProviderChange, saveSettings, populateSettingsForm, updateActiveModelDisplay, initHdrPicker, showModelCooldownPopup, hideModelCooldownPopup, applyHdrCompactTokens, applyHdrReasoning, saveSamplingSetting, populateSamplingSettings, renderModelCatalogTable, _sortModelCatalog, showAddCustomModelForm, detectNewModel, _onNewModelIdChange, redetectEditModel, addCustomModel, deleteModel, deleteCustomModel, openEditModelDialog, saveEditModel, _onNewModelProviderChange, renderMainModelList, saveMediaModel, renderMediaModelSelectors, renderWorkerModelSelector, renderUtilityModelSelector, autoPopulateModelPriority, resetModelPriorityDefaults,_priorityRowClick, _movePriorityItem, _removePriorityItem, _addPriorityItem, saveAgentSetting, renderRolesTab, _handleDragStart, _handleDragEnd, _handleDragOver, _handleDragLeave, _handleDrop, _togglePauseItem, _priorityTouchStart, _priorityTouchMove, _priorityTouchEnd, updateInputModelBtn, toggleInputModelPicker, _selectInputModel, _modelPageUrl, renderMcpTab, showAddMcpForm, _onNewMcpAuthChange, submitAddMcpServer });
