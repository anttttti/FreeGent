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
    { key: 'mistral|voxtral-mini-transcribe-v2',      label: 'Voxtral Mini Transcribe v2', provider: 'mistral',    note: 'Free tier · batch' },
    { key: 'openrouter|nvidia/parakeet-tdt-0.6b-v3',  label: 'Parakeet TDT 0.6B v3',       provider: 'openrouter', note: 'NVIDIA · multilingual · free tier' },
    { key: 'openrouter|qwen/qwen3-asr-flash',         label: 'Qwen3 ASR Flash',            provider: 'openrouter', note: 'Alibaba · 11 languages · free tier' },
];

const _VOICE_TTS_CATALOG = [
    { key: 'browser|webspeech',                                  label: 'Web Speech Synthesis',     provider: 'browser',    note: 'Free · browser built-in' },
    { key: 'mistral|voxtral-mini-tts-2603',                      label: 'Voxtral Mini TTS',         provider: 'mistral',    note: 'Free tier · 9 languages · 70ms' },
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
  <span class="model-priority-label">${entry.label}</span>
  <span class="model-priority-provider">${_providerLabel(entry.provider)}</span>
  <span class="model-priority-cool" style="font-size:10px;color:var(--muted)">${entry.note}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" onclick="_moveVoiceItem('${storageKey}',${i},-1,'${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" onclick="_moveVoiceItem('${storageKey}',${i},1,'${containerId}','${catalog === _VOICE_STT_CATALOG ? 'stt' : 'tts'}')">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
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
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= list.length) return;
    [list[idx], list[newIdx]] = [list[newIdx], list[idx]];
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

function showSettings() {
    activateTab('settings');
}

function _applySandboxProviderUI(val) {
    const wasmHint  = (document.getElementById('sandbox-wasm-hint') as HTMLElement);
    const localHint = (document.getElementById('sandbox-local-hint') as HTMLElement);
    if (wasmHint)  wasmHint.style.display  = val === 'wasm'  ? '' : 'none';
    if (localHint) localHint.style.display = val === 'local' ? '' : 'none';
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
    localStorage.setItem('fg_sandbox_provider', val);
    saveSettings();
}

function saveSettings() {
    const get = id => ((document.getElementById(id) as HTMLInputElement)?.value || '').trim();
    // Guard: only write API key fields when the input has a value OR was explicitly
    // populated by populateSettingsForm (data-fg-loaded="1") and then cleared.
    // An empty field without data-fg-loaded means the form opened before the keys
    // endpoint returned — preserve whatever is stored rather than overwriting with ''.
    const saveKey = (lsKey: string, inputId: string) => {
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        const val = el ? el.value.trim() : '';
        if (val) {
            localStorage.setItem(lsKey, val);
        } else if (el?.dataset.fgLoaded) {
            // Field was shown with a value and user deliberately cleared it — honour that.
            localStorage.setItem(lsKey, '');
        }
        // else: field never populated (race with keys endpoint) — leave stored value intact.
    };

    saveKey('fg_gemini_key',        'gemini-key');
    saveKey('fg_mistral_key',       'mistral-key');
    saveKey('fg_groq_key',          'groq-key');
    saveKey('fg_cerebras_key',      'cerebras-key');
    saveKey('fg_nvidia_key',        'nvidia-key');
    saveKey('fg_openrouter_key',    'openrouter-key');
    saveKey('fg_opencode_key',      'opencode-key');
    saveKey('fg_tokenharbor_key',   'tokenharbor-key');
    saveKey('fg_kilo_key',          'kilo-key');
    saveKey('fg_vercel_key',        'vercel-key');
    saveKey('fg_nous_key',          'nous-key');
    localStorage.setItem('fg_sandbox_provider', (document.getElementById('sandbox-provider') as HTMLInputElement)?.value || 'wasm');
    localStorage.setItem('fg_search_provider', (document.getElementById('search-provider') as HTMLInputElement)?.value || 'auto');
    saveKey('fg_tavily_key',        'tavily-key');
    saveKey('fg_hf_key',            'hf-key');
    saveKey('fg_search_proxy',      'search-proxy');
    saveKey('fg_brave_key',         'brave-key');
    saveKey('fg_github_token',      'github-token');
    saveKey('fg_stackexchange_key', 'stackexchange-key');

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
        el.value = val;
        if (val) el.dataset.fgLoaded = '1';
    };
    set('gemini-key',     getGeminiKey());
    set('mistral-key',    getMistralKey());
    set('groq-key',       getGroqKey());
    set('cerebras-key',   getCerebrasKey());
    set('nvidia-key',     getNvidiaKey());
    set('openrouter-key', getOpenRouterKey());
    set('opencode-key',      getOpenCodeKey());
    set('tokenharbor-key',   getTokenHarborKey());
    set('kilo-key',          getKiloKey());
    set('vercel-key',        getVercelKey());
    set('nous-key',          getNousKey());
    const pyAuto = (document.getElementById('pyodide-autoload') as HTMLInputElement);
    if (pyAuto) pyAuto.checked = localStorage.getItem('fg_pyodide_autoload') !== '0';
    const sbp = (document.getElementById('sandbox-provider') as HTMLInputElement);
    if (sbp) {
        let sbpVal = getSandboxProvider();
        if (!['none', 'local', 'wasm'].includes(sbpVal)) { sbpVal = 'wasm'; localStorage.setItem('fg_sandbox_provider', 'wasm'); }
        sbp.value = sbpVal;
    }
    _applySandboxProviderUI(sbp?.value || getSandboxProvider());
    const sp = (document.getElementById('search-provider') as HTMLInputElement);
    if (sp) sp.value = getSearchProvider();
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

function initHdrPicker() {
    updateActiveModelDisplay();
    // Sync compact-tokens header select from saved value (snap to nearest option)
    const saved = String(getAgentCompactTokens());
    const sel = (document.getElementById('hdr-compact-tokens') as HTMLSelectElement);
    if (sel) {
        const opts = [...sel.options].map(o => o.value);
        sel.value = opts.includes(saved) ? saved : '40000';
    }
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
        const badge = rem > 0 ? `<span class="mcp-cooling">${rem}s</span>` : `<span class="mcp-ok">✓</span>`;
        rows.push(`<div class="mcp-row"><span class="mcp-name${isActive ? ' mcp-active' : ''}">${label}</span>${badge}</div>`);
    });
    popup.innerHTML = rows.join('');
}

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

