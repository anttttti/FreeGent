// goal.ts — FreeGent: /goal, a standing objective the agent keeps working on, turn after turn, until it is met.
//
// One module for the WebUI and the TUI. It owns the loop and the goal record and knows nothing about either screen: the front end
// hands in a GoalHost (run one turn, read/write the record, show a line) and the loop does the rest:
//
//     /goal <text>      start (replaces a finished or stopped goal; refuses while another is running)
//     /goal resume      continue the stored goal from where it stopped (also after a reload or a restart)
//     /goal             show it                /goal stop     stop after the current turn        /goal clear   forget it
//
// Why not Autopilot (runner.ts)? Autopilot works a backlog of task files, each in its own chat, with QA, a ledger and an unblock UI.
// A goal is one objective pursued in the conversation the user is in, so the loop is the plain turn runner plus a verdict after each turn:
//   - the turn ended COMPLETED   → one verification turn (the agent checks the goal's own wording with tools), then done;
//   - the turn ended BLOCKED     → stop and show the question;
//   - anything else              → "continue", up to a cap, and no more than a few turns that change nothing.
// The record is a workspace file (`.freegent/goal.md`), so it survives a reload or restart, follows the project (Clear removes it)
// and is something the user can read. A goal found active when a front end starts is shown as paused: it never restarts by itself.

export const GOAL_PATH = '.freegent/goal.md';
export const DEFAULT_MAX_TURNS = 20;
const NO_PROGRESS_LIMIT = 3;
const MAX_ERRORS_IN_A_ROW = 3;
const KEEP_PROGRESS = 12;

export type GoalStatus = 'active' | 'paused' | 'done' | 'blocked' | 'cap';
export interface GoalRecord {
    text: string;
    status: GoalStatus;
    turns: number;
    maxTurns: number;
    /** Why it is not active: the blocking question, the error, "stopped by you". */
    note: string;
    updated: string;
    /** One line per finished turn, newest last. */
    progress: string[];
}
export interface GoalTurn {
    text: string;
    finishSignal: 'complete' | 'blocked' | 'running' | 'stopped' | 'error' | string;
    /** Did the turn change files (TurnResult.stop.edited)? Undefined when the host cannot tell. */
    edited?: boolean;
}
export interface GoalHost {
    /** Run one agent turn in the chat the goal belongs to, showing `prompt` as the user's message when `visible`. */
    runTurn(prompt: string, opts: { kind: 'work' | 'verify' | 'steer'; visible: string }): Promise<GoalTurn>;
    read(): Promise<string | null>;
    write(content: string): Promise<void>;
    /** One line for the person: progress, the verdict, a refusal. */
    notify(message: string): void;
    /** Resolve true when nothing else is running in the chat (a queued message, a stream winding down); false if it never was. */
    waitQuiet?(): Promise<boolean>;
    /** The record changed (null: cleared). For a status line. */
    onChange?(rec: GoalRecord | null): void;
    sleep?(ms: number): Promise<void>;
}

// ── Record (de)serialisation ─────────────────────────────────────────────────

const STATUSES: GoalStatus[] = ['active', 'paused', 'done', 'blocked', 'cap'];
export function serializeGoal(g: GoalRecord): string {
    return `---\nstatus: ${g.status}\nturns: ${g.turns}\nmax_turns: ${g.maxTurns}\nupdated: ${g.updated}\nnote: ${JSON.stringify(g.note)}\n---\n`
        + `# Goal\n${g.text.trim()}\n\n## Progress\n${g.progress.slice(-KEEP_PROGRESS).map(p => `- ${p}`).join('\n')}\n`;
}
export function parseGoal(src: string | null | undefined): GoalRecord | null {
    if (!src) return null;
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src.replace(/\r\n/g, '\n'));
    if (!m) return null;
    const fm: Record<string, string> = {};
    for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const body = /^# Goal\n([\s\S]*?)(?:\n\n## Progress\n([\s\S]*))?$/.exec(m[2].trim());
    const text = body?.[1]?.trim();
    if (!text) return null;
    let note = ''; try { note = JSON.parse(fm.note ?? '""'); } catch { note = fm.note ?? ''; }
    const status = STATUSES.includes(fm.status as GoalStatus) ? fm.status as GoalStatus : 'paused';
    return {
        text, status, note: typeof note === 'string' ? note : '',
        turns: Number(fm.turns) || 0, maxTurns: Number(fm.max_turns) || DEFAULT_MAX_TURNS, updated: fm.updated || '',
        progress: (body?.[2] ?? '').split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean),
    };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const ENDING = 'When the goal is fully met, finish your reply with COMPLETED. If you cannot go on without something only the user can give '
    + '(a credential, a choice, a missing fact), do not guess: finish with a line "BLOCKED: <your question, one sentence>".';
