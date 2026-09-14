// profiles.js — FreeGent settings profiles
// Depends on config.js (ls, getters), settings-ui.js (populateSettingsForm, updateProviderFields)

// Settings captured in a profile — everything except API credentials (keys are never captured)
const PROFILE_KEYS = [
    'fg_primary_models',
    'fg_custom_models',
    'fg_openai_url', 'fg_openai_model', 'fg_openai_context',
    'fg_search_provider',
    'fg_sandbox_provider',
    'fg_agent_tool_result_truncation',
    'fg_agent_max_tool_result',
    'fg_agent_proactive_compact',
    'fg_agent_compact_at',
    'fg_agent_compact_tokens',
    'fg_agent_plan_mode',
    'fg_agent_max_rounds',
    'fg_rate_limit_cooldown_min',
    'fg_agent_lean_workers',
    'fg_agent_worker_history',
    'fg_active_skills',
    'fg_builtin_skills',
    'fg_builtin_rules',
    'fg_skill_triggers',
    'fg_agent_prompt_template',
    'fg_agent_concise_prompts',
    'fg_agent_worker_reduce',
    'fg_agent_role_model_routing',
    'fg_endpoint_rotation',
    'fg_worker_thinking_budget',
    'fg_preserve_thinking',
    'fg_agent_max_delegation_depth',
    'fg_qa_enabled',
    'fg_qa_acceptance_review',
    'fg_qa_test_runner',
    'fg_qa_regression_guard',
    'fg_qa_rework_limit',
    'fg_agent_loop_qa',
    'fg_agent_loop_max_consecutive_failures',
    'fg_agent_ledger',
    'fg_agent_review_logs',
    // (entity memory removed)
    'fg_intent_validation',
    'fg_director_max_tool_result',
    'fg_tool_approval',
    'fg_git_enabled',
    'fg_ast_enabled',
    'fg_image_model',
    'fg_audio_model',
    'fg_video_model',
    'fg_top_p',
    'fg_top_k',
    'fg_min_p',
    'fg_presence_penalty',
    'fg_repetition_penalty',
];