function applyHdrSearch() {
    const val = (document.getElementById('hdr-search') as HTMLInputElement)?.value || 'auto';
    localStorage.setItem('fg_search_provider', val);
}

function applyHdrRetryMode() {
    const val = (document.getElementById('hdr-retry-mode') as HTMLInputElement)?.value || 'exponential';
    if (val === 'exponential') {
        localStorage.setItem('fg_retry_mode', 'exponential');
        localStorage.removeItem('fg_retry_fixed_ms');
    } else {
        const msMap = { 'fixed-30s': 30_000, 'fixed-2m': 120_000, 'fixed-5m': 300_000 };
        localStorage.setItem('fg_retry_mode', 'fixed');
        localStorage.setItem('fg_retry_fixed_ms', String(msMap[val] ?? 120_000));
    }
}

function updateRetryModeSelect() {
    const sel = (document.getElementById('hdr-retry-mode') as HTMLInputElement);
    if (!sel) return;
    const mode    = localStorage.getItem('fg_retry_mode') || 'exponential';
    const fixedMs = parseInt(localStorage.getItem('fg_retry_fixed_ms') || '0');
    if (mode !== 'fixed') { sel.value = 'exponential'; return; }
    if (fixedMs <= 30_000)       sel.value = 'fixed-30s';
    else if (fixedMs <= 120_000) sel.value = 'fixed-2m';
    else                         sel.value = 'fixed-5m';
}

function applyHdrCompactTokens() {
    const val = (document.getElementById('hdr-compact-tokens') as HTMLSelectElement)?.value ?? '20000';
    localStorage.setItem('fg_agent_compact_tokens', val);
    // Keep settings panel in sync
    const el = (document.getElementById('agent-compact-tokens') as HTMLInputElement);
    if (el) el.value = val;
}

function applyHdrReasoning() {
    const sel = (document.getElementById('hdr-reasoning') as HTMLInputElement);
    if (sel) localStorage.setItem('fg_thinking_level', sel.value);
}

function applyHdrTemperature() {
    const sel = (document.getElementById('hdr-temperature') as HTMLInputElement);
    if (!sel) return;
    if (sel.value === '') localStorage.removeItem('fg_temperature');
    else localStorage.setItem('fg_temperature', sel.value);
}

