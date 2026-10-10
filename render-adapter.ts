// render-adapter.ts — Typed interface for the step-graph render surface.
// The browser path supplies createResponsePlaceholder() (chat-render.ts) which
// satisfies this interface.  The headless/bench path supplies NULL_RENDER_ADAPTER
// so runTurn never touches DOM.

export interface TaskHandle {
    setModel(name: string): void;
    setPrompt(text: string): void;
    setRequest(json: string): void;
    setOutput(text: string): void;
    setTokens(inp: number, out?: number): void;
    append(content: string, type: string): void;
    complete(): void;
    abort(): void;
    markCompact(): void;
    markTruncated(reason?: string): void;
}

export interface RenderAdapter {
    // ctx.histLen: length of the chat history this step's model call starts from (the Rerun button's anchor).
    addThinkingTask(ctx?: { histLen?: number }): TaskHandle;
    // opts.main: the calls of the main loop's step; only a lone main call can be rerun from (not parallel ones).
    addToolStep(labels: string[], opts?: { main?: boolean }): TaskHandle[];
    addCompactStep(): TaskHandle;
    addSystemStep(label: string): void;
    finalize(text: string): void;
}

export const NULL_TASK_HANDLE: TaskHandle = {
    setModel: () => {}, setPrompt: () => {}, setRequest: () => {},
    setOutput: () => {}, setTokens: (_inp, _out?) => {}, append: (_c, _t) => {},
    complete: () => {}, abort: () => {}, markCompact: () => {}, markTruncated: (_r?) => {},
};

export const NULL_RENDER_ADAPTER: RenderAdapter = {
    addThinkingTask:  ()       => NULL_TASK_HANDLE,
    addToolStep:      labels   => labels.map(() => NULL_TASK_HANDLE),
    addCompactStep:   ()       => NULL_TASK_HANDLE,
    addSystemStep:    ()       => {},
    finalize:         ()       => {},
};