const PROFILE_KEY_META = {
    fg_primary_models:              { label: 'Primary models',        section: 'Models',  isList: true },
    fg_custom_models:               { label: 'Custom models',         section: 'Models',  isList: true },
    fg_openai_url:                  { label: 'OpenAI-compat URL',     section: 'Models'  },
    fg_openai_model:                { label: 'OpenAI-compat model',   section: 'Models'  },
    fg_openai_context:              { label: 'OpenAI-compat context', section: 'Models'  },
    fg_image_model:                 { label: 'Image model',           section: 'Models'  },
    fg_audio_model:                 { label: 'Audio model',           section: 'Models'  },
    fg_video_model:                 { label: 'Video model',           section: 'Models'  },
    fg_endpoint_rotation:           { label: 'Endpoint rotation',     section: 'Models'  },
    fg_rate_limit_cooldown_min:     { label: 'Rate-limit cooldown',   section: 'Models'  },
    fg_search_provider:             { label: 'Search provider',       section: 'Search'  },
    fg_sandbox_provider:            { label: 'Sandbox provider',      section: 'Code'    },
    fg_agent_tool_result_truncation:{ label: 'Tool result truncation',section: 'Agent'   },
    fg_agent_max_tool_result:       { label: 'Max result chars',      section: 'Agent'   },
    fg_agent_proactive_compact:     { label: 'Proactive compaction',  section: 'Agent'   },
    fg_agent_compact_at:            { label: 'Compact at (%)',        section: 'Agent'   },
    fg_agent_compact_tokens:        { label: 'Compact at (tokens)',   section: 'Agent'   },
    fg_agent_plan_mode:             { label: 'Plan mode',             section: 'Agent'   },
    fg_agent_max_rounds:            { label: 'Max rounds',            section: 'Agent'   },
    fg_agent_lean_workers:          { label: 'Lean workers',          section: 'Agent'   },
    fg_agent_worker_history:        { label: 'Shared-prefix workers', section: 'Agent'   },
    fg_active_skills:               { label: 'Always-on skills/rules', section: 'Skills',  isList: true },
    fg_builtin_skills:              { label: 'Built-in skills',        section: 'Skills',  isList: true },
    fg_builtin_rules:               { label: 'Built-in rules',         section: 'Skills',  isList: true },
    fg_skill_triggers:              { label: 'Skill/rule overrides',   section: 'Skills' },
    fg_agent_prompt_template:       { label: 'Prompt template',       section: 'Agent'   },
    fg_agent_concise_prompts:       { label: 'Concise prompts',       section: 'Agent'   },
    fg_agent_worker_reduce:         { label: 'Worker output reduce',   section: 'Agent'   },
    fg_agent_role_model_routing:       { label: 'Role model routing',       section: 'Agent'   },
    fg_worker_thinking_budget:         { label: 'Worker thinking budget',   section: 'Agent'   },
    fg_preserve_thinking:              { label: 'Preserve thinking (vLLM)', section: 'Agent'   },
    fg_agent_max_delegation_depth:     { label: 'Max delegation depth',     section: 'Agent'   },
    fg_qa_enabled:             { label: 'QA gates enabled',        section: 'Agent' },
    fg_qa_acceptance_review:   { label: 'Acceptance review',        section: 'Agent' },
    fg_qa_test_runner:         { label: 'QA test runner',           section: 'Agent' },
    fg_qa_regression_guard:    { label: 'Regression guard',         section: 'Agent' },
    fg_qa_rework_limit:        { label: 'QA rework limit',          section: 'Agent' },
    fg_agent_loop_qa:                       { label: 'Runner QA gates',        section: 'Agent' },
    fg_agent_loop_max_consecutive_failures: { label: 'Runner failure limit',   section: 'Agent' },
    fg_agent_ledger:                       { label: 'Task/Progress Ledger',       section: 'Agent' },
    fg_agent_review_logs:                  { label: 'Review message logs',        section: 'Agent' },
    // (entity memory removed)
    fg_intent_validation:               { label: 'Intent validation',         section: 'Agent',   isSelect: true },
    fg_director_max_tool_result:        { label: 'Director max tool result',  section: 'Agent',   isNumber: true },
    fg_tool_approval:                   { label: 'Tool approval',             section: 'Agent',   isSelect: true },
    fg_git_enabled:                     { label: 'Git access',                 section: 'Code'    },
    fg_ast_enabled:                     { label: 'AST code queries',           section: 'Code'    },
    fg_top_p:                           { label: 'Top P',                     section: 'Models'  },
    fg_top_k:                           { label: 'Top K',                     section: 'Models'  },
    fg_min_p:                           { label: 'Min P',                     section: 'Models'  },
    fg_presence_penalty:                { label: 'Presence penalty',          section: 'Models'  },
    fg_repetition_penalty:              { label: 'Repetition penalty',        section: 'Models'  },
};

const PROFILE_DEFAULT_PRIMARY_MODELS = JSON.stringify([
    'mistral|mistral-medium-3.5',
    'openrouter|nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter|nvidia/nemotron-3-super-120b-a12b:free',
]);

