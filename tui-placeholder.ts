// TUI placeholder factory — implements the same handle contract as
// chat-render.ts createResponsePlaceholder(), but drives tui-store instead of DOM.

import * as Store from './tui-store.js';
import { _stripTerminal } from './turn-protocol.js';

const _noop = (..._args: any[]) => {};

function _makeStepHandle(step: Store.StepState) {
    let done = false;
    const timer = setInterval(() => {
        step.elapsed = (Date.now() - step.startTime) / 1000;
    }, 200);

    const _finish = (status: Store.StepStatus) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        Store.flushStep(step);
        Store.patchStep(step, { status, elapsed: (Date.now() - step.startTime) / 1000 });
    };

    return {
        setModel:      (name: string)         => Store.patchStep(step, { model: name }),
        setTokens:     (inp: number, out: number) => Store.patchStep(step, { tokens: { inp, out } }),
        setPrompt:     (text: string)         => Store.patchStep(step, { prompt: text }),
        setRequest:    (text: string)         => Store.patchStep(step, { request: text }),
        append:        (text: string, type?: string) => Store.bufferAppend(step, text, type),
        setOutput:     (text: string)         => Store.patchStep(step, { output: text }),
        complete:      ()                     => _finish('done'),
        abort:         ()                     => _finish('aborted'),
        markCompact:   ()                     => Store.patchStep(step, { status: 'compact' }),
        markTruncated: (reason: string)       => _finish('truncated'),
    };
}

export function makeTuiPlaceholder(opts?: { continueTurn?: Store.TurnState }): object {
    // A rerun from a step continues the turn it cut: the steps before it stay, the new ones follow.
    const turn = opts?.continueTurn ?? Store.addTurn();
    if (!opts?.continueTurn) turn.origin = Store.takeTurnOrigin();
    // The history length the latest model call of this turn started from, and that step: what the Rerun button of that step and of the
    // tool steps it made cuts back to.
    let curHistLen: number | null = null;
    let curThink: Store.StepState | null = null;
    // Track live handles so finalize() can abort them (mirrors chat-render.ts stopAll()).
    const _liveHandles: ReturnType<typeof _makeStepHandle>[] = [];

    const _steps = (labels: string | string[], rerunnable = false, isThink = false) =>
        (Array.isArray(labels) ? labels : [labels])
            .map(l => {
                const st = Store.addStep(turn, l, rerunnable && curHistLen !== null ? { histLen: curHistLen, anchor: isThink ? null : curThink } : undefined);
                if (isThink) curThink = st;
                const h = _makeStepHandle(st);
                _liveHandles.push(h);
                return h;
            });

    return {
        // DOM stub — llm-loops references placeholder.div for container context but
        // never reads its contents in the headless / TUI paths.
        div: { style: {}, appendChild: _noop, contains: () => false } as any,

        addThinkingTask: (ctx?: { histLen?: number }) => {
            if (typeof ctx?.histLen === 'number') curHistLen = ctx.histLen;
            const role  = mainAgentRole?.name ?? null;
            const label = role ? `Thinking:${role}` : 'Thinking…';
            return _steps([label], true, true)[0];
        },
        // The main agent's own tool call is rerunnable (its model call reruns with it); workers' steps are not, as in the WebUI.
        addToolStep:    (labels: string | string[], o?: { main?: boolean }) => _steps(labels, !!o?.main && (!Array.isArray(labels) || labels.length === 1)),
        addCompactStep: () => {
            const h = _steps(['compacting…'])[0];
            h.markCompact();
            return h;
        },
        addSystemStep:  (label: string) => Store.addSystemStep(turn, label),
        finalize:       (text: string)  => {
            // Abort any step handles still running (mirrors chat-render.ts's stopAll()).
            for (const h of _liveHandles) h.abort();
            _liveHandles.length = 0;
            // Strip protocol tokens before storing — the same cleanup chat-render.ts
            // applies via _stripTerminal(liveContent) and cleanResponse(text).
            Store.finalizeTurn(turn, _stripTerminal(text ?? ''));
        },
    };
}
