// Central registry of all localStorage keys used by FreeGent.
// Import KEYS (static) or the key-builder functions (dynamic) instead of using raw strings.
// Enables enumeration, prevents typos, and documents the full key surface in one place.

export const KEYS = {
    // ── Session / navigation ────────────────────────────────────────────────
    ACTIVE_CHAT:        'fg_active_chat',
    CHAT_LIST:          'fg_chat_list',

    // ── Checkpoints ─────────────────────────────────────────────────────────
    CKPT_LIST:              'fg_ckpt_list',
    CKPT_LOCAL_WARN_OK:     'fg_ckpt_local_warn_ok',

    // ── Skills / roles / tools ───────────────────────────────────────────────
    ACTIVE_SKILLS:      'fg_active_skills',
    BUILTIN_SKILLS:     'fg_builtin_skills',
    BUILTIN_RULES:      'fg_builtin_rules',
    SKILL_TRIGGERS:     'fg_skill_triggers',
    DISABLED_ROLES:     'fg_disabled_roles',
    DISABLED_TOOLS:     'fg_disabled_tools',
    ENABLED_TOOLS:      'fg_enabled_tools',   // legacy; migrated to DISABLED_TOOLS on first load

    // ── API keys ─────────────────────────────────────────────────────────────
    GEMINI_KEY:         'fg_gemini_key',
    OPENAI_KEY:         'fg_openai_key',
    MISTRAL_KEY:        'fg_mistral_key',
    GROQ_KEY:           'fg_groq_key',
    CEREBRAS_KEY:       'fg_cerebras_key',
    NVIDIA_KEY:         'fg_nvidia_key',
    OPENROUTER_KEY:     'fg_openrouter_key',
    TOKENHARBOR_KEY:    'fg_tokenharbor_key',
    BRAVE_KEY:          'fg_brave_key',
    TAVILY_KEY:         'fg_tavily_key',
    HF_KEY:             'fg_hf_key',
    GITHUB_TOKEN:       'fg_github_token',
    STACKEXCHANGE_KEY:  'fg_stackexchange_key',

    // ── Models ────────────────────────────────────────────────────────────────
    PROVIDER:           'fg_provider',
    GEMINI_MODEL:       'fg_gemini_model',
    OPENAI_MODEL:       'fg_openai_model',
    OPENAI_URL:         'fg_openai_url',
    OPENAI_CONTEXT:     'fg_openai_context',
    MISTRAL_MODEL:      'fg_mistral_model',
    NVIDIA_MODEL:       'fg_nvidia_model',
    GROQ_MODEL:         'fg_groq_model',
    CEREBRAS_MODEL:     'fg_cerebras_model',
    OPENROUTER_MODEL:   'fg_openrouter_model',
    MAIN_MODELS:        'fg_main_models',
    PRIMARY_MODELS:     'fg_primary_models',   // profile-level alias; runtime reads MAIN_MODELS
    PAUSED_MAIN:        'fg_paused_main',
    ENABLED_MODELS:     'fg_enabled_models',
    CUSTOM_MODELS:      'fg_custom_models',
    HIDDEN_MODELS:      'fg_hidden_models',  // built-in models the user has removed
    IMAGE_MODEL:        'fg_image_model',
    AUDIO_MODEL:        'fg_audio_model',
    VIDEO_MODEL:        'fg_video_model',
    WORKER_MODEL:       'fg_worker_model',   // model for worker subagent calls; '' = priority list, 'priority' = force #1
    UTILITY_MODEL:      'fg_utility_model',  // single model for title gen, suggestions, tool classify

    // ── Sampling ──────────────────────────────────────────────────────────────
    TEMPERATURE:          'fg_temperature',
    TOP_P:                'fg_top_p',
    TOP_K:                'fg_top_k',
    MIN_P:                'fg_min_p',
    PRESENCE_PENALTY:     'fg_presence_penalty',
    REPETITION_PENALTY:   'fg_repetition_penalty',
    THINKING_LEVEL:       'fg_thinking_level',

    // ── Agent loop ────────────────────────────────────────────────────────────
    AGENT_STEP_BUDGET:                  'fg_agent_step_budget',
    AGENT_MAX_TOOL_RESULT:              'fg_agent_max_tool_result',
    AGENT_TOOL_RESULT_TRUNCATION:       'fg_agent_tool_result_truncation',
    DIRECTOR_MAX_TOOL_RESULT:           'fg_director_max_tool_result',
    AGENT_PROACTIVE_COMPACT:            'fg_agent_proactive_compact',
    AGENT_COMPACT_AT:                   'fg_agent_compact_at',
    AGENT_COMPACT_TOKENS:               'fg_agent_compact_tokens',
    AGENT_PLAN_MODE:                    'fg_agent_plan_mode',
    AGENT_MAX_ROUNDS:                   'fg_agent_max_rounds',
    AGENT_LEAN_WORKERS:                 'fg_agent_lean_workers',
    AGENT_WORKER_HISTORY:               'fg_agent_worker_history',
    AGENT_PROMPT_TEMPLATE:              'fg_agent_prompt_template',
    AGENT_CONCISE_PROMPTS:              'fg_agent_concise_prompts',
    AGENT_WORKER_REDUCE:                'fg_agent_worker_reduce',
    AGENT_ROLE_MODEL_ROUTING:           'fg_agent_role_model_routing',
    ENDPOINT_ROTATION:                  'fg_endpoint_rotation',
    ROTATION_STEP_N:                    'fg_rotation_step_n',
    AGENT_MAX_DELEGATION_DEPTH:         'fg_agent_max_delegation_depth',
    AGENT_LEDGER:                       'fg_agent_ledger',
    AGENT_REVIEW_LOGS:                  'fg_agent_review_logs',
    AGENT_MAX_REPLANS:                  'fg_agent_max_replans',
    INTENT_VALIDATION:                  'fg_intent_validation',
    TOOL_APPROVAL:                      'fg_tool_approval',
    RUNNER_MAX_CONSECUTIVE_FAILS:'fg_agent_loop_max_consecutive_failures',
    RATE_LIMIT_COOLDOWN_MIN:            'fg_rate_limit_cooldown_min',
    RUNNER_QA:                      'fg_agent_loop_qa',
    GIT_ENABLED:                        'fg_git_enabled',
    AST_ENABLED:                        'fg_ast_enabled',
    QA_ENABLED:                         'fg_qa_enabled',
    QA_TEST_RUNNER:                     'fg_qa_test_runner',
    QA_ACCEPTANCE_REVIEW:               'fg_qa_acceptance_review',
    QA_REGRESSION_GUARD:                'fg_qa_regression_guard',
    QA_REWORK_LIMIT:                    'fg_qa_rework_limit',
    SHOW_NUDGES:                        'fg_show_nudges',
    EDIT_REVIEW_ENABLED:                'fg_edit_review_enabled',
    WORKER_THINKING_BUDGET:             'fg_worker_thinking_budget',
    PRESERVE_THINKING:                  'fg_preserve_thinking',

    // ── Voice ─────────────────────────────────────────────────────────────────
    VOICE_STT_LANG:     'fg_voice_stt_lang',
    VOICE_STT_LIST:     'fg_voice_stt_list',
    VOICE_TTS_AUTO:     'fg_voice_tts_auto',
    VOICE_TTS_LIST:     'fg_voice_tts_list',
    VOICE_TTS_PITCH:    'fg_voice_tts_pitch',
    VOICE_TTS_RATE:     'fg_voice_tts_rate',
    VOICE_TTS_VOICE:    'fg_voice_tts_voice',

    // ── Search / sandbox ──────────────────────────────────────────────────────
    SEARCH_PROVIDER:    'fg_search_provider',
    SEARCH_PROXY:       'fg_search_proxy',
    SANDBOX_PROVIDER:   'fg_sandbox_provider',

    // ── Geo cache ─────────────────────────────────────────────────────────────
    GEO_CACHE:          'fg_geo_cache',   // { ip, city, region, country, timezone, org, ts }

    // ── Mode ─────────────────────────────────────────────────────────────────
    MODE:               'fg_mode',   // 'chat' (default) | 'cowork'

    // ── Misc ──────────────────────────────────────────────────────────────────
    PROJECT_NAME:       'fg_project_name',
    PROFILES:           'fg_profiles',
    PYODIDE_AUTOLOAD:   'fg_pyodide_autoload',
    RETRY_MODE:         'fg_retry_mode',
    RETRY_FIXED_MS:     'fg_retry_fixed_ms',

    // Legacy global history keys (pre-multi-chat, migrated on first load)
    LEGACY_GH:          'fg_gh',
    LEGACY_OH:          'fg_oh',
    LEGACY_MSGS:        'fg_msgs',
} as const;

