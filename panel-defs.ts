// panel-defs.ts — Platform-agnostic UI definitions for FreeGent panels.
//
// A PanelDef describes WHAT is in a panel: sections, fields, types, options,
// and the localStorage key that stores each value.  It contains NO rendering
// code.  Platform renderers translate it into their native primitives:
//
//   WebUI  → settings-ui.ts  renderPanelSection() → HTML <input>/<select>/…
//   TUI    → tui-app.tsx     <SettingsPanel>       → Ink <Text> / <Box>
//
// The same localStorage key space (fg_*) is shared between both platforms,
// so any value written by the WebUI is immediately visible to the TUI and
// vice-versa.

// ── Field types ───────────────────────────────────────────────────────────────

export interface NumberField {
    kind:        'number';
    key:         string;           // localStorage key (fg_*)
    label:       string;
    placeholder?: string;          // shown when value is empty (= using default)
    min?:        number;
    max?:        number;
    step?:       number;
}

export interface SelectField {
    kind:    'select';
    key:     string;
    label:   string;
    options: Array<{ value: string; label: string }>;
}

export interface TextField {
    kind:        'text';
    key:         string;
    label:       string;
    placeholder?: string;
    secret?:     boolean;          // render as password in WebUI; masked in TUI
}

export interface ToggleField {
    kind:        'toggle';
    key:         string;
    label:       string;
    description?: string;
}

export interface HeadingField { kind: 'heading'; text: string }
export interface HintField    { kind: 'hint';    text: string }

export type FieldDef =
    | NumberField | SelectField | TextField | ToggleField
    | HeadingField | HintField;

// ── Section / panel containers ────────────────────────────────────────────────

export interface SectionDef {
    title?:  string;
    hint?:   string;
    fields:  FieldDef[];
}

export interface PanelDef {
    id:       string;
    title:    string;
    sections: SectionDef[];
}

// Helper: extract all fields that have a localStorage key
export function keyedFields(panel: PanelDef): Array<FieldDef & { key: string }> {
    return panel.sections
        .flatMap(s => s.fields)
        .filter((f): f is FieldDef & { key: string } => 'key' in f);
}

// ── Settings panel definition ─────────────────────────────────────────────────
// Covers the settings accessible to both WebUI and TUI.
// Complex WebUI-only UI (drag-to-reorder model list, file pickers, role editors)
// is still in settings-ui.ts / index.html and is NOT mirrored here — the schema
// is for the "form-like" settings that map cleanly to a key → value pair.

export const SETTINGS_DEF: PanelDef = {
    id:    'settings',
    title: 'Settings',
    sections: [
        {
            title: 'Sampling',
            hint:  'Override LLM sampling parameters. Leave empty to use the provider default.',
            fields: [
                { kind: 'number', key: 'fg_temperature', label: 'Temperature', placeholder: '0.6',  min: 0, max: 2,   step: 0.05 },
                { kind: 'number', key: 'fg_top_p',       label: 'Top P',       placeholder: '0.95', min: 0, max: 1,   step: 0.05 },
                { kind: 'number', key: 'fg_top_k',       label: 'Top K',       placeholder: '20',   min: 0, max: 200, step: 1    },
            ],
        },
        {
            title: 'Agent',
            fields: [
                {
                    kind: 'select', key: 'fg_retry_mode', label: 'Retry mode',
                    options: [
                        { value: 'exponential', label: 'Exponential backoff (default)' },
                        { value: 'fixed-30s',   label: 'Fixed 30 s' },
                        { value: 'fixed-2m',    label: 'Fixed 2 min' },
                        { value: 'fixed-5m',    label: 'Fixed 5 min' },
                    ],
                },
                { kind: 'number', key: 'fg_agent_compact_tokens', label: 'Compact at (tokens)',   placeholder: '0 = off' },
                { kind: 'number', key: 'fg_agent_max_rounds',     label: 'Max steps / turn',      placeholder: '100', min: 1, max: 500, step: 1 },
                {
                    kind: 'select', key: 'fg_intent_validation', label: 'Intent validation',
                    options: [
                        { value: 'off',       label: 'Off' },
                        { value: 'heuristic', label: 'Heuristic (default)' },
                        { value: 'llm',       label: 'LLM-based' },
                    ],
                },
                {
                    kind: 'select', key: 'fg_tool_approval', label: 'Tool approval',
                    options: [
                        { value: 'off',  label: 'Off (default)' },
                        { value: 'high', label: 'High-risk only (delete, execute)' },
                        { value: 'all',  label: 'All writes' },
                    ],
                },
            ],
        },
        {
            title: 'Search',
            fields: [
                {
                    kind: 'select', key: 'fg_search_provider', label: 'Search provider',
                    options: [
                        { value: 'auto',      label: 'Auto (Tavily → Brave → Wikipedia)' },
                        { value: 'tavily',    label: 'Tavily' },
                        { value: 'brave',     label: 'Brave' },
                        { value: 'wikipedia', label: 'Wikipedia only' },
                    ],
                },
            ],
        },
        {
            title: 'Context',
            fields: [
                { kind: 'toggle', key: 'fg_agent_proactive_compact', label: 'Proactive compaction',
                  description: 'Compact history before hitting the hard context limit.' },
                { kind: 'toggle', key: 'fg_agent_tool_result_truncation', label: 'Tool result truncation',
                  description: 'Cap tool results stored in history to avoid context bloat.' },
                { kind: 'number', key: 'fg_agent_max_tool_result',    label: 'Max result size — workers (chars)',    placeholder: '8000'  },
                { kind: 'number', key: 'fg_director_max_tool_result', label: 'Max result size — main agent (chars)', placeholder: '20000' },
            ],
        },
        {
            title: 'Workers',
            fields: [
                { kind: 'toggle', key: 'fg_agent_lean_workers',     label: 'Lean worker context' },
                { kind: 'toggle', key: 'fg_agent_worker_history',   label: 'Director workers fork the full context' },
                { kind: 'toggle', key: 'fg_agent_worker_reduce',    label: 'Worker output reduce' },
                { kind: 'toggle', key: 'fg_agent_role_model_routing', label: 'Role model routing' },
                {
                    kind: 'select', key: 'fg_agent_max_delegation_depth', label: 'Max delegation depth',
                    options: [
                        { value: '0', label: '0 — disabled' },
                        { value: '1', label: '1 — one level' },
                        { value: '2', label: '2 — two levels' },
                    ],
                },
            ],
        },
    ],
};

