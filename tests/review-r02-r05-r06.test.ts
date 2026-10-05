// Regression tests for the codex v0.61 commit-review findings R02, R05 and R06.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('R02: runner task label is text, not HTML', () => {
    it('does not create elements from a task title', async () => {
        document.body.innerHTML = '<div id="runner-current-task"></div>';
        const runner: any = await import('../runner.ts');
        runner._setRunnerChatIdForTest('chat-1');
        runner._updateRunnerCurrentTask({ path: 'tasks/001-x.md', fm: { id: '1', title: '<img src=x onerror="window.__pwn=1">' } });
        const el = document.getElementById('runner-current-task')!;
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img src=x');
    });
});

describe('R05: an expired negative tool format is renewed', () => {
    beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });
    it('re-learns none after the TTL', async () => {
        const { recordToolFormat, getModelToolFormat } = await import('../model-caps.ts');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01'));
        recordToolFormat('p', 'm', 'none');
        expect(getModelToolFormat('p', 'm')).toBe('none');
        vi.setSystemTime(new Date('2026-01-09'));
        expect(getModelToolFormat('p', 'm')).toBe('openai');   // expired
        recordToolFormat('p', 'm', 'none');
        expect(getModelToolFormat('p', 'm')).toBe('none');     // renewed
        vi.useRealTimers();
    });
});

describe('R06: history secret scan under pipefail', () => {
    it('finds a secret early in a large commit', () => {
        const dir = mkdtempSync(join(tmpdir(), 'r06-'));
        const sh = (c: string) => execFileSync('bash', ['-c', c], { cwd: dir, encoding: 'utf8' });
        sh('git init -q && git config user.email a@b && git config user.name t && git commit -q --allow-empty -m base');
        const secret = 'ghp_' + 'A'.repeat(36);
        writeFileSync(join(dir, 'big.txt'), secret + '\n' + 'filler line\n'.repeat(200000));
        sh('git add . && git commit -q -m big');
        // The exact scan lines from deploy.sh, run under its shell options.
        const src = readFileSync(join(__dirname, '..', 'deploy.sh'), 'utf8');
        const m = src.match(/_hits=\$\(git show[\s\S]*?\|\| true\)\n\s*if \[ "\$\{_hits:-0\}" -gt 0 \]/);
        expect(m).not.toBeNull();
        const out = sh(`set -euo pipefail; SECRET_RE='ghp_[A-Za-z0-9]{36,}'; _hash=$(git rev-parse HEAD); ${m![0]}; then echo FOUND; else echo MISSED; fi`);
        expect(out.trim()).toBe('FOUND');
    });
});

describe('R07: chat switching while autopilot holds the job', () => {
    const W: any = globalThis;
    beforeAll(async () => { await import('../chat-state.ts'); });
    afterEach(() => { W.setAiJob(''); });
    it('refuses a user switch to another chat, allows the owning loop', async () => {
        W.agentStreaming = false;
        W.activeChatId = 'task-chat';
        W.setAiJob('autopilot');
        await W.switchToChat('other-chat');
        expect(W.activeChatId).toBe('task-chat');
        await W.switchToChat('task-chat-2', { internal: true }).catch(() => {});
        expect(W.activeChatId).toBe('task-chat-2');
    });
    it('switches normally when no job is running', async () => {
        W.agentStreaming = false;
        W.activeChatId = 'a';
        await W.switchToChat('b').catch(() => {});
        expect(W.activeChatId).toBe('b');
    });
});
