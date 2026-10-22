import { describe, it, expect, beforeEach } from 'vitest';
import { startGoal, resumeGoal, stopGoal, steerGoal, loadGoal, clearGoal, goalRunning, parseGoal, serializeGoal, parseGoalCommand, describeGoal, isGoalPrompt, _resetGoalForTest, type GoalHost, type GoalTurn, type GoalRecord } from '../goal.ts';

function host(script: Array<GoalTurn | ((prompt: string, kind: string) => GoalTurn | Promise<GoalTurn>)>) {
    const h = {
        file: null as string | null, prompts: [] as Array<[string, string]>, notes: [] as string[], changes: 0,
        runTurn: async (prompt: string, o: { kind: string }) => {
            h.prompts.push([o.kind, prompt]);
            const next = script.shift();
            if (!next) throw new Error('script exhausted');
            return typeof next === 'function' ? next(prompt, o.kind) : next;
        },
        read: async () => h.file, write: async (c: string) => { h.file = c; },
        notify: (m: string) => { h.notes.push(m); }, onChange: () => { h.changes++; },
        sleep: async () => {},
    };
    return h;
}
const work = (text = 'step', edited = true): GoalTurn => ({ text, finishSignal: 'running', edited });
const complete = (text = 'COMPLETED evidence'): GoalTurn => ({ text, finishSignal: 'complete' });

beforeEach(() => _resetGoalForTest());

