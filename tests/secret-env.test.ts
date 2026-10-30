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
    // codex R143/R144: credential formats whose name holds no secret word reached native commands and /api/execute.
    it('removes Docker registry auth and Bundler host credentials, keeps Bundler settings', () => {
        const env = scrubEnv({ ...base, DOCKER_AUTH_CONFIG: '{"auths":{"r.example":{"auth":"dTpw"}}}', BUNDLE_GEMS__EXAMPLE__COM: 'user:secret',
            BUNDLE_BUILD__NOKOGIRI: '--use-system-libraries', BUNDLE_PATH: 'vendor/bundle', GIT_AUTHOR_NAME: 'A' });
        expect(Object.keys(env)).toEqual(expect.arrayContaining(['BUNDLE_BUILD__NOKOGIRI', 'BUNDLE_PATH', 'GIT_AUTHOR_NAME']));
        expect(env.DOCKER_AUTH_CONFIG).toBeUndefined();
        expect(env.BUNDLE_GEMS__EXAMPLE__COM).toBeUndefined();
    });
    it('FG_EXEC_KEEP_ENV still passes a named variable through', () => {
        expect(scrubEnv({ ...base, PGPASSWORD: 'pg', FG_EXEC_KEEP_ENV: 'PGPASSWORD' }).PGPASSWORD).toBe('pg');
    });
});
