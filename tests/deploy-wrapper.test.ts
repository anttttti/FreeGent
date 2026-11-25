import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('deploy.sh wrapper', () => {
    it('finds its own directory when CDPATH is set: cd printed the directory itself and the path came out twice (Codex review of 9a6bedd)', () => {
        const src = readFileSync('deploy.sh', 'utf8');
        const root = mkdtempSync(join(tmpdir(), 'fg-deploy-')), repo = join(root, 'FreeGent');
        mkdirSync(join(repo, 'bench'), { recursive: true });
        writeFileSync(join(repo, 'deploy.sh'), src.replace(/^exec .*$/m, 'echo "$here"'));
        writeFileSync(join(repo, 'bench', 'deploy.sh'), '#!/usr/bin/env bash\n'); chmodSync(join(repo, 'bench', 'deploy.sh'), 0o755);
        const out = execFileSync('bash', ['FreeGent/deploy.sh'], { cwd: root, env: { ...process.env, CDPATH: '.' }, encoding: 'utf8' }).trim();
        expect(out).toBe(repo);
    });
});