const firstPrompt = (text: string) => `Goal: ${text}\n\nWork toward this goal until it is met. Use your tools; check the result against the goal itself, not against your own plan. ${ENDING}`;
const resumePrompt = (g: GoalRecord) => `Resuming this goal: ${g.text}\n\nProgress so far:\n${g.progress.slice(-KEEP_PROGRESS).map(p => `- ${p}`).join('\n') || '- (none recorded)'}\n\n`
    + `Look at the project as it is now, then take the next concrete step. ${ENDING}`;
const continuePrompt = (g: GoalRecord, notes: string[]) => `The goal is not met yet: ${g.text}\n\n${notes.length ? `The user added:\n${notes.map(n => `- ${n}`).join('\n')}\n\n` : ''}`
    + CONTINUE_END;
const verifyPrompt = (g: GoalRecord, notes: string[]) => `You said the goal is complete: ${g.text}\n\n${notes.length ? `The user added:\n${notes.map(n => `- ${n}`).join('\n')}\n\n` : ''}Verify it now against that wording: run the check, read the result, look at the files. `
    + VERIFY_END;

const CONTINUE_END = 'Continue: take the next concrete step with tools now, without restating the plan. Finish with COMPLETED only when the goal is met.';
const VERIFY_END = 'If it is met, reply with the evidence and finish with COMPLETED. If something is missing, say what and keep working.';
/** A message the goal loop itself sent as a turn (first, resume, continue, verify) — in a chat's history it looks like a user message, but no one typed it. */
export function isGoalPrompt(text: string): boolean {
    const t = String(text ?? '').trim();
    return (t.startsWith('Goal: ') && t.endsWith(ENDING))
        || (t.startsWith('Resuming this goal: ') && t.endsWith(ENDING))
        || (t.startsWith('The goal is not met yet: ') && t.endsWith(CONTINUE_END))
        || (t.startsWith('You said the goal is complete: ') && t.endsWith(VERIFY_END));
}

// ── The loop ─────────────────────────────────────────────────────────────────

interface Run { rec: GoalRecord; host: GoalHost; stop: boolean; stopNote: string; steer: string[]; done: Promise<GoalRecord> }
let _run: Run | null = null;

export const goalRunning = (): boolean => _run !== null;
export const currentGoal = (): GoalRecord | null => _run?.rec ?? null;

const firstLine = (s: string): string => (s.trim().split('\n').find(l => l.trim()) ?? '').trim().slice(0, 160);
const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';

async function _save(r: Run, patch: Partial<GoalRecord> = {}): Promise<boolean> {
    Object.assign(r.rec, patch, { updated: nowIso() });
    r.host.onChange?.({ ...r.rec });
    try { await r.host.write(serializeGoal(r.rec)); return true; }
    catch (e: any) {
        // The project was cleared or replaced under the goal (or the file cannot be written): there is nothing to keep working in.
        r.stop = true; r.stopNote = `the goal could not be saved (${e?.message ?? e}), so it was stopped`;
        return false;
    }
}

