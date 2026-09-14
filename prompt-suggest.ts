// prompt-suggest.ts — post-turn prompt suggestion ("what would the user type next").
// Uses callLLMComplete (the shared LLM router) — handles endpoint selection, cooldown,
// model rotation, and retry exactly like all other background LLM calls in the codebase.

// NOTE: Do NOT use "User: X" as the output format here — the context block itself
// contains "User: …" lines and weaker models echo the last one instead of predicting.
// Plain bare-text output avoids that confusion; extraction strips any stray "User:" prefix.
const _INSTRUCTION = `Predict the user's next follow-up message in 1–10 words. Output only the bare message text — no prefix, no label, no explanation.`;

const _PROMPT =
`${_INSTRUCTION}

<context>
{{CONTEXT}}
</context>

${_INSTRUCTION}`;

// Sequence counter: incremented on every turn start and clearSuggestion.
// Results that arrive after _seq has advanced are silently discarded.
let _seq = 0;

// Gather all available context signals: workspace name, recent chat names, current exchange.
async function _buildContext(): Promise<string> {
    const parts: string[] = [];

    // 1. Workspace folder name → project type hint
    try {
        const handle = fsaHandle;
        if (handle?.name) parts.push(`Project: ${handle.name}`);
    } catch {}

    // 2. Recent chat session names → topic breadcrumbs
    try {
        if (typeof getChatList === 'function') {
            const names: string[] = (getChatList() as Array<{ name: string }>)
                .filter(c => c.name && c.name.trim().length > 2)
                .slice(0, 6)
                .map(c => c.name.trim());
            // Skip default/placeholder names ("New Chat") — they add no signal
            const meaningful = names.filter(n => !/^new chat$/i.test(n));
            if (meaningful.length) parts.push(`Recent sessions: ${meaningful.join(' | ')}`);
        }
    } catch {}

    // 3. Current exchange (last user message + last assistant response)
    let hasExchange = false;
    try {
        if (typeof lastExchange === 'function') {
            const ex = lastExchange({ strip: true });
            const userMsg  = (ex.userMsg  ?? '').slice(0, 600).trim();
            const response = (ex.response ?? '').slice(0, 600).trim();
            if (userMsg || response) {
                hasExchange = true;
                if (userMsg)  parts.push(`User: ${userMsg}`);
                if (response) parts.push(`Assistant: ${response}`);
            }
        }
    } catch {}

    // 4. If no exchange yet, look at broader history for topic context
    if (!hasExchange) {
        try {
            if (typeof activeHistory === 'function') {
                const { hist } = activeHistory();
                const userMsgs = (hist as Array<{ role: string; content: string }>)
                    .filter(m => m.role === 'user' && typeof m.content === 'string')
                    .slice(-4)
                    .map(m => (m.content as string).slice(0, 200).trim())
                    .filter(Boolean);
                if (userMsgs.length) parts.push(`Previous messages: ${userMsgs.join(' | ')}`);
            }
        } catch {}
    }

    return parts.join('\n');
}

