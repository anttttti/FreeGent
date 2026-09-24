// turn-protocol.ts — FreeGent: the terminal-state protocol for agent turns.
//
// Every no-tool-call response must end with a state line — COMPLETED (turn finished)
// or BLOCKED: <reason>. This module owns that
// contract end to end: the detection regexes, the display stripper, the accept/bounce
// state machine (_handleTurnState), and the autonomous-mode question redirection.
//
// _handleTurnState never touches history directly — callers pass an adapter
// { pushNudge(text), spliceFromSecondLast(count), histLen() } and apply the returned
// control signal. That adapter IS the module boundary; decision here, effects at the
// call site (same discipline as step-validator/detectors).
//
// Follows the step-validator/nudge-emitter/payload-builder/detectors pattern:
// ES module, exports, window bridge.

import { workflowMode, setLastTurnDoneToken } from './state.js';
import { getAgentMaxSteps } from './config.js';

// The configured step limit (fg_agent_max_rounds / --max-rounds) — the same one runTurn loops on.
// The constant MAX_STEPS (100) made the "not on the last step" guards wrong for other limits.
const _maxSteps = () => getAgentMaxSteps();

// The detector accepts high-prior synonyms (DONE, TERMINATE, TASK COMPLETE from AutoGen/
// LangChain-style pretraining data) since half-compliant models drift to those.
export const _TERMINAL_RE   = /(?:^|\n)\s*\*{0,2}(?:DONE|COMPLETED|TASK COMPLETE|TERMINATE)[.!]?\*{0,2}\s*$/;

// Strips terminal tokens and leaked reasoning tags from text shown to the user /
// captured as the benchmark answer. Handles unclosed think-tags too — AgentBench OS
// task 25's entire final answer was a bare "</thinking".
export function _stripTerminal(text: string): string {
    return (text || '')
        .replace(_TERMINAL_RE, '')
        .replace(/\s+\*{0,2}(?:DONE|COMPLETED|TASK COMPLETE|TERMINATE)[.!]?\*{0,2}\s*$/, '')
        // Same-line leak: the model glues the token to the value ("13COMPLETED", DB-16).
        // End-of-string only, and only when directly attached to non-whitespace — the
        // line-anchored rules above already handle the separated forms.
        // NOTE: no lookbehind — Safari 12 doesn't support (?<=...). Capture the
        // preceding non-whitespace char and restore it instead.
        .replace(/(\S)COMPLETED\s*$/, '$1')
        // Acknowledgment-prefix: "COMPLETED. Here is the answer" or "COMPLETED — summary" —
        // token at start-of-string followed by optional em-dash/en-dash separator and content.
        // _isComplete() recognises this as a valid exit; strip the token and any leading
        // separator so only the result body shows.
        // Requires \s+ or [—–-]\s* so bare "COMPLETED" is left for the end-of-string rules.
        .replace(/^\s*\*{0,2}(?:DONE|COMPLETED|TASK COMPLETE|TERMINATE)[.!]?\*{0,2}(?:\s*[—–-]+\s*|\s+)/i, '')
        // Strip leading BLOCKED: prefix — the reason text is kept for display, but the
        // protocol marker is an internal state token, not user-facing copy.
        .replace(/^\s*\*{0,2}BLOCKED\*{0,2}:\s*/m, '')
        // Worker status footer — models sometimes copy this protocol into their own output
        // when it appears in conversation context (via history injection or tool results).
        // _isComplete() recognises it as a valid exit signal but _stripTerminal must also
        // remove it so the marker never leaks into the user-visible message text.
        .replace(/\n?^STATUS:\s*(?:complete|blocked|partial)(?:\s*—[^\n]*)?\s*$/im, '')
        // Strip complete <thought>...</thought> blocks (Gemma4 inline reasoning).
        // Then strip any unclosed <thought>… block that reaches end-of-text — Pi can
        // truncate the response before the closing tag is emitted, and the unclosed
        // block never matches the complete-block regex.  Mop up stray tags last.
        // Order matters: full-block first so content doesn't survive as orphaned text.
        .replace(/<thought>[\s\S]*?<\/thought>\n?/gi, '')
        .replace(/<thought>[\s\S]*/gi, '')        // unclosed: from <thought> to EOT
        .replace(/<\/?(?:think|thinking|thought)>?/gi, '')
        .replace(/<\/?(?:handover_context|original_request)>/gi, '')
        .trimEnd();
}

