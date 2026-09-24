// history-util.js — FreeGent: shared helpers for reading the active conversation history
import { lastProvider, openaiHistory } from './state.js';

// The active conversation history in OAI format.
export function activeHistory(): { hist: any[] } {
    return { hist: openaiHistory as any[] };
}

// Plain visible text of a message (thoughts excluded). '' if none.
export function msgText(m: any): any {
    return typeof m.content === 'string' ? m.content : '';
}

// Strip injected framework blocks (guidance / handover / relevant-memory / project
// instructions from AGENTS.md) from a user message.
const _HU_INJECTED_RE = /~~~guidance\n[\s\S]*?\n~~~\n*|<(active_guidance|handover_context|relevant_memory|project_instructions)>[\s\S]*?<\/\1>\n*/g;
export function stripInjected(s: any): any { return (s || '').replace(_HU_INJECTED_RE, '').trim(); }

// True when m is a real user turn — plain text, not tool results, not a framework <nudge> nudge.
// <tool_response> is the text-tag tool-calling path's synthetic result message (llm-loops.js
// pushes it as role:'user' since some models/providers only support system at turn 0) — it's
// framework-injected, not something the human typed, same as <nudge>.
export function isRealUserMessage(m: any): boolean {
    if (m.role !== 'user') return false;
    if (typeof m.content !== 'string') return false;
    return !!m.content && !m.content.startsWith('<nudge>') && !m.content.startsWith('<tool_response>');
}

// The last assistant response and the real user message before it, as full text.
// { strip } removes injected framework blocks from the user message (default on).
export function lastExchange({ strip = true }: { strip?: boolean | undefined; } | undefined = {}): { userMsg: string; response: string; } {
    const { hist } = activeHistory();
    let userMsg = '', response = '';
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (!response) {
            if (m.role === 'assistant') { const t = msgText(m); if (t) response = t; }
        } else if (isRealUserMessage(m)) {
            let t = typeof m.content === 'string' ? m.content : '';
            if (strip) t = stripInjected(t);
            if (t) { userMsg = t; break; }
        }
    }
    return { userMsg, response };
}

// Safe JSON.parse for LLM tool-call argument strings — returns {} on failure.
// Shared between llm-loops.ts and workers.ts to avoid duplicating a one-liner.
export function parseArgs(s: string): any {
    try { return JSON.parse(s); } catch { return {}; }
}

// Window bridge: classic scripts access these as globals until they are converted to modules.
Object.assign(window, { activeHistory, msgText, stripInjected, isRealUserMessage, lastExchange });