const _META = /^(the (user|context|assistant|conversation|exchange|following)|this (is|seems|looks|session)|based on|since (there|the)|it (looks|seems|appears)|i (see|notice|would|think|can)|looking at|given the|from the|here'?s?|next message|we (need|have|should|can)|you (need|want|should)|to (predict|generate|output|complete|determine))/i;

export async function generateAndShowSuggestion(): Promise<void> {
    const seq = ++_seq;

    let ctx = await _buildContext();
    if (seq !== _seq) return;
    if (!ctx.trim()) ctx = 'AI coding assistant, no current session context';

    if (typeof callLLMComplete !== 'function') return;
    if (typeof isUtilityDisabled === 'function' && isUtilityDisabled()) return;

    const prompt = _PROMPT.replace('{{CONTEXT}}', ctx);

    // If a utility model is configured, use it exclusively — don't walk the priority list.
    if (typeof utilityEndpoint === 'function') {
        const uep = utilityEndpoint();
        if (uep) {
            let raw = '';
            let _utilityFailed400 = false;
            try {
                raw = await callLLMComplete(prompt, { maxTokens: 40, temperature: 0.4, maxAttempts: 1, label: 'suggest', endpoint: uep });
            } catch (err: any) {
                const _msg = (err?.message ?? '').slice(0, 120);
                const _status = (err as any)?.status ?? 0;
                // HTTP 400: permanent format error (wrong model ID, unsupported parameter, etc.)
                // Fall through to the priority list — the user still gets suggestions.
                // 429/5xx are temporary failures: respect "utility only" and return without fallback.
                if (_status === 400 || /HTTP 400/.test(_msg)) {
                    console.warn('[suggest] utility model HTTP 400 — falling through to priority list:', _msg);
                    _utilityFailed400 = true;
                } else {
                    console.log('[suggest] utility model failed:', _msg);
                    return;
                }
            }
            if (!_utilityFailed400) {
                if (seq !== _seq) return;
                if (raw?.trim()) {
                    const afterUser = raw.replace(/^\s*(?:User|Assistant)\s*:\s*/i, '');
                    const s = afterUser.trim().split('\n')[0].trim()
                        .replace(/^["'`]|["'`]$/g, '')
                        .replace(/[.!?]$/, '')
                        .trim();
                    if (s && s.split(/\s+/).length <= 10 && !_META.test(s)) {
                        _show(s);
                    }
                }
                return; // utility model was used — don't walk priority list even if nothing usable
            }
            // _utilityFailed400 === true: fall through to priority list below
        }
    }

    const list: string[] = getActiveMainModelList?.() ?? [];
    if (!list.length) return;

    // Walk the model list ourselves so content-validation failures fall through to the
    // next model. callLLMComplete only retries on HTTP errors, not on bad content.
    // maxAttempts:1 + explicit endpoint keeps callLLMComplete from rotating internally.
    for (const spec of list) {
        if (seq !== _seq) return;
        const remaining = getCooldownRemaining?.(spec) ?? 0;
        if (remaining > 0) continue;
        const ep = specToEndpoint?.(spec);
        if (!ep) continue;
        let raw = '';
        try {
            raw = await callLLMComplete(prompt, { maxTokens: 40, temperature: 0.4, maxAttempts: 1, label: 'suggest', endpoint: ep });
        } catch (err: any) {
            // withRetry throws immediately on the first error when maxAttempts:1, so the
            // _makeOAIRetryHandler inside callLLMComplete never runs its removal/cooldown
            // logic. Handle permanent and transient failures ourselves so they don't keep
            // getting retried in future suggest rounds.
            const msg: string = err?.message ?? '';
            // 401 Unauthorized, 404 Not Found, 410 Gone — auth rejected or model removed.
            // Pause (not remove) so the model remains visible in the table for user review.
            const isGone   = /HTTP 40[14]|HTTP 410/.test(msg);
            // 5xx — transient server failure; treat like 429 (cooldown), not a permanent remove.
            const isServer = /HTTP 5\d\d|service unavailable|bad gateway/i.test(msg);
            // 429 — rate limited; apply cooldown rather than removing permanently
            const is429    = /HTTP 429|rate.?limit|too many requests/i.test(msg);
            if (isGone && ep.provider !== 'custom') {
                // Pause the model so it is skipped in future turns but stays visible in the
                // model table for the user to manage (resume / remove themselves).
                if (typeof savePausedMainModels === 'function' && typeof getPausedMainModels === 'function') {
                    const _paused = getPausedMainModels();
                    if (!_paused.includes(spec)) {
                        savePausedMainModels([..._paused, spec]);
                    }
                }
                console.log('[suggest] paused (401/404/410):', spec, msg.slice(0, 60));
            } else if ((isServer || is429) && ep.provider !== 'custom') {
                // Transient: mark cooldown so subsequent suggest runs skip this model
                // until the rate-limit window clears.
                const markCooldown = _markCooldown;
                const retryAfterMs = (err as any)?.retryAfterMs ?? null;
                if (typeof markCooldown === 'function') markCooldown(ep, retryAfterMs);
                console.log('[suggest] cooling (5xx/429):', spec);
            }
            continue;
        }
        if (seq !== _seq) return;
        if (!raw?.trim()) continue;
        // Strip stray "User:" / "User: " prefix that some models add despite the instruction.
        const afterUser = raw.replace(/^\s*(?:User|Assistant)\s*:\s*/i, '');
        let s = afterUser.trim().split('\n')[0].trim()
            .replace(/^["'`]|["'`]$/g, '')
            .replace(/[.!?]$/, '')
            .trim();
        if (!s) continue;
        if (s.split(/\s+/).length > 10) continue;
        if (_META.test(s)) continue;
        _show(s);
        return;
    }
    console.log('[suggest] no valid suggestion from any model');
}

function _show(text: string): void {
    if (typeof document !== 'undefined') {
        const el = document.getElementById('agent-input');
        if (el && !(el.textContent ?? '').trim()) {
            el.setAttribute('data-suggestion', text);
        }
    }
    window._tuiSetPromptSuggestion?.(text);
}

export function clearSuggestion(): void {
    ++_seq;
    if (typeof document !== 'undefined') {
        document.getElementById('agent-input')?.removeAttribute('data-suggestion');
    }
    window._tuiSetPromptSuggestion?.('');
}

// Called from the Tab keydown handler in init.ts.
// Returns true when a suggestion was accepted (so the caller can preventDefault).
export function acceptSuggestion(): boolean {
    if (typeof document === 'undefined') return false;
    const el = document.getElementById('agent-input') as HTMLElement | null;
    if (!el) return false;
    const s = el.getAttribute('data-suggestion');
    if (!s) return false;
    el.removeAttribute('data-suggestion');
    el.innerText = s;
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    } catch {}
    _updateSendBtnVisibility?.();
    return true;
}


Object.assign(window, { generateAndShowSuggestion, clearSuggestion, acceptSuggestion });