function updateTemperatureSelect() {
    const sel = (document.getElementById('hdr-temperature') as HTMLInputElement);
    if (!sel) return;
    const current = localStorage.getItem('fg_temperature') ?? '';
    const opts = [
        { label: 'Temp: Default', value: '' },
        { label: 'Temp: 0',       value: '0' },
        { label: 'Temp: 0.2',     value: '0.2' },
        { label: 'Temp: 0.6',     value: '0.6' },
        { label: 'Temp: 1',       value: '1' },
        { label: 'Temp: 1.5',     value: '1.5' },
    ];
    sel.innerHTML = opts.map(o =>
        `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
    ).join('');
}

function applyHdrTopP() {
    const sel = (document.getElementById('hdr-top-p') as HTMLInputElement);
    if (!sel) return;
    if (sel.value === '') localStorage.removeItem('fg_top_p');
    else localStorage.setItem('fg_top_p', sel.value);
}
function updateTopPSelect() {
    const sel = (document.getElementById('hdr-top-p') as HTMLInputElement);
    if (!sel) return;
    const current = localStorage.getItem('fg_top_p') ?? '';
    const opts = [
        { label: 'Top P: Default', value: '' },
        { label: 'Top P: 0.8',     value: '0.8' },
        { label: 'Top P: 0.9',     value: '0.9' },
        { label: 'Top P: 0.95',    value: '0.95' },
        { label: 'Top P: 1',       value: '1' },
    ];
    sel.innerHTML = opts.map(o =>
        `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
    ).join('');
}
function applyHdrTopK() {
    const sel = (document.getElementById('hdr-top-k') as HTMLInputElement);
    if (!sel) return;
    if (sel.value === '') localStorage.removeItem('fg_top_k');
    else localStorage.setItem('fg_top_k', sel.value);
}
function updateTopKSelect() {
    const sel = (document.getElementById('hdr-top-k') as HTMLInputElement);
    if (!sel) return;
    const current = localStorage.getItem('fg_top_k') ?? '';
    const opts = [
        { label: 'Top K: Default', value: '' },
        { label: 'Top K: 20',      value: '20' },
        { label: 'Top K: 40',      value: '40' },
        { label: 'Top K: 50',      value: '50' },
        { label: 'Top K: 100',     value: '100' },
    ];
    sel.innerHTML = opts.map(o =>
        `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
    ).join('');
}
function saveSamplingSetting(key, value) {
    const v = value.trim();
    if (v === '') localStorage.removeItem(key);
    else localStorage.setItem(key, v);
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

function _supportsThinking() {
    const provider = getProvider();
    const model    = getActiveModel();
    // custom endpoints always show the thinking UI (we can't know their capabilities)
    return provider === 'custom' || modelSupportsThinking(provider, model);
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
    return { google:'Google', mistral:'Mistral', groq:'Groq', cerebras:'Cerebras', nvidia:'NVIDIA', openrouter:'OpenRouter', opencode:'OpenCode', nous:'Nous Portal', tokenharbor:'TokenHarbor', kilo:'Kilo', vercel:'Vercel AI Gateway', custom:'Custom' }[p] || p;
}

let _modelSort: { col: string | null; dir: string } = { col: null, dir: 'asc' };

// Returns the canonical web page URL for a provider/model combination.
// Used in the catalog table and the model-update modal.
function _modelPageUrl(provider: string, model: string): string {
    switch (provider) {
        case 'openrouter':
            // Strip :free suffix — the page exists at the bare model path
            return `https://openrouter.ai/${model.replace(/:free$/, '')}`;
        case 'nvidia':
            return `https://build.nvidia.com/${model}`;
        case 'google':
            // Gemma models have a separate docs page from Gemini
            if (model.startsWith('gemma')) return 'https://ai.google.dev/gemma/docs/gemma-models';
            // Gemini: anchor by model name (e.g. #gemini-2.5-flash-lite)
            return `https://ai.google.dev/gemini-api/docs/models#${model}`;
        case 'mistral': {
            // Map versioned model IDs to Mistral product pages
            const slug = model.startsWith('ministral')      ? 'ministral'
                       : model.startsWith('codestral')      ? 'codestral'
                       : model.startsWith('pixtral')        ? 'pixtral'
                       : model.startsWith('devstral')       ? 'devstral'
                       : model.startsWith('mistral-large')  ? 'mistral-large'
                       : model.startsWith('mistral-medium') ? 'mistral-medium'
                       : model.startsWith('mistral-small')  ? 'mistral-small'
                       : null;
            return slug ? `https://mistral.ai/models/${slug}/`
                        : 'https://docs.mistral.ai/getting-started/models/all-models/';
        }
        case 'groq':
            return 'https://console.groq.com/docs/models';
        case 'cerebras':
            return 'https://inference-docs.cerebras.ai/model-catalog';
        case 'nous':
            // Models are vendor/name:free (e.g. stepfun/step-3.7-flash:free).
            // OpenRouter hosts the canonical model pages; Nous Portal index for the provider link.
            return model.includes('/')
                ? `https://openrouter.ai/${model.replace(/:free$/, '')}`
                : 'https://portal.nousresearch.com/models';
        case 'opencode':
            return 'https://opencode.ai/docs/zen/#endpoints';
        case 'tokenharbor':
            return 'https://tokenharbor.ai/models';
        case 'kilo':
            return 'https://kilo.ai/models';
        case 'vercel':
            return 'https://vercel.com/ai-gateway/models';
        default:
            return '';
    }
}

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
  ${_th('note',     'Note',      'Capability summary and notable features')}
  <th></th>
