// TUI placeholder factory — implements the same handle contract as
// chat-render.ts createResponsePlaceholder(), but drives tui-store instead of DOM.

import * as Store from './tui-store.js';
import { _stripTerminal } from './turn-protocol.js';

const _noop = (..._args: any[]) => {};

const _noopHandle = {
    setModel: _noop, setTokens: _noop, setPrompt: _noop, setRequest: _noop,
    append: _noop, setOutput: _noop, complete: _noop, abort: _noop,
    markCompact: _noop, markTruncated: _noop,
};

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

export function makeTuiPlaceholder(): object {
    const turn = Store.addTurn();
    // Track live handles so finalize() can abort them (mirrors chat-render.ts stopAll()).
    const _liveHandles: ReturnType<typeof _makeStepHandle>[] = [];

    const _steps = (labels: string | string[]) =>
        (Array.isArray(labels) ? labels : [labels])
            .map(l => {
                const h = _makeStepHandle(Store.addStep(turn, l));
                _liveHandles.push(h);
                return h;
            });

    return {
        // DOM stub — llm-loops references placeholder.div for container context but
        // never reads its contents in the headless / TUI paths.
        div: { style: {}, appendChild: _noop, contains: () => false } as any,

        addThinkingTask: () => {
            const role  = mainAgentRole?.name ?? null;
            const label = role ? `Thinking:${role}` : 'Thinking…';
            return _steps([label])[0];
        },
        addToolStep:    (labels: string | string[]) => _steps(labels),
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
