import { describe, it, expect } from 'vitest';
import { destructiveGitReason, taskChangesData } from '../detectors.ts';

const asked = 'Turn this folder into a repo, commit feature.txt and leave the working tree clean.';

describe('destructiveGitReason', () => {
    it.each([
        'git clean -fd',
        'git clean -fdx',
        'git clean --force -d',
        'cd repo && git checkout main && git clean -fd',
        'git reset --hard HEAD~1',
        'git reset --hard',
        'git checkout .',
        'git checkout -- .',
        'git restore .',
        'git checkout -f main',
        'git switch --discard-changes main',
        'git -C sub clean -f',
        'sudo git clean -ffdx',
        'echo start\ngit add -A\ngit reset --hard origin/main',
    ])('blocks %j when the request did not ask for it', (code) => {
        expect(destructiveGitReason(code, asked)).toMatch(/cannot restore/);
    });

    it.each([
        'git status',
        'git clean -n',
        'git clean -nd',
        'git clean --dry-run -d',
        'git reset --soft HEAD~1',
        'git reset HEAD file.txt',
        'git checkout -b feature/x',
        'git checkout main',
        'git restore --staged file.txt',
        'git commit -m "reset --hard is dangerous"',
        'echo git clean -fd',
        'python3 -c "print(1)"',
        'ls -la',
    ])('allows %j', (code) => {
        expect(destructiveGitReason(code, asked)).toBeNull();
    });

    it('allows the commands when the user names the operation or says to discard', () => {
        expect(destructiveGitReason('git clean -fd', 'run git clean -fd to remove the build output')).toBeNull();
        expect(destructiveGitReason('git reset --hard HEAD', 'discard my local changes')).toBeNull();
        expect(destructiveGitReason('git reset --hard HEAD', 'please do a hard reset')).toBeNull();
        expect(destructiveGitReason('git checkout .', 'throw away everything uncommitted')).toBeNull();
    });

    it('does not read "leave the tree clean" as permission', () => {
        expect(destructiveGitReason('git clean -fd', 'make sure the working tree is clean afterwards')).not.toBeNull();
    });
});

describe('destructiveGitReason: forms and operations the first version missed (hermes N2; codex Review657-747)', () => {
    it.each([
        'git checkout ./',                         // hermes N2: same as `git checkout .`
        "git checkout '*'",                        // quoted pathspec: the shell strips the quotes
        'git restore -- "."',
        "bash -c 'git clean -fd'",                 // Review695/657: wrapped in a shell
        'if true; then git clean -fd; fi',         // Review695: shell keywords
        '(cd repo && git reset --hard)',           // subshell
        'out=$(git stash clear)',
        'git stash drop',                          // Review742
        'git stash clear',
        'git rm -f notes.txt',                     // Review743
        'git rm -rf src',
        'git branch -D feature',                   // Review744
        'git branch -d -f feature',
        'git push --force origin main',            // Review747
        'git push origin +main',
        'git push origin :old-branch',
        'git push --delete origin old',
    ])('blocks %j when the request did not ask for it', (code) => {
        expect(destructiveGitReason(code, asked)).toMatch(/cannot restore|may not keep/);
    });

    it.each([
        'git stash', 'git stash pop', 'git stash list', 'git rm --cached secret.env', 'git rm -n -r build', 'git rm old.txt',
        'git branch -d merged', 'git branch feature', 'git push origin main', 'git push -u origin feature',
        'git checkout -- src/app.ts', 'git restore --staged .', 'echo "run bash -c later"',
    ])('allows %j', (code) => {
        expect(destructiveGitReason(code, asked)).toBeNull();
    });

    it('a negated, explained or dry-run mention in the request is not permission (Review657/667/694)', () => {
        expect(destructiveGitReason('git clean -fd', 'Inspect the suggestion, but do not run `git clean -fd`; preserve all untracked work')).not.toBeNull();
        expect(destructiveGitReason('git clean -fd', 'Explain what `git clean -fd` would do.')).not.toBeNull();
        expect(destructiveGitReason('git reset --hard', 'Never discard my local changes.')).not.toBeNull();
        expect(destructiveGitReason('git clean -fd', 'Run `git clean -nfd` to show what would be removed; delete nothing.')).not.toBeNull();
        expect(destructiveGitReason('git clean -fd', 'Fix the build. Then run git clean -fd to remove the output.')).toBeNull();
    });

    it('permission for one operation does not cover another (Review671)', () => {
        const cleanOnly = 'run git clean -fd to remove the build output';
        expect(destructiveGitReason('git clean -fd', cleanOnly)).toBeNull();
        expect(destructiveGitReason('git reset --hard', cleanOnly)).not.toBeNull();
        expect(destructiveGitReason('git checkout -- .', cleanOnly)).not.toBeNull();
        expect(destructiveGitReason('git branch -D old', 'delete the old branch')).toBeNull();
        expect(destructiveGitReason('git push --force', 'force-push my rebased branch')).toBeNull();
        expect(destructiveGitReason('git stash clear', 'clear all stashes')).toBeNull();
    });

    it('finds git calls in Python and JavaScript programs (Review657)', () => {
        expect(destructiveGitReason("import subprocess\nsubprocess.run(['git', 'clean', '-fd'])", asked, false)).not.toBeNull();
        expect(destructiveGitReason('import os\nos.system("git reset --hard")', asked, false)).not.toBeNull();
        expect(destructiveGitReason("execSync('git push --force')", asked, false)).not.toBeNull();
        expect(destructiveGitReason("subprocess.run(['git', 'status'])", asked, false)).toBeNull();
        expect(destructiveGitReason('print("git clean -n")', asked, false)).toBeNull();
    });
});

describe('run_git is screened as the argv it runs (Review669/670/703/704)', () => {
    it('every accepted field and form gives the same argv', async () => {
        const { runGitArgv } = await import('../tools.ts');
        for (const a of [{ args: ['clean', '-fd'] }, { args: 'clean -fd' }, { args: 'git clean -fd' }, { args: ['git', 'clean', '-fd'] },
                         { command: 'git clean -fd' }, { cmd: 'clean -fd' }, { arguments: ['clean', '-fd'] }])
            expect(runGitArgv(a), JSON.stringify(a)).toEqual(['clean', '-fd']);
        expect(runGitArgv({})).toEqual([]);
    });
    it('executeToolAsync refuses run_git({arguments: [clean, -fd]}) and the doubled "git" prefix', async () => {
        const { executeToolAsync, setCurrentUserIntent } = await import('../tools.ts') as any;
        setCurrentUserIntent?.(asked);
        for (const a of [{ arguments: ['clean', '-fd'] }, { args: 'git clean -fd' }, { args: ['git', 'clean', '-fd'] }]) {
            const r = await executeToolAsync('run_git', a);
            expect(String(r?.error ?? r?.blocked ?? JSON.stringify(r)), JSON.stringify(a)).toMatch(/cannot restore/);
        }
    });
});

describe('taskChangesData', () => {
    it('is true for requests that change the supplied data', () => {
        expect(taskChangesData("`python3 app.py` crashes with a ValueError. Fix whatever is actually wrong so it prints total=60.")).toBe(true);
        expect(taskChangesData('Clean up the duplicate rows in contacts.csv.')).toBe(true);
        expect(taskChangesData('Convert scores.csv to Markdown.')).toBe(true);
    });
    it('is false for questions about the data', () => {
        expect(taskChangesData('How many lines in all the log files under /var/log/app contain the word error?')).toBe(false);
        expect(taskChangesData('Count the unique characters in `logfile.txt`. The result must be an integer.')).toBe(false);
    });
});