async function _loop(r: Run, resuming: boolean): Promise<GoalRecord> {
    const { rec, host } = r;
    let errors = 0, still = 0, lastText = '', verifying = false, first = true;
    try {
        if (!await _save(r, { status: 'active', note: '' })) return rec;
        while (!r.stop) {
            if (rec.turns >= rec.maxTurns) { await _save(r, { status: 'cap', note: `${rec.maxTurns} turns used without the goal being met` }); break; }
            if (host.waitQuiet && !await host.waitQuiet()) { await _save(r, { status: 'paused', note: 'the chat did not become free' }); break; }
            if (r.stop) break;

            // Messages the user sent while it worked are part of the next prompt: a steer, not a separate conversation.
            const notes = r.steer.splice(0);
            const kind = verifying ? 'verify' : 'work';
            const prompt = verifying ? verifyPrompt(rec, notes) : first ? (resuming ? resumePrompt(rec) : firstPrompt(rec.text)) : continuePrompt(rec, notes);
            const visible = verifying ? 'Goal: checking that it is met…' : first ? (resuming ? `Goal (resumed): ${rec.text}` : `Goal: ${rec.text}`) : `Goal: turn ${rec.turns + 1} of ${rec.maxTurns}…`;
            if (!verifying) rec.turns++;
            first = false;

            let t: GoalTurn;
            try { t = await host.runTurn(prompt, { kind, visible }); }
            catch (e: any) { t = { text: String(e?.message ?? e), finishSignal: 'error' }; }

            if (r.stop) break;
            const signal = t.finishSignal;
            const line = firstLine(t.text);
            if (!verifying && signal !== 'error') rec.progress.push(`turn ${rec.turns}: ${line || `(${signal})`}`);

            if (signal === 'stopped') { await _save(r, { status: 'paused', note: 'stopped' }); break; }
            if (signal === 'error') {
                if (!verifying) rec.turns--;   // a failed request is not a turn of work
                if (++errors >= MAX_ERRORS_IN_A_ROW) { await _save(r, { status: 'paused', note: `the model failed ${errors} turns in a row: ${line}` }); break; }
                await (host.sleep ?? (ms => new Promise(res => setTimeout(res, ms))))(3000 * errors);
                continue;
            }
            errors = 0;
            if (signal === 'blocked') { await _save(r, { status: 'blocked', note: t.text.trim().slice(0, 400) || 'needs your input' }); break; }
            if (signal === 'complete') {
                if (verifying) { await _save(r, { status: 'done', note: '' }); break; }
                verifying = true; await _save(r); continue;
            }
            // Not finished. A verification that did not confirm sends the loop back to work.
            verifying = false;
            // No progress: nothing edited and the same words again.
            const same = !t.edited && !!line && line === lastText;
            lastText = line;
            still = same || (!line && !t.edited) ? still + 1 : 0;
            if (still >= NO_PROGRESS_LIMIT) { await _save(r, { status: 'blocked', note: `${NO_PROGRESS_LIMIT} turns in a row changed nothing and repeated themselves; say what is in the way, or /goal resume to try again` }); break; }
            if (!await _save(r)) break;
        }
        if (r.stop && rec.status === 'active') await _save(r, { status: 'paused', note: r.stopNote || 'stopped' });
    } finally {
        const done = rec.status;
        const verdict = done === 'done' ? `Goal met after ${rec.turns} turn${rec.turns === 1 ? '' : 's'}.`
            : done === 'blocked' ? `Goal blocked: ${rec.note}`
            : done === 'cap' ? `Goal stopped: ${rec.note}. /goal resume to give it more turns.`
            : `Goal paused${rec.note ? ` (${rec.note})` : ''}. /goal resume continues it.`;
        try { host.notify(verdict); } catch {}
        _run = null;
    }
    return rec;
}

function _begin(rec: GoalRecord, host: GoalHost, resuming: boolean): Promise<GoalRecord> {
    const r: Run = { rec, host, stop: false, stopNote: '', steer: [], done: null as any };
    _run = r;
    r.done = _loop(r, resuming);
    return r.done;
}