</tr></thead><tbody>`;

    for (const m of rows) {
        const key      = `${m.provider}|${m.model}`;
        const editBtn = `<button class="model-table-btn model-table-btn-edit" title="Edit model" onclick="openEditModelDialog('${key}')">⚙</button>`;
        const delBtn  = `<button class="model-table-btn" onclick="deleteModel('${key}')">✕</button>`;
        const _pageUrl = _modelPageUrl(m.provider, m.model);
        const _idText  = m.model.length > 30 ? m.model.slice(0, 28) + '…' : m.model;
        const _lnk = (text: string, url: string, ttl = url) =>
            url ? `<a href="${url}" target="_blank" rel="noopener" title="${ttl}" class="model-table-link">${text}</a>` : text;
        html += `<tr data-key="${key}">
  <td>${_lnk(_providerLabel(m.provider), _pageUrl)}</td>
  <td class="model-table-id">${_lnk(_idText, _pageUrl, m.model)}</td>
  <td>${m.label}</td>
  <td class="model-table-params">${_fmtParams(m.params ?? null)}</td>
  <td>${m.contextK}K</td>
  <td>${m.released || ''}</td>
  <td>${m.tools ? '✓' : ''}</td>
  <td>${m.thinking ? '✓' : ''}</td>
  <td class="model-table-note">${m.note || ''}</td>
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
          <option value="opencode">OpenCode</option>
          <option value="nous">Nous Portal</option>
          <option value="mistral">Mistral</option>
          <option value="google">Google</option>
          <option value="nvidia">NVIDIA</option>
          <option value="custom">Custom</option>
        </select></td></tr>
    <tr><td class="settings-table-label">Model ID</td>
        <td><input class="settings-input" id="new-model-id" type="text" placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free" style="width:100%"></td></tr>
    <tr><td class="settings-table-label">Label</td>
        <td><input class="settings-input" id="new-model-label" type="text" placeholder="Display name" style="width:100%"></td></tr>
    <tr><td class="settings-table-label">Context (K)</td>
        <td><input class="settings-input" id="new-model-ctx" type="number" value="128" min="1" style="width:100%"></td></tr>
    <tr><td class="settings-table-label">Tools</td>
        <td><input type="checkbox" id="new-model-tools" checked></td></tr>
    <tr><td class="settings-table-label">Thinking</td>
        <td><input type="checkbox" id="new-model-thinking"></td></tr>
    <tr id="new-model-url-row" style="display:none"><td class="settings-table-label">URL</td>
        <td><input class="settings-input" id="new-model-url" type="url" placeholder="http://localhost:8000/v1" style="width:100%"></td></tr>
    <tr id="new-model-key-row" style="display:none"><td class="settings-table-label">Key</td>
        <td><input class="settings-input" id="new-model-key" type="password" placeholder="(leave blank if not required)" style="width:100%"></td></tr>
    <tr id="new-model-api-row" style="display:none"><td class="settings-table-label">API</td>
        <td><select class="settings-input" id="new-model-api" style="width:100%">
          <option value="openai">OpenAI-compatible (default)</option>
          <option value="vllm">vLLM</option>
          <option value="ollama">Ollama</option>
        </select></td></tr>
    <tr><td class="settings-table-label">Note</td>
        <td><input class="settings-input" id="new-model-note" type="text" style="width:100%"></td></tr>
  </tbody></table>
  <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
    <button class="btn-save" onclick="addCustomModel()">Add</button>
    <button class="ws-action-btn" onclick="(document.getElementById('add-custom-model-form') as HTMLInputElement).style.display='none'">Cancel</button>
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
    const _esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    document.getElementById('fg-edit-model-dialog')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'fg-edit-model-dialog';
    overlay.className = 'fg-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.innerHTML = `<div class="fg-modal" style="max-width:520px;width:95%">
  <div class="fg-modal-header">
    <span class="fg-modal-title">Edit — ${_esc(m.provider)}:${_esc(m.model)}</span>
    <button class="fg-modal-close" onclick="document.getElementById('fg-edit-model-dialog')?.remove()">✕</button>
  </div>
  <div class="fg-modal-body" style="padding:12px 16px">
    <input type="hidden" id="emd-model-key" value="${_esc(key)}">
    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap;width:90px">Label</td>
          <td><input class="settings-input" id="emd-label" type="text" value="${_esc(m.label)}" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Params (B)</td>
          <td><input class="settings-input" id="emd-params" type="number" min="0" step="any" value="${m.params ?? ''}" placeholder="blank = unknown" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Context (K)</td>
          <td><input class="settings-input" id="emd-ctx" type="number" min="1" value="${m.contextK || 128}" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Released</td>
          <td><input class="settings-input" id="emd-released" type="text" value="${_esc(m.released)}" placeholder="YYYY-MM" style="margin:0;width:100%"></td></tr>
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
          <td><input class="settings-input" id="emd-url" type="url" value="${_esc(m.url)}" placeholder="http://localhost:8000/v1" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">API key</td>
          <td><input class="settings-input" id="emd-api-key" type="password" value="${_esc(m.key)}" placeholder="(blank = not required)" style="margin:0;width:100%"></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">API format</td>
          <td><select class="settings-input" id="emd-api-fmt" style="margin:0;width:100%">
            <option value="openai" ${(m.apiFormat || 'openai') === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
            <option value="vllm"   ${m.apiFormat === 'vllm'   ? 'selected' : ''}>vLLM</option>
            <option value="ollama" ${m.apiFormat === 'ollama' ? 'selected' : ''}>Ollama</option>
          </select></td></tr>` : ''}
      <tr><td style="padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap">Note</td>
          <td><input class="settings-input" id="emd-note" type="text" value="${_esc(m.note)}" style="margin:0;width:100%"></td></tr>
    </tbody></table>
  </div>
  <div class="fg-modal-btns">
    <button class="fg-modal-btn fg-modal-btn-cancel" onclick="document.getElementById('fg-edit-model-dialog')?.remove()">Cancel</button>
    <button class="fg-modal-btn fg-modal-btn-ok" onclick="saveEditModel()">Save</button>
  </div>
</div>`;

    document.body.appendChild(overlay);
    (document.getElementById('emd-label') as HTMLInputElement)?.focus();
}