// Matches a genuine BLOCKED state declaration at the start of a line (optionally bolded),
// e.g. "BLOCKED: <reason>" or "**Blocked:**" — not the bare word "blocked" appearing in prose
// (a real incident: a response discussing "hard block"/"blocks completion" as ordinary
// technical content was misdetected as a blocked-exit declaration by a plain \bBLOCKED\b match).
export const _BLOCKED_DECLARATION_RE = /^\*{0,2}BLOCKED\*{0,2}:/im;

// Returns true when text looks like a genuine final answer that should not be intercepted.
export function _isComplete(text: string): boolean {
    if (_TERMINAL_RE.test(text)) return true;                    // COMPLETED / DONE / TERMINATE
    if (_BLOCKED_DECLARATION_RE.test(text)) return true;          // BLOCKED: <reason> — declared exit
    if (/^STATUS:\s*(complete|blocked|partial)/im.test(text)) return true; // worker status footer
    if (/^##\s+(?:Task\s+done|Outcome\b)/im.test(text)) return true; // ## Task done / ## Outcome header
    // Same-line terminal: model writes "Helsinki. COMPLETED" or "0 files. COMPLETED." on one line.
    // _TERMINAL_RE requires a leading newline or start-of-string before the token, which doesn't
    // match when the token is glued to the answer on the same line. End-of-string position is
    // unambiguous — a model that writes X at the very end of its response intends to terminate.
    if (/\b(?:COMPLETED|DONE|TASK COMPLETE|TERMINATE)[.!]?\s*$/i.test(text)) return true;
    // Acknowledgment-prefix pattern: model writes "COMPLETED. [summary]" — COMPLETED at the
    // start of the response followed by a short explanation. Treat the response as complete.
    if (/^\s*\*{0,2}(?:DONE|COMPLETED|TASK COMPLETE|TERMINATE)[.!]?\*{0,2}\s+\S/i.test(text)) return true;
    return false;
}

// Detects user-directed questions in model output — interrogatives that ask "you" (the user) for
// something. Used to redirect autonomous agents that stall waiting for clarification.
export function _isUserQuestion(text: string): boolean {
    if (!/\?/.test(text)) return false;
    return /\b(can you|could you|would you|please (?:provide|share|tell|give|send|clarify|specify|confirm)|what (?:is|are|would) your|do you (?:have|want|know)|would it be|is there any(?:thing)? you|are you able|have you)\b/i.test(text);
}

// Three-band wrapper over _isUserQuestion: the regex only catches direct
// question phrasings; indirect requests ("It would help to know which Python version
// is in use.") have no "?" and no matching pattern. Ambiguous → LLM.
const _ASKS_USER_CHECKS = [{
    name: 'asks_user', max: 3,
    re_fail: t => _isUserQuestion(t),
    re_pass: t => !/\?/.test(t) && !/\b(know|provide|clarif\w*|confirm|specify|share|which|would help|need(?:ed)? from)\b/i.test(t),
    llmPrompt: 'The agent below is operating autonomously — no user can reply. Does the output ask the user for information or a decision (directly or indirectly), instead of proceeding with the work?',
}];
export async function _asksUser(text: string, ps: any): Promise<boolean> {
    if (typeof validateOutput === 'function') {
        const vc = await validateOutput(text, _ASKS_USER_CHECKS, {
            counters: (ps.checkFires ??= {}),
            llm: typeof callLLMComplete === 'function' ? callLLMComplete : null });
        return !!vc;
    }
    return _isUserQuestion(text);
}


// Shared no-tool-call turn-state handler.
//   textContent : the model's text this step
//   step        : current step index
//   ps          : mutable protocol state { finalCheck, cont, saved, substCheck, checkFires } (caller reads back)
//   adapter     : { pushNudge(text), spliceFromSecondLast(count), histLen() }
// Returns a control signal the caller acts on:
//   { kind: 'return', text }  → caller returns text
//   { kind: 'continue' }      → caller continues the step loop
//   { kind: 'fallthrough' }   → caller proceeds to the remaining (provider-specific) checks
export async function _handleTurnState(textContent: string, step: number, ps: any, adapter: any) {
    const _isAutonomous = workflowMode;
    // COMPLETED reply to a protocol reminder. Two shapes:
    // - bare ACKNOWLEDGMENT ("Done. COMPLETED") → splice reminder+reply, return the
    //   saved pre-reminder text (the reply carries no answer of its own);
    // - anything with actual content → keep it and return IT — even when short.
    //   A short final answer ("yes", "13") IS the answer, not an acknowledgment: the
    //   old length>40 rule returned ps.saved here, which in multi-bounce chains was the
    //   bounced middle response — v0.12 AgentBench captured verbose garbage while the
    //   model's actual final message was the correct bare value (OS-12, DB-16).
    if (ps.finalCheck > 0 && /\bCOMPLETED\b/.test(textContent)) {
        setLastTurnDoneToken(true);
        const newText = _stripTerminal(textContent).trim();
        const _isBareAck = !newText ||
            /^(?:ok(?:ay)?|done|understood|acknowledged|confirmed|(?:the )?task(?:'s| is| was)?(?: now)? ?complete[d]?)[.! ]*$/i.test(newText);
        if (!_isBareAck) {
            if (adapter.histLen() >= 2) adapter.spliceFromSecondLast(1);
            return { kind: 'return', text: newText };
        }
        if (adapter.histLen() >= 2) adapter.spliceFromSecondLast(2);
        return { kind: 'return', text: _stripTerminal(ps.saved ?? textContent) };
    }
    // Declared COMPLETED — validate before accepting.
    // Pathologies caught here (one-shot nudge via ps.substCheck, accepted on second attempt):
    //   1. question-completion: model asked the user something then declared COMPLETED
    //      (autonomous mode: user cannot reply, so redirect to Blocked instead)
    //   2. empty-completion: no answer body at all — nudge for actual content
    // NOT caught: short bare-value answers (numbers, single words) — these are valid
    // benchmark answers and must not be re-prompted, or the second response will
    // overwrite the correct bare answer with verbose prose.
    //
    // Match both strict end-of-string form (TERMINAL_RE) AND the ack-prefix form
    // "COMPLETED — [explanation]" (isComplete covers both). Without this, models that
    // write "COMPLETED — summary" at the start of their response never set
    // _lastTurnDoneToken → finishSignal stays 'running' → directorLoop overshoots
    // the cap, wasting budget and risking git stash / git commit destroying the patch.
    if (_isComplete(textContent)) {
        const bodyText = _stripTerminal(textContent).trim();
        // Structural gate: empty-body COMPLETED is blocked for up to 2 bounces (ps.emptyBodyCount).
        // Unlike substCheck (capped at 1), this gate stays active on the second bounce so the
        // fixed-point "COMPLETED→nudge→COMPLETED" loop cannot escape with an empty answer.
        // On the third empty attempt accept it (infinite-loop guard) via fall-through below.
        //
        // Skip the gate when ps.saved already holds an answer: the model gave its full response
        // in a prior message (e.g. the step with IMAGE output + description text), was nudged
        // for a missing state token, then replied with bare "COMPLETED".  The answer was saved
        // by missing_state_line.onFire(), so repeating it here would be redundant and the bare
        // "COMPLETED" should be accepted and the saved answer returned as the final text.
        const _hasSavedAnswer = !!(_stripTerminal(ps.saved ?? '').trim());
        if (bodyText.length === 0 && !_hasSavedAnswer && (ps.emptyBodyCount ?? 0) < 2 && step < _maxSteps() - 1) {
            ps.emptyBodyCount = (ps.emptyBodyCount ?? 0) + 1;
            adapter.pushNudge('You declared COMPLETED with no answer body. Output the result or a description of what was accomplished. Do NOT output COMPLETED yet — it will be accepted automatically once you have stated the answer.');
            return { kind: 'continue' };
        }
        if (ps.substCheck < 1 && step < _maxSteps() - 1) {
            const isQuestionDone = _isAutonomous && await _asksUser(bodyText, ps);
            if (isQuestionDone) {
                ps.substCheck++;
                adapter.pushNudge('You cannot ask the user for information in autonomous mode. Complete the task with available information, or end with BLOCKED: <specific reason>.');
                return { kind: 'continue' };
            }
            // JSON tool-call written as text instead of a structured call — reject deterministically.
            if (/^\{["'](?:name|function)["']\s*:/.test(bodyText)) {
                ps.substCheck++;
                adapter.pushNudge('Your answer looks like a JSON tool call, not an actual result. Make the tool call with the structured function-call format; do not output it as text.');
                return { kind: 'continue' };
            }
        }
        setLastTurnDoneToken(true);
        // When accepting a bounce-retry COMPLETED, prefer the saved pre-bounce answer over an
        // empty body (the model often ends a retry with bare "COMPLETED" — use ps.saved so the
        // actual result isn't lost).
        const _returnText = _stripTerminal(textContent).trim();
        return { kind: 'return', text: _returnText || (_stripTerminal(ps.saved ?? '') || '') };
    }
    return { kind: 'fallthrough' };
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _BLOCKED_DECLARATION_RE,
    _TERMINAL_RE,
    _stripTerminal, _isComplete, _isUserQuestion, _asksUser, _handleTurnState,
});
