// nudge-emitter.ts — FreeGent: central framework nudge emitter.

// All framework guidance injected mid-conversation (agent nudges, skill guidance, etc.)
// goes through emitNudge so history, JSONL log, and DOM render are always in sync.
// Follows the step-validator pattern: ES module, exports, window bridge.

// Framework-injected wrapper tags that should never reach a human reader as literal text —
// the model needs these XML markers, but a person reading the nudge bubble just needs the
// content. Keeps the inner text, drops only the tag delimiters (unlike history-util.js's
// stripInjected(), which drops active_guidance blocks entirely for real user messages).
const _NUDGE_DISPLAY_TAG_RE = /~~~guidance\n?|\n?~~~(?!\w)|<\/?(?:active_guidance|handover_context|relevant_memory)>/g;

export function emitNudge(
    name: string,
    textOrEntry: string | { role: string; content: string },
    opts?: {
        role?: string;
        history?: any[];
        step?: string;
        suppressLog?: boolean;
        suppressRender?: boolean;
        suppressHistory?: boolean;
        appendPartTo?: any[];  // Gemini: push { text } part into this array; caller owns the composite push
    },
): void {
    // B6 fix: role defaults to 'user' rather than reading the globally configured provider.
    // String-form callers that need 'system' (e.g. NVIDIA mid-turn) must pass opts.role explicitly.
    // The main loop's _nudge closure already closes over ep.provider and passes it; duplicating
    // getProvider() here would read the wrong provider after mid-turn rotation.
    const entry: { role: string; content: string } =
        typeof textOrEntry === 'string'
            ? (() => {
                  const role = opts?.role ?? 'user';
                  return {
                      role,
                      content:
                          role === 'user'
                              ? `<nudge>${textOrEntry}</nudge>`
                              : textOrEntry,
                  };
              })()
            : textOrEntry;

    if (opts?.appendPartTo) {
        const raw = typeof textOrEntry === 'string' ? textOrEntry : textOrEntry.content.replace(/<\/?nudge>/g, '');
        opts.appendPartTo.push({ text: raw });
    } else if (!opts?.suppressHistory) {
        const hist =
            opts?.history ??
            (typeof openaiHistory !== 'undefined' ? openaiHistory : null);
        if (hist && Array.isArray(hist)) hist.push(entry);
    }

    if (!opts?.suppressLog && typeof convoLogTurn === 'function') {
        const rawText =
            typeof entry.content === 'string'
                ? entry.content.replace(/<\/?nudge>/g, '')
                : '';
        convoLogTurn({
            type: 'nudge',
            name,
            role: entry.role ?? 'user',
            text: rawText,
            step: opts?.step,
        });
    }

    if (
        !opts?.suppressRender &&
        entry.role === 'user' &&
        (typeof getShowNudges !== 'function' || getShowNudges())
    ) {
        const rawText =
            typeof entry.content === 'string'
                ? entry.content.replace(/<\/?nudge>/g, '').replace(_NUDGE_DISPLAY_TAG_RE, '').trim()
                : '';
        const msgs = typeof document !== 'undefined' ? document.getElementById('agent-messages') : null;
        if (msgs) {
            if (msgs.querySelector('.agent-msg-nudge') && Array.from(msgs.querySelectorAll('.agent-msg-nudge')).some((el) => (el as HTMLElement).dataset?.nudgeName === name)) return;
            const div = document.createElement('div');
            div.className = 'agent-msg agent-msg-nudge';
            div.dataset.nudgeName = name;
            const bubble = document.createElement('div');
            bubble.className = 'agent-msg-bubble agent-msg-bubble-nudge';
            bubble.textContent = `(nudge) ${rawText}`;
            div.appendChild(bubble);
            msgs.appendChild(div);
            msgs.scrollTop = msgs.scrollHeight;
        }
    }
}

Object.assign(window, { emitNudge });