// ── Dynamic key builders (per-chat, per-checkpoint, per-role) ─────────────────

export const chatKey = {
    oh:      (id: string) => `fg_chat_${id}_oh`,
    msgs:    (id: string) => `fg_chat_${id}_msgs`,
    gh:      (id: string) => `fg_chat_${id}_gh`,
    role:    (id: string) => `fg_chat_${id}_role`,
    raw:     (id: string) => `fg_chat_${id}_raw`,
    log:     (id: string) => `fg_chat_${id}_log`,
    runCkpt: (id: string) => `fg_chat_${id}_run_ckpt`,
    all:     (id: string): string[] => [
        `fg_chat_${id}_gh`, `fg_chat_${id}_oh`, `fg_chat_${id}_msgs`,
        `fg_chat_${id}_role`, `fg_chat_${id}_raw`, `fg_chat_${id}_log`,
        `fg_chat_${id}_run_ckpt`,
    ],
} as const;

export const ckptKey         = (id: string) => `fg_ckpt_${id}`;
export const roleBodyKey     = (name: string) => `fg_role_body_${name}`;
// Saved JS source for body_fn roles — stored as the full function string, executed at runtime.
export const roleBodyFnKey   = (name: string) => `fg_role_body_fn_${name}`;
export const voiceApivKey    = (entryKey: string) => `fg_voice_apiv_${entryKey}`;

// sessionStorage keys (page-lifetime only, not persisted across reloads)
export const SESSION_KEYS = {
    CONVO_LOG: 'fg_convo_log',
} as const;
