// step-shared.ts — FreeGent: helpers both agent loops (llm-loops.ts main loop, workers.ts worker
// loop) use after a model step. Native OpenAI-format histories only.
//
// What the two loops share (already extracted elsewhere): tool-call repair (tool-call-repair.ts),
// _runToolCalls, the repeat guard, stuck/env-failure detectors, _checkTextResponse, withRetry and
// _makeOAIRetryHandler (retry.ts), callOAI/callLLM (request building), truncateResultForHistory.
//
// What differs ON PURPOSE (do not "fix" without a benchmark run; each changes agent behaviour):
//   - The main loop writes both the legacy history and the Session event log and supports fn-tag
//     tool formats; workers write one native array plus a throwaway Session.
//   - Only the main loop compresses write-tool arguments to diffs, stubs a result that repeated 3+
//     times (_dupSeen / cycle nudge), prefixes results with [TOOL ERROR]/[EXIT CODE], keeps the
//     read-dedup ledger (_checkRedundantRead), prunes/compacts/repairs history, and enforces the
//     step budget and replace-failure nudges. Workers are short-lived (≤ _WORKER_MAX_STEPS) and
//     read-only by default, so none of that pays for itself; they get their own per-worker
//     seen-file maps instead.
//   - Workers add a step-cap report request and an empty-report fallback; the main loop stops
//     through _gracefulSynthesis.

/** Mark-and-clear: tool results flagged _ranAsBash (shell sent as Python that ran as bash). Returns their call ids. */
export function collectRanAsBash(results: Array<{ tc: { id: string }; result: any }>): Set<string> {
    const ids = new Set<string>();
    for (const r of results) {
        if (!r.result?._ranAsBash) continue;
        delete r.result._ranAsBash;
        ids.add(r.tc.id);
    }
    return ids;
}

/** The call as it actually ran: arguments with language 'bash'. Unparsable arguments are left as sent. */
export function asBashArguments(argsJson: string): string {
    try { return JSON.stringify({ ...JSON.parse(argsJson), language: 'bash' }); } catch { return argsJson; }
}

/** Record those calls as bash in the latest assistant message of a native history, so the model sees what ran. */
export function recordCallsAsBash(history: any[], ids: Set<string>): void {
    if (!ids.size) return;
    const am = [...history].reverse().find((m: any) => m.role === 'assistant' && m.tool_calls?.length);
    if (!am) return;
    am.tool_calls = am.tool_calls.map((tc: any) =>
        ids.has(tc.id) ? { ...tc, function: { ...tc.function, arguments: asBashArguments(tc.function.arguments) } } : tc);
}

/** The last `n` tool calls with their clipped results, one per line — a worker's fallback report. */
export function summarizeRecentToolCalls(history: any[], n = 4): string {
    const results = new Map(history.filter(m => m.role === 'tool').map(m => [m.tool_call_id, String(m.content ?? '')]));
    return history.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls))
        .flatMap(m => m.tool_calls).slice(-n)
        .map(tc => `- ${tc.function?.name}(${String(tc.function?.arguments ?? '').slice(0, 2000)}) → ${(results.get(tc.id) ?? '').slice(0, 4000)}`)
        .join('\n');
}