export interface StartOptions { maxTurns?: number }
/** `/goal <text>`. Resolves when the loop ends (met, blocked, capped, stopped). */
export function startGoal(text: string, host: GoalHost, opts: StartOptions = {}): Promise<GoalRecord> | null {
    if (_run) { host.notify('A goal is already running. /goal stop ends it first.'); return null; }
    const t = text.trim();
    if (!t) return null;
    return _begin({ text: t, status: 'active', turns: 0, maxTurns: opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : DEFAULT_MAX_TURNS, note: '', updated: nowIso(), progress: [] }, host, false);
}
/** What a resume hands back: `done` settles when the loop ends. (A bare promise of a promise would be flattened by `await` and wait for the whole loop.) */
export interface GoalHandle { done: Promise<GoalRecord> }
/** `/goal resume`. Null (with a line shown) when there is nothing to resume. */
export async function resumeGoal(host: GoalHost, opts: StartOptions = {}): Promise<GoalHandle | null> {
    if (_run) { host.notify('A goal is already running.'); return null; }
    const rec = parseGoal(await host.read().catch(() => null));
    if (!rec) { host.notify('No goal to resume. /goal <what you want done> sets one.'); return null; }
    if (rec.status === 'done') { host.notify(`That goal was already met: ${rec.text}`); return null; }
    // Resuming a goal that ran out of turns gives it a fresh allowance, counted from where it stopped.
    rec.maxTurns = Math.max(opts.maxTurns ?? 0, rec.turns + DEFAULT_MAX_TURNS, rec.maxTurns);
    return { done: _begin(rec, host, true) };
}
/** Stops after the turn in progress (stopNow, if the front end calls it, ends that turn too). */
export function stopGoal(note = 'stopped'): boolean {
    if (!_run) return false;
    _run.stop = true; _run.stopNote = note;
    return true;
}
/** A message from the user while the goal runs: part of the next turn's prompt. */
export function steerGoal(text: string): boolean {
    if (!_run || !text.trim()) return false;
    _run.steer.push(text.trim().slice(0, 1000));
    return true;
}
export async function loadGoal(host: GoalHost): Promise<GoalRecord | null> {
    if (_run) return { ..._run.rec };
    const rec = parseGoal(await host.read().catch(() => null));
    // A goal that was active when its front end went away is not running now.
    if (rec && rec.status === 'active') rec.status = 'paused';
    return rec;
}
export async function clearGoal(host: GoalHost): Promise<boolean> {
    if (_run) { host.notify('Stop the goal first (/goal stop).'); return false; }
    try { await host.write(''); } catch {}
    host.onChange?.(null);
    return true;
}
export function describeGoal(g: GoalRecord | null): string {
    if (!g) return 'No goal set. /goal <what you want done> starts one.';
    const head = { active: 'working', paused: 'paused', done: 'met', blocked: 'blocked', cap: 'out of turns' }[g.status];
    return `Goal (${head}, ${g.turns}/${g.maxTurns} turns): ${g.text}${g.note ? `\n${g.status === 'blocked' ? 'Waiting for you: ' : ''}${g.note}` : ''}`
        + (g.progress.length ? `\nLatest: ${g.progress[g.progress.length - 1]}` : '')
        + (g.status === 'done' ? '' : '\n/goal resume continues it · /goal stop · /goal clear');
}

/** The text after `/goal`, split into the sub-command and its argument. */
export function parseGoalCommand(arg: string): { op: 'start' | 'resume' | 'status' | 'stop' | 'clear'; text: string } {
    const a = arg.trim();
    if (!a) return { op: 'status', text: '' };
    // A sub-command is the whole argument: "/goal stop the server and migrate" is a goal, not a stop.
    const m = /^(resume|stop|clear|status)$/i.exec(a);
    return m ? { op: m[1].toLowerCase() as any, text: '' } : { op: 'start', text: a };
}

/** Test hook: forget a run left by a test. */
export function _resetGoalForTest(): void { _run = null; }
