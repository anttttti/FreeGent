// Tests for the agent-loop turn-state protocol and tool-call parsing — the most
// bug-prone logic in the codebase, previously untested. setup.js loads config.ts,
// tools.ts, workers.ts, model-caps.ts, skill-guidance.ts, deep-research.ts,
// system-prompt.ts, detectors.ts, and history.ts. turn-protocol.ts and llm-loops.ts
// are imported as real ES modules — the eval-transpile loading hack is gone.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    _isComplete, _stripTerminal, _isUserQuestion, _handleTurnState,
} from '../turn-protocol.ts';

// llm-loops.ts imports executeToolAsync statically (line 21), so assigning
// window.executeToolAsync does not intercept it — that stopped working at the ESM
// migration and these tests silently started exercising the REAL tool dispatch, where
// the v0.28 role filter rejects them ("not available in the current role"). Route the
// import through a mutable stub, leaving the rest of tools.ts real for toolLabel below.
vi.mock('../tools.ts', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        executeToolAsync: (...args) => (globalThis.__execToolStub ?? actual.executeToolAsync)(...args),
    };
});

beforeAll(async () => {
    // Imported for its window bridge (_runToolCalls etc.) — module body only defines
    // functions and runs Object.assign(window, …), safe under the jsdom test env.
    await import('../llm-loops.ts');
});

beforeEach(() => {
    // workers.ts sets mainAgentRole = director at module load time (persistent default).
    // Reset to null so tests that don't configure a role don't hit the director-exclusion
    // in missing_state_line.re_fail (which suppresses the check for the director role).
    window.mainAgentRole = null;
});

describe('_isComplete — turn-state detection', () => {
    it('accepts an explicit COMPLETED terminal line', () => {
        expect(_isComplete('Report text.\n\nCOMPLETED')).toBe(true);
    });
    it('accepts high-prior synonyms DONE / TERMINATE', () => {
        expect(_isComplete('All edits applied.\n**DONE**')).toBe(true);
        expect(_isComplete('Finished.\nTERMINATE')).toBe(true);
    });
    it('accepts the completion-format markers', () => {
        expect(_isComplete('## Task done\n\n**Outcome:** the map now scrolls.')).toBe(true);
    });
    it('accepts a declared BLOCKED exit', () => {
        expect(_isComplete('**Blocked:** the API key is missing.')).toBe(true);
        expect(_isComplete('BLOCKED: the API key is missing.')).toBe(true);
    });
    it('accepts the worker STATUS footer', () => {
        expect(_isComplete('STATUS: complete')).toBe(true);
        expect(_isComplete('STATUS: blocked — no write access')).toBe(true);
    });
    it('rejects mid-task narration with no state line', () => {
        expect(_isComplete('Let me replace that section with mandatory vertical variety, then I will verify the edit.')).toBe(false);
    });
    it('does not treat "done" inside prose as completion', () => {
        expect(_isComplete('The function is done when the timer fires, so the loop keeps running until then and beyond.')).toBe(false);
    });
});

describe('_stripTerminal — token removal from displayed text', () => {
    it('strips a same-line glued COMPLETED suffix ("13COMPLETED" → "13", v0.12 DB-16)', () => {
        expect(_stripTerminal('13COMPLETED')).toBe('13');
    });

    it('strips a trailing COMPLETED line but keeps the body', () => {
        expect(_stripTerminal('The summary.\n\nCOMPLETED')).toBe('The summary.');
    });
    it('leaves text without a terminal token unchanged', () => {
        expect(_stripTerminal('Just a normal answer.')).toBe('Just a normal answer.');
    });
    it('does not strip "continue" embedded in prose', () => {
        expect(_stripTerminal('Please continue the work here')).toBe('Please continue the work here');
    });

    // <thought>…</thought> blocks (Gemma4 inline reasoning)
    it('strips a complete <thought>…</thought> block', () => {
        expect(_stripTerminal('<thought>\nI should search.\n</thought>\nHere is the answer.'))
            .toBe('Here is the answer.');
    });
    it('strips a <thought> block in the middle of text', () => {
        expect(_stripTerminal('Intro.<thought>reasoning</thought>Conclusion.'))
            .toBe('Intro.Conclusion.');
    });
    it('strips an unclosed <thought> tag (partial leak)', () => {
        // Model was cut off before emitting </thought>
        expect(_stripTerminal('Answer.<thought')).toBe('Answer.');
    });
    it('strips a stray </thought> close tag', () => {
        expect(_stripTerminal('Answer.</thought>')).toBe('Answer.');
    });
});