function saveEditModel() {
    const key = (document.getElementById('emd-model-key') as HTMLInputElement)?.value;
    if (!key) return;

    const label     = ((document.getElementById('emd-label')    as HTMLInputElement)?.value ?? '').trim();
    const paramsRaw = ((document.getElementById('emd-params')   as HTMLInputElement)?.value ?? '').trim();
    const contextK  = parseInt((document.getElementById('emd-ctx')      as HTMLInputElement)?.value || '128', 10);
    const released  = ((document.getElementById('emd-released') as HTMLInputElement)?.value ?? '').trim();
    const rpmRaw    = ((document.getElementById('emd-rpm')      as HTMLInputElement)?.value ?? '').trim();
    const rpdRaw    = ((document.getElementById('emd-rpd')      as HTMLInputElement)?.value ?? '').trim();
    const tools     = ((document.getElementById('emd-tools')    as HTMLInputElement)?.checked) ?? true;
    const thinking  = ((document.getElementById('emd-thinking') as HTMLInputElement)?.checked) ?? false;
    const note      = ((document.getElementById('emd-note')     as HTMLInputElement)?.value ?? '').trim();

    // Optional custom-provider fields (only present when model is custom/vllm)
    const urlEl    = document.getElementById('emd-url')     as HTMLInputElement | null;
    const apiKeyEl = document.getElementById('emd-api-key') as HTMLInputElement | null;
    const apiFmtEl = document.getElementById('emd-api-fmt') as HTMLInputElement | null;

    const sep      = key.indexOf('|');
    const provider = key.slice(0, sep);
    const model    = key.slice(sep + 1);

    const updates: any = { provider, model, label, contextK, tools, thinking, note,
        params:    paramsRaw ? parseFloat(paramsRaw) : null,
        rpm:       rpmRaw   ? parseInt(rpmRaw, 10)  : null,
        rpd:       rpdRaw   ? parseInt(rpdRaw, 10)  : null,
        ...(released ? { released } : {}),
    };
    if (urlEl)    { const v = urlEl.value.trim();    if (v) updates.url       = v; }
    if (apiKeyEl) { const v = apiKeyEl.value.trim(); if (v) updates.key       = v; }
    if (apiFmtEl) { updates.apiFormat = apiFmtEl.value; }

    // Strip null rpm/rpd (no limit set) from the final entry
    if (updates.rpm  == null) delete updates.rpm;
    if (updates.rpd  == null) delete updates.rpd;
    if (updates.params == null) delete updates.params;

    const custom = getCustomModels();
    const idx    = custom.findIndex(c => `${c.provider}|${c.model}` === key);
    if (idx !== -1) {
        // Update existing custom entry, keeping fields not exposed in the form (e.g. cooldownMs)
        custom[idx] = { ...custom[idx], ...updates };
        saveCustomModels(custom);
    } else {
        // Built-in model: snapshot the original, hide it, push an edited custom copy
        const orig   = getAllModels().find(x => `${x.provider}|${x.model}` === key) ?? {};
        const merged = { ...orig, ...updates };
        if (!updates.rpm) delete (merged as any).rpm;
        if (!updates.rpd) delete (merged as any).rpd;
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
    const { containerId, srcIdx, srcEl } = _touchDrag;
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


function _renderPriorityList(containerId, list) {
    const container = (document.getElementById(containerId) as HTMLInputElement);
    if (!container) return;

    // Prune stale selection keys (model was removed from list).
    const listSet = new Set(list);
    for (const k of _prioritySelected) if (!listSet.has(k)) _prioritySelected.delete(k);
    if (!listSet.has(_priorityLastClicked!)) _priorityLastClicked = null;

    const pausedSet = new Set(getPausedMainModels());
    const multiSel  = _prioritySelected.size > 1;

    let html = `<div class="model-priority-list">`;
    if (!list.length) {
        html += `<div class="model-priority-empty">(none — all requests will fail)</div>`;
    }
    for (let i = 0; i < list.length; i++) {
        const key = list[i];
        const paused   = pausedSet.has(key);
        const selected = _prioritySelected.has(key);
        const lbl = modelFriendlyName(key) || key;
        const rem = typeof getCooldownRemaining === 'function' ? getCooldownRemaining(key) : 0;
        const coolTag = rem > 0 ? `<span class="model-priority-cool">⏳${rem}s</span>` : '';
        const rankCls     = (i === 0 && !paused) ? ' model-priority-rank-1' : '';
        const pausedCls   = paused    ? ' model-priority-paused'   : '';
        const selectedCls = selected  ? ' model-priority-selected' : '';
        // ↑/↓ title hints: when multiple rows are selected, the button moves them all.
        const upTitle   = (multiSel && selected) ? 'Move selected up'   : 'Move up';
        const downTitle = (multiSel && selected) ? 'Move selected down' : 'Move down';
        // On touch devices, draggable="true" on the row intercepts all child touch
        // events, making the ↑/↓ buttons unresponsive (iOS Safari bug).
        // Instead: omit draggable and use a touch-drag handle with touchstart/touchmove/touchend.
        if (_isTouchDevice) {
            html += `<div class="model-priority-row${rankCls}${pausedCls}${selectedCls}" data-idx="${i}"
            onclick="_priorityRowClick(event,'${key.replace(/'/g, "\\'")}')"
            ontouchmove="_priorityTouchMove(event)"
            ontouchend="_priorityTouchEnd(event)">
  <span class="model-priority-drag-handle" title="Drag to reorder"
        ontouchstart="_priorityTouchStart(event,'${containerId}',${i})"
        ontouchmove="_priorityTouchMove(event)"
        ontouchend="_priorityTouchEnd(event)">⠿</span>
  <span class="model-priority-rank">${paused ? '–' : i + 1 - [...list.slice(0, i)].filter(k => pausedSet.has(k)).length}</span>
  <span class="model-priority-label">${lbl}${coolTag}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" title="${upTitle}" onclick="_movePriorityItem('${containerId}',${i},-1)">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" title="${downTitle}" onclick="_movePriorityItem('${containerId}',${i},1)">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
    <button class="model-table-btn model-table-btn-pause${paused ? ' active' : ''}" title="${paused ? 'Resume' : 'Pause'}" onclick="_togglePauseItem('${key}')">${paused ? '+' : '–'}</button>
    <button class="model-table-btn" title="Remove" onclick="_removePriorityItem('${containerId}',${i})">✕</button>
  </span>
</div>`;
        } else {
            html += `<div class="model-priority-row${rankCls}${pausedCls}${selectedCls}" data-idx="${i}"
            draggable="true"
            onclick="_priorityRowClick(event,'${key.replace(/'/g, "\\'")}')"
            ondragstart="_handleDragStart(event, '${containerId}', ${i})"
            ondragover="_handleDragOver(event)"
            ondragleave="_handleDragLeave(event)"
            ondragend="_handleDragEnd(event)"
            ondrop="_handleDrop(event, '${containerId}', ${i})">
  <span class="model-priority-rank">${paused ? '–' : i + 1 - [...list.slice(0, i)].filter(k => pausedSet.has(k)).length}</span>
  <span class="model-priority-label">${lbl}${coolTag}</span>
  <span class="model-priority-actions">
    ${i > 0 ? `<button class="model-table-btn" title="${upTitle}" onclick="_movePriorityItem('${containerId}',${i},-1)">↑</button>` : '<span class="model-table-btn-placeholder"></span>'}
    ${i < list.length - 1 ? `<button class="model-table-btn" title="${downTitle}" onclick="_movePriorityItem('${containerId}',${i},1)">↓</button>` : '<span class="model-table-btn-placeholder"></span>'}
    <button class="model-table-btn model-table-btn-pause${paused ? ' active' : ''}" title="${paused ? 'Resume' : 'Pause'}" onclick="_togglePauseItem('${key}')">${paused ? '+' : '–'}</button>
    <button class="model-table-btn" title="Remove" onclick="_removePriorityItem('${containerId}',${i})">✕</button>
  </span>
</div>`;
        }
    }
    const _addModels = getAllModels()
        .filter(m => !list.includes(`${m.provider}|${m.model}`))
        .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
        .map(m => ({ value: `${m.provider}|${m.model}`, label: `${m.provider}/${m.model}` }));
    html += `</div>
<div style="margin-top:6px">
  <div class="model-combo" id="${containerId}-add-combo"
       data-options='${JSON.stringify(_addModels).replace(/'/g, "&#39;")}'
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
        ? `<span class="ibtn-provider">${trim(provider, 16)}</span><span class="ibtn-model">${trim(modelId, 28)}${coolSfx}</span>`
        : `<span class="ibtn-model">no model</span>`;
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
}

function _renderInputModelPicker(picker: HTMLElement): void {
    const list = typeof getMainModelList === 'function' ? getMainModelList() : [];
    const all  = typeof getAllModels === 'function' ? getAllModels() : [];
    const active = list[0] || '';
    const seen = new Set<string>();
    const items: Array<{spec: string; label: string}> = [];
    for (const spec of list) {
        if (seen.has(spec)) continue;
        seen.add(spec);
        items.push({ spec, label: modelFriendlyName(spec) || spec.replace('|', '/') });
    }
    picker.innerHTML = items.map(it =>
        `<div class="picker-model-item${it.spec === active ? ' picker-active' : ''}"
              onclick="_selectInputModel('${it.spec.replace(/'/g, "\\'")}')">
            <span>${it.label}</span>
         </div>`
    ).join('') +
    `<div class="picker-model-item picker-all-link" onclick="activateTab('settings');document.getElementById('input-model-picker')?.classList.remove('picker-open')">Browse all models…</div>`;
}

function _selectInputModel(spec: string): void {
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

        // All text-capable models that are not currently cooling down
        const all = typeof getAllModels === 'function' ? getAllModels() : [];
        const available = all.filter(m => {
            if (m.media && !m.media.includes('text')) return false;
            const spec = `${m.provider}|${m.model}`;
            return (typeof getCooldownRemaining !== 'function' || getCooldownRemaining(spec) === 0);
        });
        if (!available.length) { alert('No available (non-cooling) models found.'); return; }

        // Fetch Openrouter model list for benchmark data (no auth needed, CORS open).
        // The response includes benchmarks.artificial_analysis.intelligence_index for some models.
        // We build: (a) a direct score map for available models, (b) a reference leaderboard
        // of all scored models sorted by score, to give the LLM a calibration scale.
        let orBenchmarks: Map<string, number> = new Map(); // OR model_id → intelligence_index
        let orRefLeaderboard = '';
        try {
            const orResp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(10_000),
            });
            if (orResp.ok) {
                const orJson = await orResp.json().catch(() => null);
                const orAll: any[] = Array.isArray(orJson?.data) ? orJson.data : [];
                for (const om of orAll) {
                    const ii = (om?.benchmarks?.artificial_analysis?.intelligence_index) ?? null;
                    if (typeof ii === 'number') orBenchmarks.set(om.id as string, ii);
                }
                // Build reference leaderboard: top scored models, for calibration scale
                const sorted = [...orBenchmarks.entries()].sort((a, b) => b[1] - a[1]);
                if (sorted.length) {
                    // Deduplicate: prefer :free variants, skip :batch and duplicates
                    const seen = new Set<string>();
                    const refRows: string[] = [];
                    for (const [id, ii] of sorted) {
                        const base = id.replace(/:(?:free|batch)$/, '');
                        if (seen.has(base)) continue;
                        seen.add(base);
                        const tag = id.endsWith(':free') ? ' (free tier)' : '';
                        refRows.push(`  ${id}${tag}: ${ii}`);
                        if (refRows.length >= 20) break;
                    }
                    orRefLeaderboard = refRows.join('\n');
                }
            }
        } catch { /* network error — proceed without benchmark data */ }

        // Number the list so the LLM returns integers — avoids all provider|model format corruption
        // (slash-vs-pipe confusion, :free suffixes, hallucinated partial specs, etc.)
        const modelLines = available.map((m, i) => {
            const params = m.params ? `${m.params}B` : '?B';
            const caps = [m.tools && 'tools', m.thinking && 'thinking'].filter(Boolean).join('+') || 'basic';
            // Lookup intelligence_index: try provider|model id and model id (:free stripped)
            const orId = m.provider === 'openrouter' ? m.model : null;
            const ii = orId != null
                ? (orBenchmarks.get(orId) ?? orBenchmarks.get(orId.replace(/:free$/, '')) ?? null)
                : null;
            const score = ii != null ? `, AA-index:${ii}` : '';
            return `${i + 1}. ${m.label} — ${m.contextK}K ctx, ${params}, ${caps}, ${m.released}${score}: ${m.note}`;
        }).join('\n');

        const refSection = orRefLeaderboard
            ? `\nFor reference — Artificial Analysis Intelligence Index (higher = more capable, includes paid models as calibration scale):\n${orRefLeaderboard}\n`
            : '';

        const userMsg =
`Rank these free AI models by overall capability for general-purpose tasks (coding, reasoning, instruction following, tool use). Prefer larger parameter counts, longer context, tool support, recency, and AA-index score where shown.
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
                            items: { type: 'integer', minimum: 1, maximum: available.length },
                        },
                    },
                    required: ['rankings'],
                },
            },
        };

        // Collect candidate endpoints in preference order, deduped by provider|model
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
            const key = `${ep.provider}|${ep.model}`;
            if (!_seen.has(key)) { _seen.add(key); epCandidates.push(ep); }
        }
        if (!epCandidates.length) return _fail('no endpoint available');

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
            rawIndices = (parsed?.rankings ?? []).filter((n: any) => Number.isInteger(n));
        }

        // Prose fallback: scan for digit sequences that could be list indices
        if (!rawIndices.length && result?.content) {
            console.warn('[auto-rank] no tool_calls, parsing prose for numbers');
            const seen = new Set<number>();
            for (const m of result.content.matchAll(/\b(\d{1,3})\b/g)) {
                const n = parseInt(m[1], 10);
                if (n >= 1 && n <= available.length && !seen.has(n)) { seen.add(n); rawIndices.push(n); }
            }
        }

        const picked: string[] = [];
        for (const idx of rawIndices) {
            if (idx >= 1 && idx <= available.length) {
                const m = available[idx - 1];
                const spec = `${m.provider}|${m.model}`;
                if (!picked.includes(spec)) picked.push(spec);
            }
            if (picked.length >= 10) break;
        }
        if (!picked.length) return _fail(`no valid indices in response — got: ${rawIndices.slice(0, 10).join(', ')}`);

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
                return `<option value="${spec}"${sel}>${m.provider}/${m.model}</option>`;
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
        `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)
    ).map(m => ({ value: `${m.provider}|${m.model}`, label: `${m.provider}/${m.model}` }));
    const allOpts = (fixedOpts as ComboOption[]).concat(modelOpts);
    const currentLabel = allOpts.find(o => o.value === current)?.label ?? current;
    container.innerHTML = `<div class="model-combo" id="worker-model-combo"
     style="flex:1"
     data-options='${JSON.stringify(allOpts).replace(/'/g, "&#39;")}'
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
        `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)
    ).map(m => ({ value: `${m.provider}|${m.model}`, label: `${m.provider}/${m.model}` }));
    const allOpts = (fixedOpts as ComboOption[]).concat(modelOpts);
    const currentLabel = allOpts.find(o => o.value === current)?.label ?? current;
    container.innerHTML = `<div class="model-combo" id="utility-model-combo"
     style="flex:1"
     data-options='${JSON.stringify(allOpts).replace(/'/g, "&#39;")}'
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