describe('goal loop', () => {
    it('works until a turn completes, then verifies once, then is done', async () => {
        const h = host([work('a'), work('b'), complete(), complete('verified')]);
        const rec = await startGoal('make the tests pass', h as GoalHost)!;
        expect(rec.status).toBe('done');
        expect(rec.turns).toBe(3);                                   // the verification is not a turn of work
        expect(h.prompts.map(p => p[0])).toEqual(['work', 'work', 'work', 'verify']);
        expect(h.prompts[0][1]).toContain('Goal: make the tests pass');
        expect(h.notes.at(-1)).toMatch(/Goal met after 3 turns/);
        expect(goalRunning()).toBe(false);
        expect(parseGoal(h.file)!.status).toBe('done');
    });
    it('a verification that does not confirm sends the loop back to work', async () => {
        const h = host([complete(), work('missing X'), work('fixed'), complete(), complete()]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('done');
        expect(h.prompts.map(p => p[0])).toEqual(['work', 'verify', 'work', 'work', 'verify']);
        expect(rec.turns).toBe(3);   // three turns of work; the two verifications are not counted
    });
    it('isGoalPrompt recognises every turn the loop sends (the TUI keeps them out of its message history), but not a person\'s own text', async () => {
        const h = host([work('a'), complete(), work('missing'), complete(), complete()]);
        await startGoal('make it pass', h as GoalHost, { maxTurns: 6 })!;
        const kinds = new Set(h.prompts.map(p => p[1].split(':')[0]));
        expect(h.prompts.length).toBeGreaterThanOrEqual(4);
        for (const [, prompt] of h.prompts) expect(isGoalPrompt(prompt)).toBe(true);
        expect(kinds.size).toBeGreaterThanOrEqual(3);                // first/continue/verify shapes all seen
        const h2 = host([complete(), complete()]); h2.file = h.file;
        // a resumed goal's first turn
        const g = parseGoal(h.file)!; g.status = 'paused'; h2.file = serializeGoal(g);
        await (await resumeGoal(h2 as GoalHost))!.done;
        expect(isGoalPrompt(h2.prompts[0][1])).toBe(true);
        expect(isGoalPrompt('Goal: I want to understand the build')).toBe(false);
        expect(isGoalPrompt('You said the goal is complete: yes')).toBe(false);
    });
    it('BLOCKED stops with the question', async () => {
        const h = host([work(), { text: 'Which database should I use?', finishSignal: 'blocked' }]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('blocked');
        expect(rec.note).toContain('Which database');
        expect(h.notes.at(-1)).toMatch(/blocked: Which database/);
    });
    it('the turn cap ends it as out of turns, and resume gives a fresh allowance', async () => {
        const h = host(Array.from({ length: 2 }, (_, i) => work('s' + i)));
        const rec = await startGoal('g', h as GoalHost, { maxTurns: 2 })!;
        expect(rec.status).toBe('cap');
        const h2 = host([complete(), complete()]);
        h2.file = h.file;
        const rec2 = await (await resumeGoal(h2 as GoalHost))!.done;
        expect(rec2.status).toBe('done');
        expect(h2.prompts[0][1]).toContain('Resuming this goal');
        expect(h2.prompts[0][1]).toContain('turn 1: s0');
    });
    it('three turns that change nothing and repeat themselves end as blocked', async () => {
        const h = host([work('same', false), work('same', false), work('same', false), work('same', false)]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('blocked');
        expect(rec.note).toMatch(/changed nothing/);
    });
    it('an edit resets the no-progress count', async () => {
        const h = host([work('same', false), work('same', false), work('same', true), work('same', false), complete(), complete()]);
        expect((await startGoal('g', h as GoalHost)!).status).toBe('done');
    });
    it('errors are retried, and three in a row pause the goal without losing the turn count', async () => {
        const err: GoalTurn = { text: 'network down', finishSignal: 'error' };
        const h = host([err, work('ok'), err, err, err]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('paused');
        expect(rec.note).toContain('3 turns in a row');
        expect(rec.turns).toBe(1);
    });
    it('Stop (a stopped turn) pauses; the record says so', async () => {
        const h = host([{ text: '', finishSignal: 'stopped' }]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('paused');
        expect(h.notes.at(-1)).toMatch(/\/goal resume/);
    });
    it('stopGoal ends the loop after the current turn', async () => {
        const h = host([() => { stopGoal(); return work(); }, work()]);
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('paused');
        expect(h.prompts.length).toBe(1);
    });
    it('a message sent while it runs is in the next prompt', async () => {
        const h = host([() => { steerGoal('use postgres'); return work(); }, complete(), complete()]);
        await startGoal('g', h as GoalHost)!;
        expect(h.prompts[1][1]).toContain('use postgres');
        const h2 = host([() => { steerGoal('check the colours'); return complete(); }, complete()]);
        await startGoal('g', h2 as GoalHost)!;
        expect(h2.prompts[1][0]).toBe('verify');
        expect(h2.prompts[1][1]).toContain('check the colours');   // the verification sees what the user said too
    });
    it('a second start is refused while one runs; start is also refused for empty text', async () => {
        let inner: any;
        const h = host([() => { inner = startGoal('other', h as GoalHost); return complete(); }, complete()]);
        await startGoal('g', h as GoalHost)!;
        expect(inner).toBeNull();
        expect(h.notes.join('\n')).toContain('already running');
        expect(startGoal('   ', h as GoalHost)).toBeNull();
    });
    it('a write that fails (project cleared) stops the loop instead of working on', async () => {
        const h = host([work(), work()]);
        let n = 0;
        h.write = async (c: string) => { if (++n > 2) throw new Error('project replaced'); h.file = c; };
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('paused');
        expect(h.prompts.length).toBeLessThan(3);
    });
});

describe('goal record and commands', () => {
    it('round-trips, including quotes and multi-line goals', () => {
        const g = { text: 'line one\nline "two"', status: 'blocked' as const, turns: 4, maxTurns: 20, note: 'which "db"?', updated: '2026-10-22T10:00:00Z', progress: ['turn 1: a', 'turn 2: b'] };
        expect(parseGoal(serializeGoal(g))).toEqual(g);
    });
    it('garbage and empty files are no goal', () => {
        expect(parseGoal('')).toBeNull(); expect(parseGoal('hello')).toBeNull(); expect(parseGoal('---\nstatus: active\n---\n')).toBeNull();
    });
    it('a goal found active is shown as paused (it never restarts by itself)', async () => {
        const h = host([]);
        h.file = serializeGoal({ text: 'g', status: 'active', turns: 2, maxTurns: 20, note: '', updated: '', progress: [] });
        expect((await loadGoal(h as GoalHost))!.status).toBe('paused');
    });
    it('resume with nothing stored, or a met goal, says so and starts nothing', async () => {
        const h = host([]);
        expect(await resumeGoal(h as GoalHost)).toBeNull();
        expect(h.notes.at(-1)).toMatch(/No goal to resume/);
        h.file = serializeGoal({ text: 'g', status: 'done', turns: 1, maxTurns: 20, note: '', updated: '', progress: [] });
        expect(await resumeGoal(h as GoalHost)).toBeNull();
        expect(h.notes.at(-1)).toMatch(/already met/);
    });
    it('clear empties the record', async () => {
        const h = host([]); h.file = 'x';
        expect(await clearGoal(h as GoalHost)).toBe(true);
        expect(h.file).toBe('');
        expect(await loadGoal(h as GoalHost)).toBeNull();
    });
    it('parses the command: a sub-command is the whole argument', () => {
        expect(parseGoalCommand('')).toEqual({ op: 'status', text: '' });
        expect(parseGoalCommand('resume')).toEqual({ op: 'resume', text: '' });
        expect(parseGoalCommand('Stop')).toEqual({ op: 'stop', text: '' });
        expect(parseGoalCommand('stop the server and migrate')).toEqual({ op: 'start', text: 'stop the server and migrate' });
        expect(parseGoalCommand('ship the release')).toEqual({ op: 'start', text: 'ship the release' });
    });
    it('describes each state', () => {
        expect(describeGoal(null)).toMatch(/No goal set/);
        expect(describeGoal(parseGoal(serializeGoal({ text: 'g', status: 'blocked', turns: 1, maxTurns: 20, note: 'which db?', updated: '', progress: ['turn 1: x'] })))).toMatch(/Waiting for you: which db\?/);
    });
});

describe('codex review of the goal loop (R1-001..004) and opencode G3/G8/G10', () => {
    it('an empty progress list survives a round trip, and so does a goal whose own text has a "## Progress" heading', () => {
        const base = { status: 'paused' as const, turns: 0, maxTurns: 20, note: '', updated: 'now' };
        for (const text of ['ship the report', 'alpha\n\n## Progress\nnot really progress\nomega', 'ends with a heading\n\n## Progress']) {
            for (const progress of [[], ['turn 1: did a thing']]) {
                const rec = { ...base, text, progress };
                let cur = parseGoal(serializeGoal(rec))!;
                expect(cur).toMatchObject({ text, progress });
                cur = parseGoal(serializeGoal(cur))!; cur = parseGoal(serializeGoal(cur))!;          // repeated cycles change nothing
                expect(cur).toMatchObject({ text, progress });
            }
        }
    });
    it('finishing on the last allowed work turn still gets its verification', async () => {
        const h = host([complete(), complete('verified')]);
        const rec = await startGoal('g', h as GoalHost, { maxTurns: 1 })!;
        expect(rec.status).toBe('done');
        expect(h.prompts.map(p => p[0])).toEqual(['work', 'verify']);
    });
    it('a verification that finds something missing on the last turn ends as out of turns, not as an endless loop', async () => {
        const h = host([complete(), work('missing X')]);
        const rec = await startGoal('g', h as GoalHost, { maxTurns: 1 })!;
        expect(rec.status).toBe('cap');
        expect(h.prompts.map(p => p[0])).toEqual(['work', 'verify']);
    });
    it('a note sent while the verification runs is not lost: the goal is not done on an answer that predates it', async () => {
        const h = host([complete(), complete('verified'), complete(), complete('verified again')]);
        const orig = h.runTurn;
        let n = 0;
        h.runTurn = async (p: string, o: any) => { if (++n === 2) steerGoal('ACCEPTED_STEER_verify'); return orig(p, o); };
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('done');
        expect(h.prompts.some(p => p[1].includes('ACCEPTED_STEER_verify'))).toBe(true);
        expect(h.prompts.map(p => p[0])).toEqual(['work', 'verify', 'work', 'verify']);
    });
    it('a note accepted before the first prompt is in that prompt', async () => {
        const h = host([complete(), complete()]);
        h.waitQuiet = async () => { steerGoal('ACCEPTED_STEER_initial'); return true; };
        await startGoal('g', h as GoalHost)!;
        expect(h.prompts[0][1]).toContain('ACCEPTED_STEER_initial');
    });
    it('a note the loop ends before delivering is kept in the record and goes into the prompt after /goal resume', async () => {
        const h = host([work('a'), { text: 'Which database?', finishSignal: 'blocked' }]);
        const orig = h.runTurn; let n = 0;
        h.runTurn = async (p: string, o: any) => { if (++n === 2) steerGoal('use postgres'); return orig(p, o); };
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('blocked');
        expect(h.notes.at(-1)).toMatch(/note was kept/);
        expect(parseGoal(h.file)!.steer).toEqual(['use postgres']);
        const h2 = host([complete(), complete()]); h2.file = h.file;
        await (await resumeGoal(h2 as GoalHost))!.done;
        expect(h2.prompts[0][1]).toContain('use postgres');
        expect(parseGoal(h2.file)!.steer).toBeUndefined();
    });
    it('Clear removes the record; a failing store is reported and the goal stays', async () => {
        const h: any = host([complete(), complete()]);
        await startGoal('g', h as GoalHost)!;
        let removed = 0; h.remove = async () => { removed++; h.file = null; };
        expect(await clearGoal(h)).toBe(true);
        expect(removed).toBe(1); expect(h.file).toBeNull();
        const h2: any = host([complete(), complete()]); await startGoal('g', h2 as GoalHost)!;
        h2.write = async () => { throw new Error('quota'); };
        const seen: Array<GoalRecord | null> = []; h2.onChange = (g: any) => seen.push(g);
        expect(await clearGoal(h2)).toBe(false);
        expect(h2.notes.at(-1)).toMatch(/could not be cleared.*quota/);
        expect(seen).toEqual([]);                                     // the view still shows the goal
        expect(parseGoal(h2.file)).not.toBeNull();
    });
    it('a damaged record cannot change how many turns are allowed', () => {
        const rec = parseGoal('---\nstatus: paused\nturns: -5\nmax_turns: abc\nupdated: x\nnote: ""\n---\n# Goal\ng\n\n## Progress\n')!;
        expect(rec.turns).toBe(0); expect(rec.maxTurns).toBe(20);
        expect(parseGoal('---\nstatus: paused\nturns: 2.7\nmax_turns: 0.4\nupdated: x\nnote: ""\n---\n# Goal\ng\n\n## Progress\n')).toMatchObject({ turns: 2, maxTurns: 20 });
    });
    it('a host that throws while waiting does not take the loop with it', async () => {
        const h = host([complete(), complete()]);
        h.waitQuiet = async () => { throw new Error('host bug'); };
        const rec = await startGoal('g', h as GoalHost)!;
        expect(rec.status).toBe('paused');
    });
});
