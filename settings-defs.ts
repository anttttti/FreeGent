// settings-defs.ts — FreeGent: the settings a profile carries, one row each, with what the other places used to repeat.
//
// A setting was declared in up to seven places (the getter's range table in config.ts, the WebUI input's min/max in index.html, the TUI panel
// in panel-defs.ts, the profile key list and its label in profiles.ts, ...) and they drifted: fg_top_k had three different ranges. The label,
// section and accepted range of a setting are written here once: profiles.ts reads the label and the order, config.ts validates a value against
// the range, panel-defs.ts and the WebUI Settings inputs take their min / max / step from it. (The default and the getter stay with the code that uses them.)
//
// Pure data, no imports. Row order is the order of the profile diff.

export interface SettingDef {
    label: string;
    section: 'Models' | 'Search' | 'Code' | 'Agent' | 'Skills';
    /** The value is a JSON array (skills, rules): a profile that carries anything else is refused. */
    list?: true;
    /** Accepted range of a numeric setting; outside it a value is refused, or left out of a request. */
    min?: number; max?: number; step?: number; int?: true;
}

// Settings captured in a profile: everything except API credentials (keys are never captured).
export const SETTINGS: Record<string, SettingDef> = {
    fg_openai_url: { label: 'OpenAI-compat URL', section: 'Models' },
    fg_openai_context: { label: 'OpenAI-compat context', section: 'Models' },
    fg_search_provider: { label: 'Search provider', section: 'Search' },
    fg_sandbox_provider: { label: 'Sandbox provider', section: 'Code' },
    fg_agent_tool_result_truncation: { label: 'Tool result truncation', section: 'Agent' },
    fg_agent_max_tool_result: { label: 'Max result size — workers (chars)', section: 'Agent' },
    fg_agent_proactive_compact: { label: 'Proactive compaction', section: 'Agent' },
    fg_agent_compact_at: { label: 'Compact at (%)', section: 'Agent' },
    fg_agent_compact_tokens: { label: 'Compact at (tokens)', section: 'Agent' },
    fg_agent_max_rounds: { label: 'Max steps / turn', section: 'Agent', min: 1, max: 500, step: 1, int: true },
    fg_rate_limit_cooldown_min: { label: 'Rate-limit cooldown', section: 'Models' },
    fg_agent_lean_workers: { label: 'Lean worker context', section: 'Agent' },
    fg_agent_worker_history: { label: 'Director workers fork the full context', section: 'Agent' },
    fg_active_skills: { label: 'Always-on skills/rules', section: 'Skills', list: true },
    fg_builtin_skills: { label: 'Built-in skills', section: 'Skills', list: true },
    fg_builtin_rules: { label: 'Built-in rules', section: 'Skills', list: true },
    fg_skill_triggers: { label: 'Skill/rule overrides', section: 'Skills' },
    fg_agent_prompt_template: { label: 'Prompt template', section: 'Agent' },
    fg_agent_concise_prompts: { label: 'Concise prompts', section: 'Agent' },
    fg_agent_worker_reduce: { label: 'Worker output reduce', section: 'Agent' },
    fg_agent_role_model_routing: { label: 'Role model routing', section: 'Agent' },
    fg_endpoint_rotation: { label: 'Endpoint rotation', section: 'Models' },
    fg_single_request_per_endpoint: { label: 'One request per endpoint', section: 'Models' },
    fg_worker_thinking_budget: { label: 'Worker thinking budget', section: 'Agent' },
    fg_preserve_thinking: { label: 'Preserve thinking (vLLM)', section: 'Agent' },
    fg_agent_max_delegation_depth: { label: 'Max delegation depth', section: 'Agent' },
    fg_qa_enabled: { label: 'QA gates enabled', section: 'Agent' },
    fg_qa_acceptance_review: { label: 'Acceptance review', section: 'Agent' },
    fg_qa_test_runner: { label: 'QA test runner', section: 'Agent' },
    fg_qa_regression_guard: { label: 'Regression guard', section: 'Agent' },
    fg_qa_rework_limit: { label: 'QA rework limit', section: 'Agent' },
    fg_agent_loop_qa: { label: 'Runner QA gates', section: 'Agent' },
    fg_agent_loop_max_consecutive_failures: { label: 'Runner failure limit', section: 'Agent' },
    fg_agent_ledger: { label: 'Task/Progress Ledger', section: 'Agent' },
    fg_agent_review_logs: { label: 'Review message logs', section: 'Agent' },
    fg_intent_validation: { label: 'Intent validation', section: 'Agent' },
    fg_director_max_tool_result: { label: 'Max result size — main agent (chars)', section: 'Agent' },
    fg_tool_approval: { label: 'Tool approval', section: 'Agent' },
    fg_git_enabled: { label: 'Git access', section: 'Code' },
    fg_ast_enabled: { label: 'AST code queries', section: 'Code' },
    fg_temperature: { label: 'Temperature', section: 'Models', min: 0, max: 2, step: 0.05 },
    fg_top_p: { label: 'Top P', section: 'Models', min: 0, max: 1, step: 0.05 },
    fg_top_k: { label: 'Top K', section: 'Models', min: -1, max: 1_000_000, step: 1, int: true },
    fg_min_p: { label: 'Min P', section: 'Models', min: 0, max: 1, step: 0.01 },
    fg_presence_penalty: { label: 'Presence penalty', section: 'Models', min: -2, max: 2, step: 0.1 },
    fg_repetition_penalty: { label: 'Repetition penalty', section: 'Models', min: 0, max: 2, step: 0.05 },
};

/** The label of a setting, as the Settings panel, the profile diff and the TUI show it. */
export const labelOf = (key: string): string => SETTINGS[key]?.label ?? key;

/** min / max / step of a numeric setting, for an input or a panel field. */
export function rangeOf(key: string): { min?: number; max?: number; step?: number } {
    const { min, max, step } = SETTINGS[key] ?? {};
    return { min, max, step };
}
