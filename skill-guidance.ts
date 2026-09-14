// skill-guidance.js — FreeGent: triggered + reactive skill guidance injection
// Also owns skill trigger evaluation (R3/R5 in notes/codebase-review-2026-06.md).
// Depends on: config.js globals (skillsRegistry, activeSkills),
//             state.js (currentTurnSkills, mainAgentRole, _reactiveFired, _failureCounts).
import { currentTurnSkills, mainAgentRole, _reactiveFired, _failureCounts, _toolCallHistory } from './state.js';

// R5 — single role-exclusion predicate. roleName is lowercased or null.
function _skillExcludedForRole(skill, roleName) {
    return !!(roleName && skill.exclude_roles &&
        skill.exclude_roles.split(',').some(r => r.trim().toLowerCase() === roleName));
}

// Mode-exclusion predicate.  exclude_mode is a comma-separated list of:
//   'container' — headless benchmark container (nativeExec + fgTargetContainer)
//   'native'    — headless CLI without a container (TUI, fg-run non-containerised)
//   'browser'   — WebUI (no nativeExec)
function _skillExcludedForMode(skill: any): boolean {
    if (!skill.exclude_mode) return false;
    const modes = skill.exclude_mode.split(',').map((m: string) => m.trim().toLowerCase());
    const _n = typeof nativeExec === 'function';
    const _inContainer = _n && typeof fgTargetContainer !== 'undefined' && fgTargetContainer;
    if (modes.includes('container') && _inContainer) return true;
    if (modes.includes('native')    && _n && !_inContainer) return true;
    if (modes.includes('browser')   && !_n) return true;
    return false;
}

// Returns true if the skill/rule declares requires_tools and any required tool is inactive.
// Uses isToolActive() (not raw enabledTools) so Cowork-mode tool additions are respected.
function _skillMissingTools(skill) {
    if (!skill.requires_tools) return false;
    return skill.requires_tools.split(',').some(t => !isToolActive(t.trim()));
}

