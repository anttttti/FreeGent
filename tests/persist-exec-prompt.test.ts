// persistent_exec (experiment): the system prompt, the bash and python guidance and the execute_code description all say
// the same thing — persistent environments under the experiment, fresh calls without it.
import '../skills.ts';

const W = globalThis as any;

const rule = (name: string) => W.BUILTIN_RULES.find((r: any) => r.name === name).body_fn() as string;
const execDesc = () => W.activeTools(false, new Set(['execute_code']), true).map((t: any) => t.function ?? t).find((t: any) => t.name === 'execute_code').description as string;

describe('persistent_exec wording', () => {
    let saved: any;
    beforeEach(() => { saved = { exec: W.nativeExec, env: process.env.FG_EXPERIMENTS }; W.nativeExec = () => {}; });
    afterEach(() => {
        W.nativeExec = saved.exec;
        if (saved.env === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = saved.env;
    });

    it('calls python and bash persistent environments everywhere, with no fresh-shell rule left', () => {
        process.env.FG_EXPERIMENTS = 'persistent_exec';
        expect(W._buildLangsDesc()).toMatch(/\*\*python\*\* \(persistent environment; python3, pip3\), \*\*bash\*\* \(persistent environment; shell \+ npm\)/);
        expect(W._buildLangsDesc()).toMatch(/instead of re-importing, reloading or repeating them/);
        const bash = rule('bash');
        expect(bash).toMatch(/### Environment \(native bash process, persistent environment\)/);
        expect(bash).not.toMatch(/fresh shell|reset between calls|~\/\.bashrc/);
        expect(rule('python')).toMatch(/### Environment \(native python3 process, persistent environment\)/);
        expect(execDesc()).toMatch(/Bash and Python each run in a persistent environment/);
    });

    it('keeps the fresh-call wording without the experiment', () => {
        delete process.env.FG_EXPERIMENTS;
        expect(W._buildLangsDesc()).not.toMatch(/persistent/);
        expect(rule('bash')).toMatch(/each execute_code call runs in a fresh shell/);
        expect(rule('bash')).toMatch(/shell state reset between calls/);
        expect(rule('python')).not.toMatch(/persistent/);
        expect(execDesc()).toMatch(/Each call starts fresh in the workspace/);
    });
});
