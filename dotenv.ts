// dotenv.ts — FreeGent: .env / credentials loader for Node entry points (dev server, headless, CLI).
// Never imported by browser code.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Reads KEY=VALUE pairs and sets any key not already in process.env, so the shell always wins.
export function parseDotenvFile(envPath: string): void {
    try {
        if (!existsSync(envPath)) return;
        for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) continue;
            const idx = t.indexOf('=');
            const key = t.slice(0, idx).trim();
            let val = t.slice(idx + 1).trim();
            if (val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'"))
                val = val.slice(1, -1);
            if (key && !(key in process.env)) process.env[key] = val;
        }
    } catch { /* unreadable — silent */ }
}

export function configDir(): string {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'freegent');
}

// Precedence: shell env, then <cwd>/.env, then ~/.config/freegent/credentials.
export function loadDotenv(): void {
    parseDotenvFile(join(process.cwd(), '.env'));
    parseDotenvFile(join(configDir(), 'credentials'));
}

// Provider/key detection is shared with the TUI so an explicit provider cannot inherit
// another provider's first available key. The caller resolves CLI/env precedence.
const _PROVIDER_ENV_MAP: Array<[string, string]> = [
    ['OPENAI_API_KEY',     'openai'],
    ['GEMINI_API_KEY',     'google'],
    ['GOOGLE_API_KEY',     'google'],
    ['ANTHROPIC_API_KEY',  'anthropic'],
    ['GROQ_API_KEY',       'groq'],
    ['OPENROUTER_API_KEY', 'openrouter'],
    ['NVIDIA_API_KEY',     'nvidia'],
    ['NOUSPORTAL_API_KEY', 'nous'],
    ['NOUS_API_KEY',       'nous'],   // alias
    ['KILO_API_KEY',       'kilo'],
    ['VERCEL_API_KEY',     'vercel'],
    ['TOKENHARBOR_API_KEY','tokenharbor'],
    ['MOONMATH_API_KEY',   'moonmath'],
    ['REQUESTY_API_KEY',   'requesty'],
];

export function detectProviderEnv(env: Record<string, string | undefined>, requestedProvider = ''): { provider: string; apiKey: string } | null {
    for (const [name, provider] of _PROVIDER_ENV_MAP) {
        if (requestedProvider && provider !== requestedProvider) continue;
        if (env[name]) return { provider, apiKey: env[name]! };
    }
    return null;
}