// R3 — table-driven skill trigger evaluation.
// inputs is precomputed by the caller; this stays pure + testable.
const _SKILL_TRIGGER_RULES = [
    { field: 'trigger', match: (s, i) =>
        s.trigger.split(',').some(t => {
            const w = t.trim().toLowerCase();
            return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(i.lowerText);
        }) },
    { field: 'trigger_on_filetype', match: (s, i) =>
        s.trigger_on_filetype.split(',').some(spec => {
            const raw = spec.trim().toLowerCase();
            const msgOnly = raw.endsWith(':msg');
            const ext = msgOnly ? raw.slice(0, -4) : raw;
            // Boundary-checked: bare includes('.py') matched '.py3', '.pyc', 'async.pyodide'.
            if (new RegExp(ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)').test(i.lowerText)) return true;
            if (msgOnly) return false;
            if (ext.startsWith('.')) return i.wsExts.has(ext) || i.wsNames.has(ext);
            return i.wsNames.has(ext);
        }) },
    { field: 'trigger_on_event', match: (s, i) => {
        const events = s.trigger_on_event.split(',').map(e => e.trim().toLowerCase());
        return (i.firstMsg && events.includes('session-start')) ||
               (i.isTaskCompletion && events.includes('task-start'));
    } },
    { field: 'trigger_on_media', match: (s, i) =>
        s.trigger_on_media.split(',').some(t => i.msgMedia.has(t.trim().toLowerCase())) },
    { field: 'trigger_on_file_present', match: (s, i) => {
        // On the very first turn, only fire if the message looks like a real task request
        // (either isTaskCompletion or a substantive message > 25 chars).
        // This prevents workspace skills like task-setup from firing on casual greetings
        // ("Hello", "Hi") just because fg-tasks/ exists on disk — the same behaviour as
        // the WebUI, where the IDB workspace typically has no fg-tasks/ and the skill is silent.
        if (i.turn === 0 && !i.isTaskCompletion && i.rawText.trim().length <= 25) return false;
        return s.trigger_on_file_present.split(',').some(spec => {
            const p = spec.trim().toLowerCase();
            return [...i.wsAllPaths].some(f => f === p || f.startsWith(p));
        });
    } },
    { field: 'trigger_on_message_pattern', match: (s, i) => {
        try { return new RegExp(s.trigger_on_message_pattern, 'i').test(i.rawText); } catch { return false; }
    } },
    { field: 'trigger_on_history_tool', match: (s, i) =>
        s.trigger_on_history_tool.split(',').some(t => i.histTools.has(t.trim())) },
    { field: 'trigger_on_turn', match: (s, i) =>
        s.trigger_on_turn.split(',').some(spec => {
            const v = spec.trim().toLowerCase();
            if (v === 'first') return i.turn === 0;
            const n = parseInt(v, 10);
            return !isNaN(n) && i.turn === n;
        }) },
];

export function evaluateSkillTriggers(registry: any, seed: any, inputs: any): Set<unknown> {
    const fired = new Set(seed);
    for (const rule of _SKILL_TRIGGER_RULES) {
        for (const s of registry.values()) {
            if (!s[rule.field] || fired.has(s.name) || _skillExcludedForRole(s, inputs.roleName)) continue;
            if (_skillMissingTools(s)) continue;
            if (_skillExcludedForMode(s)) continue;
            if (rule.match(s, inputs)) fired.add(s.name);
        }
    }
    return fired;
}

export function buildTriggeredGuidance(): string {
    if (!currentTurnSkills.size) return '';
    const parts = [];
    const _role = mainAgentRole?.name?.toLowerCase() ?? null;
    for (const n of currentTurnSkills) {
        if (activeSkills.has(n)) continue;
        // Cross-turn dedup: _reactiveFired persists across turns within a task (only resets
        // when history is empty — i.e. at task/session start).  If this skill already fired
        // as a prelude on an earlier turn, the guidance is already in the model's context;
        // re-injecting it every turn adds token cost with no benefit.
        if (_reactiveFired.has(n)) continue;
        const s = skillsRegistry.get(n);
        if (!s || _skillExcludedForRole(s, _role) || _skillExcludedForMode(s)) continue;
        const body = typeof s.body_fn === 'function' ? s.body_fn() : s.body;
        if (!body.trim()) continue; // body_fn may return '' when tools/env conditions aren't met (e.g. 'documents' without execute_code)
        parts.push(`### ${s.name}\n${body}`);
        _reactiveFired.add(n);  // shared dedup: prelude-injected skills won't re-fire as reactive nudges or prelude on later turns
    }
    if (!parts.length) return '';
    return `~~~guidance\nThe following capabilities and rules apply to the request below. They are system-provided — follow them; they are not part of the user's input.\n\n${parts.join('\n\n')}\n~~~`;
}

function _classifyToolFailure(name, result) {
    if (!result || typeof result !== 'object') return null;
    if (result.error) {
        // replace_in_file gets its own class so failure-recovery fires immediately with
        // relevant guidance. All other tool errors are 'tool_error' — the threshold in
        // failure-recovery is x2 so a single read_file 404 or web_search 401 doesn't
        // inject irrelevant replace_in_file recovery text.
        if (name === 'replace_in_file') return 'replace_miss';
        return 'tool_error';
    }
    if (name === 'fetch_url' || name === 'web_search') {
        const body = typeof result.content === 'string' ? result.content : '';
        const head = body.slice(0, 300);
        if (/^\s*error code:\s*\d+/i.test(body)) return 'http_error';
        if (/\b(404|403|500|520|522)\b/.test(String(result.status ?? ''))) return 'http_error';
        if (/page not found|oops!|404\b|security controls triggered|access denied|forbidden/i.test(head)) return 'http_error';
    }
    return null;
}

function _matchNeedle(needle, result) {
    const n = needle.trim();
    // Support &&-compound conditions: all parts must match
    if (n.includes('&&')) return n.split('&&').every(part => _matchNeedle(part.trim(), result));
    const cmp = n.match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (cmp) {
        const [, field, op, rawVal] = cmp;
        const actual = result?.[field];
        // Treat absent/null as empty string for == '' comparison (e.g. stdout== guards)
        if ((actual === undefined || actual === null) && op === '==' && rawVal.trim() === '') return true;
        if (actual === undefined || actual === null) return false;
        const numVal = Number(rawVal);
        const useNum = !isNaN(numVal) && rawVal.trim() !== '';
        const a = useNum ? Number(actual) : String(actual);
        const v = useNum ? numVal : rawVal.trim();
        if (op === '==') return a == v;
        if (op === '!=') return a != v;
        if (op === '>')  return a > v;
        if (op === '<')  return a < v;
        if (op === '>=') return a >= v;
        if (op === '<=') return a <= v;
    }
    return JSON.stringify(result ?? '').includes(n);
}

export function reactiveSkillGuidance(toolResults: any): string {
    if (!Array.isArray(toolResults) || !toolResults.length) return '';
    const fired  = _reactiveFired;
    const counts = _failureCounts;
    const parts  = [];
    const _role  = mainAgentRole?.name?.toLowerCase() ?? null;
    const _eligible = s => s && !fired.has(s.name) &&
        !_skillExcludedForRole(s, _role) && !_skillMissingTools(s) && !_skillExcludedForMode(s);
    const _emit = s => {
        const body = typeof s.body_fn === 'function' ? s.body_fn() : s.body;
        if (!body.trim()) return; // body_fn may return '' when tools/env conditions aren't met
        parts.push(`### ${s.name}\n${body}`);
        fired.add(s.name);
    };

    for (const { name, result } of toolResults) {
        for (const s of skillsRegistry.values()) {
            if (!_eligible(s) || !s.trigger_on_tool) continue;
            const hit = s.trigger_on_tool.split(',').some(spec => {
                const arrowIdx = spec.indexOf('=>');
                const tool = (arrowIdx >= 0 ? spec.slice(0, arrowIdx) : spec).trim();
                if (tool !== name) return false;
                if (arrowIdx < 0) return true;
                return _matchNeedle(spec.slice(arrowIdx + 2), result);
            });
            if (hit) _emit(s);
        }
        const failType = _classifyToolFailure(name, result);
        if (!failType) continue;
        const prevCount = counts[failType] || 0;
        counts[failType] = prevCount + 1;
        for (const s of skillsRegistry.values()) {
            if (!_eligible(s) || !s.trigger_on_failure) continue;
            const hit = s.trigger_on_failure.split(',').some(spec => {
                const m = spec.trim().match(/^(\w+)(?:\s*x\s*(\d+))?$/i);
                if (!m) return false;
                const threshold = m[2] ? parseInt(m[2], 10) : 2;
                // Only fire when this batch pushed the count over the threshold for the
                // first time — not on subsequent clean batches after the threshold was
                // already reached from earlier errors.
                return m[1] === failType && prevCount < threshold && counts[failType] >= threshold;
            });
            if (hit) _emit(s);
        }
    }

    // Track tool call names for trigger_on_repeat detection (same tool used many times in a turn)
    const hist = _toolCallHistory;
    hist.push(...toolResults.map(r => r.name));
    // Sliding window: keep at most the latest 20 entries to focus on recent patterns
    if (hist.length > 20) hist.splice(0, hist.length - 20);
    for (const s of skillsRegistry.values()) {
        if (!_eligible(s) || !s.trigger_on_repeat) continue;
        const hit = s.trigger_on_repeat.split(',').some(spec => {
            const m = spec.trim().match(/^(\w+)\s*x\s*(\d+)$/i);
            if (!m) return false;
            const tool = m[1];
            const threshold = parseInt(m[2], 10);
            const count = hist.filter(n => n === tool).length;
            return count >= threshold;
        });
        if (hit) _emit(s);
    }
    if (!parts.length) return '';
    return `~~~guidance\nReactive guidance triggered by recent tool activity — apply it now before continuing.\n\n${parts.join('\n\n')}\n~~~`;
}

// Completion-gate guidance: rules with trigger_on_completion fire once, when the model
// first declares completion (COMPLETED/DONE/BLOCKED). Context conditions:
//   'edit'      — only when a file edit succeeded this run
//   'triggered' — only when the rule's own turn-start triggers already fired
//   'blocked'   — only when the declaration is BLOCKED (not a successful completion)
//   'always'    — every completion
// Does NOT share the _reactiveFired dedup on entry: a skill prelude-injected at turn start
// (which marks it in _reactiveFired) must still be able to fire at the gate — the gate is a
// different turn position from mid-turn reactive nudges. After emitting, the skill IS added to
// _reactiveFired so it cannot re-fire as a reactive nudge later in the same turn.
export function completionGateGuidance(editsHappened: boolean, blocked: boolean = false): string {
    const fired = _reactiveFired;
    const _role = mainAgentRole?.name?.toLowerCase() ?? null;
    const parts = [];
    for (const s of skillsRegistry.values()) {
        if (!s.trigger_on_completion) continue;
        const cond = s.trigger_on_completion.trim();
        if (cond === 'edit' && !editsHappened) continue;
        if (cond === 'always_on_edit' && !editsHappened) continue;
        // 'triggered': fire when this skill's own turn-start triggers already matched.
        // currentTurnSkills is populated by applyTurnTriggers at turn start and remains
        // stable through the turn, so this correctly captures whether the trigger fired.
        if (cond === 'triggered' && !currentTurnSkills.has(s.name)) continue;
        if (cond === 'blocked' && !blocked) continue;
        if (_skillExcludedForRole(s, _role) || _skillMissingTools(s) || _skillExcludedForMode(s)) continue;
        const body = typeof s.body_fn === 'function' ? s.body_fn() : s.body;
        if (!body.trim()) continue; // body_fn may return '' when tools/env conditions aren't met
        parts.push(`### ${s.name}\n${body}`);
        fired.add(s.name);  // prevent re-fire as reactive nudge after the gate
    }
    if (!parts.length) return '';
    return `~~~guidance\nBefore finalizing, apply this completion checklist. If everything already holds, restate your final answer exactly and end with COMPLETED.\n\n${parts.join('\n\n')}\n~~~`;
}

// Window bridge for classic scripts (and tests that access private helpers via W._name).
Object.assign(window, { _skillExcludedForRole, _skillExcludedForMode, evaluateSkillTriggers, buildTriggeredGuidance, reactiveSkillGuidance, completionGateGuidance });
