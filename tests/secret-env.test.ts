// hermes C4: the database password variables reached an agent's command through `env`.
import { describe, it, expect } from 'vitest';
import { scrubEnv } from '../secret-env.ts';

describe('scrubEnv', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/u', PWD: '/work', OLDPWD: '/tmp', TOKENIZERS_PARALLELISM: 'false', LANG: 'C' };
    it('removes the usual secret names, the database password variables and URL-embedded passwords', () => {
        const env = scrubEnv({ ...base, OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', PGPASSWORD: 'pg', MYSQL_PWD: 'my',
            REDISCLI_AUTH: 'r', AWS_SECRET_ACCESS_KEY: 'a', SSH_PASSPHRASE: 's', DEPLOY_PWD: 'd', GCP_PRIVATE_KEY: 'x',
            DATABASE_URL: 'postgres://user:dbpass@host/db' });
        expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'OLDPWD', 'PATH', 'PWD', 'TOKENIZERS_PARALLELISM']);
    });
    it('keeps what is not a secret: the working directory every shell exports, and look-alikes', () => {
        const env = scrubEnv({ ...base, PWDX: 'x', SPASS: 'y', KEYBOARD: 'us', MONKEY_PATCH: '1' });
        expect(Object.keys(env)).toEqual(expect.arrayContaining(['PWD', 'OLDPWD', 'PWDX', 'SPASS', 'KEYBOARD', 'MONKEY_PATCH']));
    });
    it('FG_EXEC_KEEP_ENV still passes a named variable through', () => {
        expect(scrubEnv({ ...base, PGPASSWORD: 'pg', FG_EXEC_KEEP_ENV: 'PGPASSWORD' }).PGPASSWORD).toBe('pg');
    });
});
