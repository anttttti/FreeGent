// secret-env.ts — FreeGent: strip credentials from environments handed to agent-run commands.
//
// The dev server and the headless runner load API keys into process.env. Commands the agent runs
// (execute_code on the host) inherit the environment, so without this a single `env` prints every
// key. Imported by dev-api.ts and native-exec.ts; no Node or DOM dependencies.
//
// This removes keys from the environment only. A command running on the host as the user can
// still read files the user can read, including ~/.config/freegent/credentials — host execution
// needs approval (see getToolApproval in config.ts) or real isolation (a container).

// Matches whole underscore-separated segments, case-insensitively: GEMINI_API_KEY, GITHUB_TOKEN,
// CLOUDFLARE_API_TOKEN, AWS_ACCESS_KEY_ID, DB_PASSWORD — but not TOKENIZERS_PARALLELISM.
const _SECRET_NAME_RE = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;

// Names with no separator, or a segment of their own: the standard database password variables (PGPASSWORD, MYSQL_PWD; set so a password stays off
// the command line), the cloud SDKs' secrets, and *_PWD / *_PASS / *_PASSPHRASE. A bare PWD is the working directory every shell exports, not a secret
// (hermes C4).
const _SECRET_EXTRA_RE = /^(PGPASSWORD|PGPASSFILE|PGSSLKEY|MYSQL_PWD|REDISCLI_AUTH|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|NPM_CONFIG__AUTH)$|(^|_)(PWD|PASS|PASSPHRASE|PRIVATE_?KEY|AUTH_?TOKEN)$/i;
function isSecretEnvName(name: string): boolean {
    if (name.toUpperCase() === 'PWD' || name.toUpperCase() === 'OLDPWD') return false;
    return _SECRET_NAME_RE.test(name) || _SECRET_EXTRA_RE.test(name);
}

// FG_EXEC_KEEP_ENV=HF_TOKEN,GH_TOKEN passes the named variables through anyway, for tasks that
// genuinely need one (and whose runs you trust with it).
// A value that carries a password in a URL: scheme://user:password@host (DATABASE_URL, REDIS_URL,
// a DSN). The name says nothing, so these passed the name filter with their passwords.
// The user name may be empty (redis://:password@host).
const _URL_CREDENTIAL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@/i;
export function hasUrlCredential(value: string): boolean {
    return _URL_CREDENTIAL_RE.test(value);
}

export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
    const keep = new Set((env.FG_EXEC_KEEP_ENV ?? '').split(',').map(s => s.trim()).filter(Boolean));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined || ((isSecretEnvName(k) || hasUrlCredential(v)) && !keep.has(k))) continue;
        out[k] = v;
    }
    return out;
}
