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
