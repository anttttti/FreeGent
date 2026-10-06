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
