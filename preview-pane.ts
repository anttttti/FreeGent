// preview-pane.ts — the sidebar "Preview" entry: one workspace file, shown with the same
// ▶ button of a row in the Project files list (no download / delete).
//
// Which file: the root index.html when there is one; otherwise the utility model picks the most
// presentable file among the workspace files that are not scratch / task / tooling files.

import { agentListFiles, buildFileActions } from './workspace.js';
import { NULL_TASK_HANDLE } from './render-adapter.js';

// Top-level directories that never hold the thing a user wants to preview.
const _SKIP_DIRS = new Set(['tmp', 'temp', 'tasks', 'fg-tasks', 'node_modules', 'dist', 'build', 'memory', 'skills', 'rules', '__pycache__']);
const _MAX_CANDIDATES = 120;

// Workspace file names worth offering as a preview: no scratch/task/tooling directories at any
// depth, no dotfiles, no imported local/ snapshot.
export function previewCandidates(names: string[]): string[] {
    return names.filter(n => {
        const parts = n.split('/').filter(Boolean);
        if (!parts.length || parts[0] === 'local') return false;
        if (parts.some(p => p.startsWith('.'))) return false;
        return !parts.slice(0, -1).some(p => _SKIP_DIRS.has(p));
    });
}

// Root index.html if present, else ask the utility model (via `pick`) to choose among candidates.
// `pick` gets the candidate names and returns the model's raw answer; its answer is only trusted
// when it names a candidate. Falls back to the first HTML file, then null.
export async function selectPreviewFile(
    names: string[],
    pick: ((candidates: string[]) => Promise<string | null | undefined>) | null,
): Promise<string | null> {
    if (names.includes('index.html')) return 'index.html';
    const candidates = previewCandidates(names).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, _MAX_CANDIDATES);
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    if (pick) {
        try {
            const raw = (await pick(candidates))?.trim().split('\n')[0].replace(/^["'`\s-]+|["'`\s]+$/g, '');
            if (raw && candidates.includes(raw)) return raw;
        } catch (e: any) { console.warn('[preview] utility pick failed:', e?.message); }
    }
    return candidates.find(n => /\.html?$/i.test(n)) ?? null;
}

async function _utilityPick(candidates: string[]): Promise<string | null> {
    if (typeof callLLMComplete !== 'function') return null;
    if (typeof isUtilityDisabled === 'function' && isUtilityDisabled()) return null;
    const uep = typeof utilityEndpoint === 'function' ? utilityEndpoint() : null;
    const prompt = `These files are in a project workspace:\n${candidates.join('\n')}\n\n`
        + `Which single file is best to show as the project's preview (the page, app, document or image a user would want to open first)? `
        + `Answer with the exact file path only.`;
    return callLLMComplete(prompt, { endpoint: uep, maxTokens: 40, temperature: 0, maxAttempts: 1, label: 'preview:pick' }, NULL_TASK_HANDLE);
}

// The utility model is asked again only when the candidate list changes.
let _lastSig = '';
let _lastChoice: string | null = null;
let _seq = 0;
let _shown: string | null = null; // file the entry currently shows; a change flashes it once

export async function updateRailPreview(): Promise<void> {
    const el = document.getElementById('rail-preview');
    if (!el) return;
    const seq = ++_seq;
    let names: string[] = [];
    try { names = (await agentListFiles()).filter((f: any) => !f.isLocal).map((f: any) => f.name); } catch { return; }
    const sig = names.includes('index.html') ? 'index.html' : previewCandidates(names).sort().join('\n');
    let choice = _lastChoice;
    if (sig !== _lastSig || (choice && !names.includes(choice))) {
        choice = await selectPreviewFile(names, _utilityPick);
        if (seq !== _seq) return; // a newer refresh superseded this one
        _lastSig = sig; _lastChoice = choice;
    }
    el.innerHTML = '';
    if (!choice) { _shown = null; return; }

    const hdr = document.createElement('div');
    hdr.className = 'rail-preview-hdr';
    hdr.textContent = 'Preview';
    const row = document.createElement('div');
    row.className = 'workspace-file-row rail-preview-row';
    row.dataset.filename = choice;
    row.onclick = e => {
        if ((e.target as HTMLElement).closest('.workspace-file-actions')) return;
        (window as any).openFileTab?.(choice);
    };
    const nameEl = document.createElement('span');
    nameEl.className = 'workspace-file-name';
    nameEl.textContent = choice.split('/').pop() ?? choice;
    nameEl.title = choice;
    row.append(nameEl, buildFileActions(choice, { playOnly: true }));
    el.append(hdr, row);
    if (choice !== _shown) row.classList.add('rail-preview-flash');
    _shown = choice;
}

Object.assign(window, { updateRailPreview });
if (typeof window.addEventListener === 'function') window.addEventListener('load', () => { updateRailPreview(); });