describe('parseFnTagCalls — non-native tool-call formats', () => {
    it('parses Format C (GLM <tool_use>)', () => {
        const text = 'I will search.\n<tool_use><tool_name>search_workspace</tool_name><arguments>{"query":"map"}</arguments></tool_use>';
        const { tool_calls, cleaned } = window.parseFnTagCalls(text);
        expect(tool_calls).toHaveLength(1);
        expect(tool_calls[0].function.name).toBe('search_workspace');
        expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ query: 'map' });
        expect(cleaned).toBe('I will search.');
    });
    it('parses Format D (DeepSeek <tool_name><param>)', () => {
        const text = '<read_file><path>maps/level1.js</path></read_file>';
        const { tool_calls } = window.parseFnTagCalls(text);
        expect(tool_calls).toHaveLength(1);
        expect(tool_calls[0].function.name).toBe('read_file');
        expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ path: 'maps/level1.js' });
    });
    it('Format D only matches known tool names, not arbitrary XML', () => {
        const { tool_calls } = window.parseFnTagCalls('<nudge>this is not a tool</nudge>');
        expect(tool_calls).toHaveLength(0);
    });
    it('parses Format B (<function=name>{json}</function>)', () => {
        const { tool_calls } = window.parseFnTagCalls('<function=list_files>{"path":""}</function>');
        expect(tool_calls).toHaveLength(1);
        expect(tool_calls[0].function.name).toBe('list_files');
    });
    it('returns nothing for plain prose', () => {
        const { tool_calls } = window.parseFnTagCalls('Just a normal sentence with no tool call.');
        expect(tool_calls).toHaveLength(0);
    });
});

describe('_updateBlankSteps — silent-step stall detection', () => {
    it('does not flag a step that produced visible text', () => {
        const r = window._updateBlankSteps(true, true, 0, 0);
        expect(r.blankSteps).toBe(0);
        expect(r.stallMsg).toBeNull();
    });
    it('counts consecutive blank tool-call steps and nudges at the threshold', () => {
        let s = { blankSteps: 4, consecutiveStalls: 0 };
        const r = window._updateBlankSteps(true, false, s.blankSteps, s.consecutiveStalls);
        expect(r.stallMsg).toBeTruthy();      // 5th blank step fires a nudge
        expect(r.blankSteps).toBe(0);          // counter resets after firing
    });
});

describe('_updateStuckDetector — repeated identical results', () => {
    it('fires after three identical result signatures', () => {
        let hashes = [];
        let msg;
        ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector('X', new Set(), hashes));
        expect(msg).toBeNull();
        ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector('X', new Set(), hashes));
        expect(msg).toBeNull();
        ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector('X', new Set(), hashes));
        expect(msg).toBeTruthy();              // three in a row → stuck nudge
    });
    it('does not fire when results differ', () => {
        let hashes = [];
        let msg;
        for (const sig of ['A', 'B', 'C']) {
            ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector(sig, new Set(), hashes));
        }
        expect(msg).toBeNull();
    });
});