// ── WebUI renderer ────────────────────────────────────────────────────────────
// Call renderPanelSection(section, container) from settings-ui.ts to generate
// the HTML form elements for any SectionDef driven by SETTINGS_DEF.
// The produced elements write directly to localStorage via the shared key.
//
// Usage example (settings-ui.ts):
//
//   import { SETTINGS_DEF, renderPanelSection } from './panel-defs.js';
//   // Inside populateSettingsForm():
//   const agentSection = SETTINGS_DEF.sections.find(s => s.title === 'Agent');
//   renderPanelSection(agentSection, document.getElementById('agent-settings-auto'));

export function renderPanelSection(section: SectionDef, container: HTMLElement): void {
    container.innerHTML = '';

    for (const field of section.fields) {
        if (field.kind === 'heading') {
            const el = document.createElement('span');
            el.className = 'settings-label';
            el.textContent = field.text;
            container.appendChild(el);
            continue;
        }
        if (field.kind === 'hint') {
            const el = document.createElement('p');
            el.className = 'settings-hint';
            el.textContent = field.text;
            container.appendChild(el);
            continue;
        }

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';

        const lbl = document.createElement('label');
        lbl.className = 'settings-input-label';
        lbl.style.cssText = 'min-width:180px;margin:0';
        lbl.textContent = field.label;
        row.appendChild(lbl);

        if (field.kind === 'toggle') {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = localStorage.getItem(field.key) === 'true';
            cb.onchange = () => localStorage.setItem(field.key, String(cb.checked));
            lbl.prepend(cb, ' ');
            container.appendChild(lbl);
            if (field.description) {
                const hint = document.createElement('p');
                hint.className = 'settings-hint agent-hint';
                hint.textContent = field.description;
                container.appendChild(hint);
            }
            continue;
        }

        if (field.kind === 'select') {
            const sel = document.createElement('select');
            sel.className = 'settings-input';
            const current = localStorage.getItem(field.key) ?? '';
            for (const opt of field.options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                if (opt.value === current) o.selected = true;
                sel.appendChild(o);
            }
            sel.onchange = () => localStorage.setItem(field.key, sel.value);
            row.appendChild(sel);
        } else if (field.kind === 'number') {
            const inp = document.createElement('input');
            inp.className = 'settings-input';
            inp.type = 'number';
            inp.style.width = '100px';
            if (field.min  != null) inp.min  = String(field.min);
            if (field.max  != null) inp.max  = String(field.max);
            if (field.step != null) inp.step = String(field.step);
            if (field.placeholder) inp.placeholder = field.placeholder;
            inp.value = localStorage.getItem(field.key) ?? '';
            inp.oninput = () => {
                if (inp.value === '') localStorage.removeItem(field.key);
                else localStorage.setItem(field.key, inp.value);
            };
            row.appendChild(inp);
        } else if (field.kind === 'text') {
            const inp = document.createElement('input');
            inp.className = 'settings-input';
            inp.type = field.secret ? 'password' : 'text';
            if (field.placeholder) inp.placeholder = field.placeholder;
            inp.value = localStorage.getItem(field.key) ?? '';
            inp.onchange = () => localStorage.setItem(field.key, inp.value);
            row.appendChild(inp);
        }

        container.appendChild(row);
    }
}