const BUILTIN_PROFILES = [
    {
        id: 'paid',
        name: 'Paid',
        description: 'For paid cloud APIs (Mistral, Qwen3 via OpenRouter). Full system prompt, eager skill injection, rich worker tool sets. Context is compacted only at the hard limit — no proactive trimming.',
        settings: {
            fg_primary_models:               PROFILE_DEFAULT_PRIMARY_MODELS,
            fg_agent_tool_result_truncation: 'true',
            fg_agent_max_tool_result:        '100000',
            fg_agent_proactive_compact:      'false',
            fg_agent_compact_at:             '0.75',
            fg_agent_plan_mode:              'false',
            fg_agent_max_rounds:             '20',
            fg_agent_lean_workers:           'false',
            fg_agent_worker_history:         'true',
            fg_agent_concise_prompts:        'true',
            fg_agent_worker_reduce:          'true',
            fg_agent_role_model_routing:     'true',
            fg_worker_thinking_budget:       '24576',
            fg_agent_max_delegation_depth:   '1',
            fg_qa_enabled:             'true',
            fg_qa_acceptance_review:   'true',
            fg_qa_test_runner:         'true',
            fg_qa_regression_guard:    'false',
            fg_qa_rework_limit:        '3',
            fg_agent_loop_qa:                       'true',
            fg_agent_loop_max_consecutive_failures: '5',
            fg_agent_ledger:                       'true',
            fg_agent_review_logs:                  'false',
            fg_openai_context:                     '50000',
            fg_tool_approval:                      'off',
            fg_git_enabled:                        'false',
            fg_ast_enabled:                        'true',
            fg_agent_prompt_template:
`You are operating on a paid cloud model with a large context window. Approach every task with depth and thoroughness:
- Split tasks with independent subtasks across workers — parallelism is your primary scaling mechanism; wall time stays flat regardless of how many workers run in parallel
- Use the full tool suite without economising — explore, verify, and iterate freely; tool results stay in context
- Produce comprehensive, detailed outputs; do not truncate analysis, summaries, or implementations
- Write production-ready code: no stubs, no placeholders, no TODOs — complete implementations with proper error handling
- Verify your work: run code with execute_code, check outputs, and test edge cases before reporting done
- On unfamiliar codebases, use execute_code (bash: grep/find) to map symbols before choosing which files to read`,
        },
    },
    {
        id: 'free',
        name: 'Free',
        description: 'For free-tier OpenRouter models: Nemotron Ultra 550B (1M ctx), Nemotron Super 120B (262K ctx), Gemma 4 31B (262K ctx). Proactive compaction at 40K tokens. Compressed system prompt (30%), lazy skill injection, and lean worker tool sets to stay within TPM limits.',
        settings: {
            fg_primary_models:               JSON.stringify(['openrouter|nvidia/nemotron-3-ultra-550b-a55b:free','openrouter|nvidia/nemotron-3-super-120b-a12b:free','openrouter|google/gemma-4-31b-it:free']),
            fg_agent_tool_result_truncation: 'true',
            fg_agent_max_tool_result:        '100000',
            fg_agent_proactive_compact:      'true',
            fg_agent_compact_at:             '0.75',
            fg_agent_compact_tokens:         '40000',
            fg_agent_plan_mode:              'false',
            fg_agent_max_rounds:             '20',
            fg_agent_lean_workers:           'true',
            fg_agent_worker_history:         'true',
            fg_agent_concise_prompts:        'true',
            fg_agent_worker_reduce:          'true',
            fg_agent_role_model_routing:     'true',
            fg_worker_thinking_budget:       '24576',
            fg_agent_max_delegation_depth:   '1',
            fg_qa_enabled:             'true',
            fg_qa_acceptance_review:   'true',
            fg_qa_test_runner:         'true',
            fg_qa_regression_guard:    'false',
            fg_qa_rework_limit:        '3',
            fg_agent_loop_qa:                       'true',
            fg_agent_ledger:                       'true',
            fg_agent_review_logs:                  'false',
            fg_agent_loop_max_consecutive_failures: '5',
            fg_openai_context:                     '50000',
            fg_tool_approval:                      'off',
            fg_git_enabled:                        'false',
            fg_ast_enabled:                        'true',
            fg_agent_prompt_template:
`You are operating on a capable model with a large context window (256K+) and strong native tool use. Two priorities shape every turn:

**Maximise parallelism.** Do not execute sequentially what can run in parallel:
- Immediately split tasks with independent subtasks across workers — the main loop coordinates, workers execute
- Each worker runs in its own context window; only the compact result returns here, keeping this context clean
- Use workers for research, writing, and multi-file code work — even tasks that seem small benefit from offloading

**Minimise context growth.** Reasoning and tool results accumulate quickly, especially with thinking mode active:
- Write findings and intermediate results to files rather than carrying them in the conversation
- Read only what you need — use execute_code (bash: grep -r) to locate content first, then read targeted sections
- Batch multiple file operations into a single execute_code script rather than sequential tool calls
- On unfamiliar codebases, use execute_code (bash: find + grep) to map the structure before reading files

Write complete, working implementations — no stubs or placeholders.`,
        },
    },
];

let _previewedId: string | null = null;


function captureCurrentProfile() {
    const p = {};
    for (const k of PROFILE_KEYS) {
        // fg_primary_models is the profile key; the runtime writes to fg_main_models
        const storageKey = k === 'fg_primary_models' ? 'fg_main_models' : k;
        const v = localStorage.getItem(storageKey);
        if (v !== null) p[k] = v;
    }
    return p;
}

function computeProfileDiff(targetSettings) {
    const changes = [];
    for (const key of PROFILE_KEYS) {
        const meta = PROFILE_KEY_META[key];
        if (!meta) continue;
        const current = localStorage.getItem(key);
        const target  = key in targetSettings ? targetSettings[key] : null;
        if (current === target) continue;

        const entry: any = { key, label: meta.label, section: meta.section, isList: !!meta.isList };
        if (meta.isList) {
            try {
                const fromArr = JSON.parse(current || '[]');
                const toArr   = JSON.parse(target  || '[]');
                const fromSet = new Set(fromArr);
                const toSet   = new Set(toArr);
                entry.added   = toArr.filter(x => !fromSet.has(x));
                entry.removed = fromArr.filter(x => !toSet.has(x));
                if (!entry.added.length && !entry.removed.length) continue;
            } catch {
                entry.from = current; entry.to = target;
            }
        } else {
            entry.from = current; entry.to = target;
        }
        changes.push(entry);
    }
    return changes;
}