function _movePriorityItem(containerId, idx, dir) {
    const list = getMainModelList();
    if (idx < 0 || idx >= list.length) return;

    if (_prioritySelected.size > 1 && _prioritySelected.has(list[idx])) {
        // Multi-move: shift every selected item by one position in `dir`.
        // Process in the order that avoids clobbering the swap partner:
        //   moving up → ascending index order (each item swaps with the one just above it)
        //   moving down → descending index order (each item swaps with the one just below it)
        const idxs = list.map((k, i) => (_prioritySelected.has(k) ? i : -1)).filter(i => i >= 0);
        if (dir === -1) {
            idxs.sort((a, b) => a - b);
            if (idxs[0] === 0) return; // already at top, nowhere to go
            for (const i of idxs) {
                if (i > 0 && !_prioritySelected.has(list[i - 1]))
                    [list[i], list[i - 1]] = [list[i - 1], list[i]];
            }
        } else {
            idxs.sort((a, b) => b - a);
            if (idxs[0] === list.length - 1) return; // already at bottom
            for (const i of idxs) {
                if (i < list.length - 1 && !_prioritySelected.has(list[i + 1]))
                    [list[i], list[i + 1]] = [list[i + 1], list[i]];
            }
        }
    } else {
        // Single-move.
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= list.length) return;
        [list[idx], list[newIdx]] = [list[newIdx], list[idx]];
    }
    saveMainModelList(list);
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
    localStorage.setItem(key, String(value));
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
    // Sync header compact-tokens select
    { const v = String(getAgentCompactTokens()); const h = (document.getElementById('hdr-compact-tokens') as HTMLSelectElement);
      if (h) { const opts = [...h.options].map(o => o.value); h.value = opts.includes(v) ? v : '20000'; } }

    cb('agent-concise-prompts',   getAgentConcisePrompts());
    cb('agent-plan-mode',         getAgentPlanMode());
    num('agent-max-rounds',       getAgentMaxSteps());
    num('rate-limit-cooldown-min', parseInt(ls('fg_rate_limit_cooldown_min', '2'), 10));
    cb('agent-lean-workers',      getAgentLeanWorkers());
    cb('agent-worker-history',    getAgentWorkerHistory());
    cb('agent-worker-reduce',     getAgentWorkerReduce());
    cb('agent-role-model-routing',       getAgentRoleModelRouting());
    cb('endpoint-rotation',              getEndpointRotation());
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
            if (cb.checked) disabledRoles.delete(role.name);
            else disabledRoles.add(role.name);
            localStorage.setItem('fg_disabled_roles', JSON.stringify([...disabledRoles]));
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
                    // eslint-disable-next-line no-new-func
                    const rendered = new Function(_fnBody)() as string;
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
                const hl = re
                    ? o.label.replace(re, m => `<mark>${m}</mark>`)
                    : o.label;
                const safeVal = o.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                if (addMode) {
                    // Inline-add mode: each row has its own Add button.
                    // onmousedown fires before onblur, so the click is captured before
                    // the dropdown closes.
                    return `<div class="model-combo-option model-combo-option-add" data-value="${o.value}">` +
                        `<span class="model-combo-option-label">${hl}</span>` +
                        `<button class="model-combo-add-btn" onmousedown="event.preventDefault();_comboAddItem('${comboId}','${safeVal}')">Add</button>` +
                        `</div>`;
                }
                return `<div class="model-combo-option" data-value="${o.value}"
                    onmousedown="_comboSelect('${comboId}','${safeVal}')">${hl}</div>`;
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
    } else if (event.key === 'Enter' && cur >= 0) {
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
Object.assign(window, { switchSettingsTab, _comboFilter, _comboOpen, _comboBlur, _comboKey, _comboSelect, _comboAddItem, _addVoiceItem, _removeVoiceItem, _moveVoiceItem, saveVoiceSettings, populateVoiceTab, showSettings, onPyodideAutoloadChange, onSandboxProviderChange, saveSettings, populateSettingsForm, updateActiveModelDisplay, initHdrPicker, showModelCooldownPopup, hideModelCooldownPopup, applyHdrSearch, applyHdrCompactTokens, applyHdrReasoning, saveSamplingSetting, populateSamplingSettings, renderModelCatalogTable, _sortModelCatalog, showAddCustomModelForm, addCustomModel, deleteModel, deleteCustomModel, openEditModelDialog, saveEditModel, _onNewModelProviderChange, renderMainModelList, saveMediaModel, renderMediaModelSelectors, renderWorkerModelSelector, renderUtilityModelSelector, autoPopulateModelPriority, _priorityRowClick, _movePriorityItem, _removePriorityItem, _addPriorityItem, saveAgentSetting, renderRolesTab, _handleDragStart, _handleDragEnd, _handleDragOver, _handleDragLeave, _handleDrop, _togglePauseItem, _priorityTouchStart, _priorityTouchMove, _priorityTouchEnd, updateInputModelBtn, toggleInputModelPicker, _selectInputModel, _modelPageUrl });