describe('_handleTurnState — shared no-tool-call protocol (Issue 8 slice 1)', () => {
    const mkAdapter = () => {
        const hist = [];
        return {
            hist,
            pushNudge: t => hist.push({ nudge: t }),
            spliceFromSecondLast: c => hist.splice(hist.length - 2, c),
            histLen: () => hist.length,
        };
    };

    it('bare COMPLETED reply to a reminder returns the saved pre-reminder text', async () => {
        const ps = { finalCheck: 1, cont: 0, saved: 'the real summary', substCheck: 0 };
        const a = mkAdapter();
        a.hist.push({ reminder: true }, { reply: true }); // [reminder, reply]
        const r = await _handleTurnState('COMPLETED', 0, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toBe('the real summary');
        expect(a.hist).toHaveLength(0); // both reminder+reply spliced
    });

    it('a short bare-VALUE reply to a reminder returns the VALUE, not stale saved text (v0.12 OS-12/DB-16)', async () => {
        // v0.12 regression: model answered "yes\nCOMPLETED" after a reminder; the old
        // length>40 rule treated it as an acknowledgment and returned ps.saved — which in
        // multi-bounce chains was the bounced verbose middle response. The value wins.
        const ps = { finalCheck: 1, cont: 0, saved: 'Your output appears correct. The file exists…', substCheck: 0 };
        const a = mkAdapter();
        a.hist.push({ reminder: true }, { reply: true });
        const r = await _handleTurnState('yes\nCOMPLETED', 0, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toBe('yes');
    });

    it('a pure acknowledgment phrase still falls back to the saved text', async () => {
        const ps = { finalCheck: 1, cont: 0, saved: 'the real summary', substCheck: 0 };
        const a = mkAdapter();
        a.hist.push({ reminder: true }, { reply: true });
        const r = await _handleTurnState('Task is complete.\nCOMPLETED', 0, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toBe('the real summary');
    });

    it('a full completion message ending COMPLETED is kept (only the reminder spliced)', async () => {
        const ps = { finalCheck: 1, cont: 0, saved: 'stale', substCheck: 0 };
        const a = mkAdapter();
        a.hist.push({ reminder: true }, { reply: true });
        const long = '## Task complete\n\n**Outcome:** the map scrolls correctly now.\n\nCOMPLETED';
        const r = await _handleTurnState(long, 0, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toContain('Outcome');
        expect(r.text).not.toContain('COMPLETED');
        expect(a.hist).toHaveLength(1); // only the reminder spliced, reply kept
    });

    it('declared COMPLETED with substantive body returns stripped text immediately', async () => {
        const ps = { finalCheck: 0, cont: 0, saved: null, substCheck: 0 };
        const body = 'All config.ts edits applied — the schema now validates correctly.';
        const r = await _handleTurnState(`${body}\nCOMPLETED`, 0, ps, mkAdapter());
        expect(r.kind).toBe('return');
        expect(r.text).toBe(body);
    });

    it('declared COMPLETED with thin body returns immediately (no nudge for non-empty)', async () => {
        const ps = { finalCheck: 0, cont: 0, saved: null, substCheck: 0 };
        const a = mkAdapter();
        const r = await _handleTurnState('Done.\nCOMPLETED', 0, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toBe('Done.');
        expect(ps.substCheck).toBe(0); // no nudge fired
    });

    it('COMPLETED with empty body bounces twice, then accepts (fixed-point guard)', async () => {
        // The budget lives in ps.emptyBodyCount (cap 2), not ps.substCheck (cap 1): a
        // one-shot gate let the model escape a COMPLETED -> nudge -> COMPLETED loop with an
        // empty answer. The third attempt is accepted so the loop cannot hang.
        const ps = { finalCheck: 0, cont: 0, saved: null, substCheck: 0 };
        const a = mkAdapter();
        const r1 = await _handleTurnState('COMPLETED', 0, ps, a);
        expect(r1.kind).toBe('continue');
        expect(ps.emptyBodyCount).toBe(1);
        expect(a.hist.at(-1).nudge).toMatch(/no answer body/i);
        const r2 = await _handleTurnState('COMPLETED', 0, ps, a);
        expect(r2.kind).toBe('continue');
        expect(ps.emptyBodyCount).toBe(2);
        const r3 = await _handleTurnState('COMPLETED', 0, ps, a);
        expect(r3.kind).toBe('return');
        expect(r3.text).toBe('');
    });

    it('_saveAnswer never replaces a saved answer with body-less text (2026-07-16 regression, re-broken by 31db758)', () => {
        // The guarded saver was deleted by the v0.18 baseline revert and replaced with bare
        // `ps.saved = text`, so a bare state line or a reasoning-only step overwrote a real
        // answer and the turn finalized as "(no text response)".
        const ps = { finalCheck: 1, cont: 0, saved: 'The file has been updated with all the requested changes.', substCheck: 0 };
        window._saveAnswer(ps, 'COMPLETED');                    // bare state line — keep prior
        expect(ps.saved).toMatch(/file has been updated/);
        window._saveAnswer(ps, '');                             // reasoning-only — keep prior
        expect(ps.saved).toMatch(/file has been updated/);
        window._saveAnswer(ps, 'New full answer.\nCOMPLETED'); // substantive body — replace
        expect(ps.saved).toBe('New full answer.\nCOMPLETED');
        const fresh = { saved: null };
        window._saveAnswer(fresh, '');                          // nothing saved yet — take it
        expect(fresh.saved).toBe('');
    });

    it('an empty reasoning-only response must not clobber the saved answer (2026-07-16 bare-COMPLETED regression)', async () => {
        // Reproduces the fg-chat-2026-07-16 failure: completion gate saved the real
        // answer; the next step was reasoning-only (empty visible text), which fired
        // missing_state_line — whose onFire used to overwrite ps.saved with ''. The
        // model then obeyed the protocol reminder with a bare COMPLETED, and the
        // bare-ack recovery returned '' instead of the saved answer.
        await import('../step-validator.ts'); // bridges validateOutput for _validateStepOutput
        const ps = { finalCheck: 1, cont: 0, saved: 'The Geometry Dash clone has been created.\n\nCOMPLETED', substCheck: 0, checkFires: {} };
        const vc = await window._validateStepOutput('', ps, 'post-state');
        expect(vc?.name).toBe('missing_state_line');            // reminder still fires
        expect(ps.saved).toMatch(/Geometry Dash/);              // saved answer survives
        const a = mkAdapter();
        a.hist.push({ reminder: true }, { reply: true });
        const r = await _handleTurnState('COMPLETED', 2, ps, a);
        expect(r.kind).toBe('return');
        expect(r.text).toBe('The Geometry Dash clone has been created.');
    });

    it('plain narration falls through to the caller', async () => {
        const ps = { finalCheck: 0, cont: 0, saved: null, substCheck: 0 };
        const r = await _handleTurnState('Let me replace that section next.', 0, ps, mkAdapter());
        expect(r.kind).toBe('fallthrough');
    });
});

describe('_isUserQuestion — autonomous question detection', () => {
    it('detects "can you" interrogatives', () => {
        expect(_isUserQuestion('Can you provide the database credentials?')).toBe(true);
    });
    it('detects "could you" interrogatives', () => {
        expect(_isUserQuestion('Could you share the API key?')).toBe(true);
    });
    it('detects "please provide" forms', () => {
        expect(_isUserQuestion('Please provide the access token.')).toBe(false); // no ?
        expect(_isUserQuestion('Please provide the access token?')).toBe(true);
    });
    it('rejects prose without a question mark', () => {
        expect(_isUserQuestion('I need more details to proceed.')).toBe(false);
    });
    it('rejects rhetorical questions not directed at the user', () => {
        expect(_isUserQuestion('What is the purpose of this function?')).toBe(false);
    });
});

describe('_runToolCalls — shared tool execution (Issue 8 slice 2)', () => {
    const mkTasks = n => Array.from({ length: n }, () => ({
        setPrompt: vi.fn(), setOutput: vi.fn(), complete: vi.fn(),
    }));

    it('runs each call in order and returns {name,args,result}', async () => {
        globalThis.__execToolStub = vi.fn(async (name, args) => ({ ok: name + ':' + (args.x ?? '') }));
        const norm = [{ name: 'a', args: { x: 1 } }, { name: 'b', args: { x: 2 } }];
        const tasks = mkTasks(2);
        const out = await window._runToolCalls(norm, tasks, { forWorker: false });
        expect(out).toEqual([
            { name: 'a', args: { x: 1 }, result: { ok: 'a:1' } },
            { name: 'b', args: { x: 2 }, result: { ok: 'b:2' } },
        ]);
        expect(tasks[0].complete).toHaveBeenCalled();
        expect(tasks[1].setOutput).toHaveBeenCalled();
    });

    it('wraps a thrown tool error into {error,hint}', async () => {
        globalThis.__execToolStub = vi.fn(async () => { throw new Error('boom'); });
        const out = await window._runToolCalls([{ name: 'read_file', args: {} }], mkTasks(1), { forWorker: false });
        expect(out[0].result.error).toBe('boom');
        expect(out[0].result.hint).toBeTruthy();
    });

    it('fires onTaskDone for update_task_status("done")', async () => {
        globalThis.__execToolStub = vi.fn(async () => ({ ok: true }));
        const onTaskDone = vi.fn();
        await window._runToolCalls(
            [{ name: 'update_task_status', args: { status: 'done' } }],
            mkTasks(1), { forWorker: false, onTaskDone });
        expect(onTaskDone).toHaveBeenCalledTimes(1);
    });

    it('does not fire onTaskDone for a non-done status', async () => {
        globalThis.__execToolStub = vi.fn(async () => ({ ok: true }));
        const onTaskDone = vi.fn();
        await window._runToolCalls(
            [{ name: 'update_task_status', args: { status: 'in-progress' } }],
            mkTasks(1), { forWorker: false, onTaskDone });
        expect(onTaskDone).not.toHaveBeenCalled();
    });

    it('calls onResult with (name,args,result) for each call', async () => {
        globalThis.__execToolStub = vi.fn(async () => ({ ok: 1 }));
        const seen = [];
        await window._runToolCalls(
            [{ name: 'x', args: { p: 'q' } }], mkTasks(1),
            { forWorker: false, onResult: (n, a, r) => seen.push([n, a, r]) });
        expect(seen).toEqual([['x', { p: 'q' }, { ok: 1 }]]);
    });

    it('works with null toolTasks and forwards context + fires onStart (worker path)', async () => {
        const calledWith = [];
        globalThis.__execToolStub = vi.fn(async (name, args, ctx) => { calledWith.push([name, ctx]); return { ok: 1 }; });
        const started = [];
        const out = await window._runToolCalls(
            [{ name: 'read_file', args: { path: 'a' } }], null,
            { forWorker: true, context: { snap: 1 }, onStart: (n, a, i) => started.push([n, i]) });
        expect(out[0].result).toEqual({ ok: 1 });
        expect(calledWith[0][1]).toEqual({ snap: 1 });   // context forwarded
        expect(started).toEqual([['read_file', 0]]);      // onStart fired before exec
    });
});

// The 'agent' role's own prompt promises unlimited web_search/fetch_url/list_files rounds
// for "Simple" questions — only write_file/append_file calls should count toward its forced-
// handover budget, otherwise genuine research gets cut short mid-search (see runTurn's
// _isAgentRole block, which increments agentWriteSteps only when this returns true).

describe('_updateStuckDetector / _updateBlankSteps — local seen-map eviction (worker path)', () => {
    it('_updateStuckDetector evicts the passed-in maps (not globals) on a 3x repeat', () => {
        const rf = new Map([['a.js:1:9', 'x'], ['b.js:1:9', 'y']]);
        const lf = new Set(['a.js']);
        const seen = { rf, lf };
        let hashes = [];
        let msg;
        const paths = new Set(['a.js']);
        for (let i = 0; i < 3; i++) {
            ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector('SIG', paths, hashes, seen));
        }
        expect(msg).toBeTruthy();
        expect(rf.has('a.js:1:9')).toBe(false); // evicted (path matched)
        expect(rf.has('b.js:1:9')).toBe(true);  // kept (path not stalled)
        expect(lf.has('a.js')).toBe(false);
    });

    it('_updateBlankSteps clears the passed-in maps at the 5-blank threshold', () => {
        const rf = new Map([['x', 1]]);
        const lf = new Set(['y']);
        let blank = 4, stalls = 0;
        const r = window._updateBlankSteps(true, false, blank, stalls, { rf, lf });
        expect(r.stallMsg).toBeTruthy();
        expect(rf.size).toBe(0);
        expect(lf.size).toBe(0);
    });
});

describe('toolLabel — fallback sanitization', () => {
    it('clamps and strips markup from an unknown tool name', () => {
        const out = window.toolLabel('<handover>\n<original_request>\nbig blob of XML that would otherwise fill the badge with markup</original_request>', {});
        expect(out).not.toContain('<');
        expect(out.length).toBeLessThanOrEqual(48);
    });
    it('still labels a known tool normally', () => {
        expect(window.toolLabel('list_files', {})).toBe('list_files');
    });
});