function _fmtVal(key, val) {
    if (val === null || val === undefined) return '(default)';
    if (val === 'true')  return '✓';
    if (val === 'false') return '✗';
    if (key === 'fg_agent_compact_at')
        return Math.round(parseFloat(val) * 100) + '%';
    return val.length > 42 ? val.slice(0, 39) + '…' : val;
}

function getSavedProfiles() {
    try { return JSON.parse(localStorage.getItem('fg_profiles') || '{}'); }
    catch { return {}; }
}

// Keys absent from the profile are removed (reset to default); API keys are never touched.
function profileApply(settings) {
    for (const key of PROFILE_KEYS) {
        if (key in settings) localStorage.setItem(key, settings[key]);
        else localStorage.removeItem(key);
    }
    // Sync fg_primary_models (profile key) → fg_main_models (runtime key)
    const m = localStorage.getItem('fg_primary_models');
    if (m) localStorage.setItem('fg_main_models', m);
    else   localStorage.removeItem('fg_main_models');
    _previewedId = null;
    if (typeof populateSettingsForm === 'function') populateSettingsForm();
    renderProfilesTab();
}


function profileSaveCurrent() {
    const input = document.getElementById('profile-name-input') as HTMLInputElement | null;
    const name  = (input ? input.value : '').trim();
    if (!name) { alert('Enter a profile name.'); return; }
    const profiles = getSavedProfiles();
    profiles[name] = { settings: captureCurrentProfile(), savedAt: new Date().toISOString() };
    localStorage.setItem('fg_profiles', JSON.stringify(profiles));
    if (input) input.value = name === 'current' ? 'current' : '';
    renderProfilesTab();
}

function profileDelete(name) {
    if (!confirm('Delete profile "' + name + '"?')) return;
    const profiles = getSavedProfiles();
    delete profiles[name];
    localStorage.setItem('fg_profiles', JSON.stringify(profiles));
    if (_previewedId === 'user:' + name) _previewedId = null;
    renderProfilesTab();
}

