// secret-env.ts — FreeGent: strip credentials from environments handed to agent-run commands.
//
// The dev server and the headless runner load API keys into process.env. Commands the agent runs
// (execute_code on the host) inherit the environment, so without this a single `env` prints every
// key. Imported by dev-api.ts and headless-runner.ts; no Node or DOM dependencies.
//
// This removes keys from the environment only. A command running on the host as the user can
// still read files the user can read, including ~/.config/freegent/credentials — host execution
// needs approval (see getToolApproval in config.ts) or real isolation (a container).

// Matches whole underscore-separated segments, case-insensitively: GEMINI_API_KEY, GITHUB_TOKEN,
// CLOUDFLARE_API_TOKEN, AWS_ACCESS_KEY_ID, DB_PASSWORD — but not TOKENIZERS_PARALLELISM.
const _SECRET_NAME_RE = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;

export function isSecretEnvName(name: string): boolean {
    return _SECRET_NAME_RE.test(name);
}

// FG_EXEC_KEEP_ENV=HF_TOKEN,GH_TOKEN passes the named variables through anyway, for tasks that
// genuinely need one (and whose runs you trust with it).
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
    const keep = new Set((env.FG_EXEC_KEEP_ENV ?? '').split(',').map(s => s.trim()).filter(Boolean));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined || (isSecretEnvName(k) && !keep.has(k))) continue;
        out[k] = v;
    }
    return out;
}