function profileDownload(name, settings) {
    const data = JSON.stringify({ name, version: 1, savedAt: new Date().toISOString(), settings }, null, 2);
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = /^(current|fg-current-profile(\.json)?)$/i.test(name.trim()) ? 'fg-current-profile.json'
               : 'fg-profile-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

function profileUpload() {
    const inp  = document.createElement('input');
    inp.type   = 'file';
    inp.accept = '.json';
    inp.onchange = async () => {
        const file = inp.files[0];
        if (!file) return;
        try {
            const data     = JSON.parse(await file.text());
            const name     = data.name || file.name.replace(/\.json$/, '');
            const settings = data.settings || data;
            const profiles = getSavedProfiles();
            profiles[name] = { settings, savedAt: new Date().toISOString() };
            localStorage.setItem('fg_profiles', JSON.stringify(profiles));
            renderProfilesTab();
        } catch (e) { alert('Failed to import profile: ' + e.message); }
    };
    inp.click();
}

function profilePreview(id) {
    _previewedId = _previewedId === id ? null : id;
    renderProfilesTab();
}


function _renderDiffInto(el, changes) {
    if (!changes.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:12px;margin:0">No changes — matches your current configuration.</p>';
        return;
    }
    const bySect: Record<string, any[]> = {};
    for (const ch of changes) {
        if (!bySect[ch.section]) bySect[ch.section] = [];
        bySect[ch.section].push(ch);
    }
    const html = [];
    for (const [sect, items] of Object.entries(bySect)) {
        html.push('<div style="margin-bottom:10px">');
        html.push('<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:5px">' + sect + '</div>');
        for (const ch of items) {
            if (ch.isList) {
                const parts = [];
                for (const a of (ch.added   || [])) parts.push('<span style="color:#4caf50">+' + a + '</span>');
                for (const r of (ch.removed || [])) parts.push('<span style="color:#e57373">−' + r + '</span>');
                html.push('<div style="font-size:12px;margin-bottom:3px">' + ch.label + ': ' + parts.join(' ') + '</div>');
            } else {
                const from = '<span style="color:var(--muted)">' + _fmtVal(ch.key, ch.from) + '</span>';
                const to   = '<span style="color:var(--accent);font-weight:500">' + _fmtVal(ch.key, ch.to) + '</span>';
                html.push('<div style="font-size:12px;margin-bottom:3px">' + ch.label + ': ' + from + ' → ' + to + '</div>');
            }
        }
        html.push('</div>');
    }
    el.innerHTML = html.join('');
}

function _makeProfileCard(uid, name, description, settings, isBuiltin, savedAt) {
    const diff    = computeProfileDiff(settings);
    const changed = diff.length;
    const isOpen  = _previewedId === uid;

    const card = document.createElement('div');
    card.className = 'profile-card' + (isOpen ? ' profile-card-open' : '');

    const hdr = document.createElement('div');
    hdr.className = 'profile-card-hdr';
    hdr.onclick   = () => profilePreview(uid);

    const infoDiv = document.createElement('div');
    infoDiv.style.flex = '1';
    infoDiv.style.minWidth = '0';

    const topLine = document.createElement('div');
    topLine.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    topLine.innerHTML =
        '<span style="font-size:13px;font-weight:600">' + name + '</span>' +
        (isBuiltin
            ? '<span style="font-size:10px;background:var(--border);color:var(--muted);padding:1px 6px;border-radius:3px">built-in</span>'
            : '') +
        (changed
            ? '<span style="font-size:11px;color:var(--muted)">' + changed + ' change' + (changed !== 1 ? 's' : '') + '</span>'
            : '<span style="font-size:11px;color:#4caf50">✓ current</span>');

    const descLine = document.createElement('div');
    descLine.style.cssText = 'font-size:12px;color:var(--muted);margin-top:2px';
    descLine.textContent = description + (savedAt ? ' · ' + savedAt.slice(0, 10) : '');

    infoDiv.append(topLine, descLine);

    const actDiv = document.createElement('div');
    actDiv.style.cssText = 'display:flex;gap:6px;flex-shrink:0;margin-left:10px';
    actDiv.onclick = e => e.stopPropagation();

    if (!isBuiltin) {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'ws-action-btn'; dlBtn.title = 'Download'; dlBtn.textContent = '↓';
        dlBtn.onclick = () => profileDownload(name, settings);

        const delBtn = document.createElement('button');
        delBtn.className = 'ws-action-btn'; delBtn.title = 'Delete'; delBtn.textContent = '✕';
        delBtn.style.color = '#e57373';
        delBtn.onclick = () => profileDelete(name);
        actDiv.append(dlBtn, delBtn);
    }

    hdr.append(infoDiv, actDiv);
    card.appendChild(hdr);

    if (isOpen) {
        const panel = document.createElement('div');
        panel.className = 'profile-diff-panel';

        const diffEl = document.createElement('div');
        diffEl.style.marginBottom = '10px';
        _renderDiffInto(diffEl, diff);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn-save';
        applyBtn.style.cssText = 'padding:5px 16px;font-size:12px';
        applyBtn.textContent = changed ? 'Apply profile' : 'Re-apply';
        applyBtn.onclick = () => profileApply(settings);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ws-action-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => profilePreview(uid);

        btnRow.append(applyBtn, cancelBtn);
        panel.append(diffEl, btnRow);
        card.appendChild(panel);
    }

    return card;
}

function renderProfilesTab() {
    const el = document.getElementById('profiles-list');
    if (!el) return;
    el.innerHTML = '';

    const biHdr = document.createElement('p');
    biHdr.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin:0 0 8px';
    biHdr.textContent   = 'Built-in';
    el.appendChild(biHdr);

    for (const p of BUILTIN_PROFILES) {
        el.appendChild(_makeProfileCard('builtin:' + p.id, p.name, p.description, p.settings, true, null));
    }

    const saved = getSavedProfiles();
    const names = Object.keys(saved);

    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:14px 0 12px';
    el.appendChild(sep);

    const savedHdr = document.createElement('p');
    savedHdr.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin:0 0 8px';
    savedHdr.textContent   = 'Saved';
    el.appendChild(savedHdr);

    if (!names.length) {
        el.insertAdjacentHTML('beforeend',
            '<p style="color:var(--muted);font-size:13px;margin:0">No saved profiles yet. Use the form above to save your current settings.</p>');
    } else {
        for (const name of names) {
            const { settings, savedAt } = saved[name];
            el.appendChild(_makeProfileCard('user:' + name, name, '', settings, false, savedAt));
        }
    }
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { profileSaveCurrent, profileDelete, profileDownload, profileUpload, profilePreview, renderProfilesTab });
