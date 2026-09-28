// storage-usage.ts — localStorage usage accounting for the top bar, Project panel and Chats list.
//
// Sizes are in characters (key + value): that is what the browsers' ~5M quota counts, so they
// are shown as B/KB/MB against a 5 MB limit, matching the familiar "localStorage is 5 MB" figure.

import { KEYS } from './storage-keys.js';

export const LS_QUOTA = 5_000_000;

export interface StorageUsage {
    total:        number;
    settings:     number;                // everything not attributable to the project or a chat
    project:      number;                // project-scoped keys not tied to one chat (chat list, name, legacy checkpoints)
    checkpoints:  number;                // all checkpoints, including legacy ones without a chatId
    chats:        Map<string, number>;   // chat id → history cache + draft + its checkpoints
}

const _CHAT_KEY_RE  = /^fg_chat_(.+)_(gh|oh|msgs|role|raw|log|run_ckpt)$/;
const _DRAFT_KEY_RE = /^fg_draft_(.+)$/;
const _CKPT_KEY_RE  = /^fg_ckpt_(\d+)$/;

export function computeStorageUsage(): StorageUsage {
    const u: StorageUsage = { total: 0, settings: 0, project: 0, checkpoints: 0, chats: new Map() };
    if (typeof localStorage === 'undefined') return u;
    const addChat = (id: string, n: number) => u.chats.set(id, (u.chats.get(id) || 0) + n);
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k) || '';
        const n = k.length + v.length;
        u.total += n;
        let m: RegExpMatchArray | null;
        if ((m = k.match(_CHAT_KEY_RE)) || (m = k.match(_DRAFT_KEY_RE))) addChat(m[1], n);
        else if (_CKPT_KEY_RE.test(k)) {
            u.checkpoints += n;
            let chatId: string | null = null;
            try { chatId = JSON.parse(v)?.chatId ?? null; } catch {}
            if (chatId) addChat(chatId, n); else u.project += n;
        }
        else if (k === KEYS.CHAT_LIST || k === KEYS.ACTIVE_CHAT || k === KEYS.CKPT_LIST || k === KEYS.PROJECT_NAME) {
            if (k === KEYS.CKPT_LIST) u.checkpoints += n;
            u.project += n;
        }
        else u.settings += n;
    }
    return u;
}

/** Everything a Clear would remove: the project-level keys plus every chat's share. */
export function projectUsage(u: StorageUsage): number {
    let n = u.project;
    for (const v of u.chats.values()) n += v;
    return n;
}

export function fmtStorageSize(n: number): string {
    if (n < 1000)      return `${n} B`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
    return `${(n / 1_000_000).toFixed(2)} MB`;
}

// ── UI refresh ───────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced refresh of the top-bar label and the Project panel line. */
export function refreshStorageUsage(): void {
    if (typeof document === 'undefined' || _timer) return;
    _timer = setTimeout(() => { _timer = null; _renderStorageUsage(); }, 300);
}

function _renderStorageUsage(): void {
    const u   = computeStorageUsage();
    const pct = u.total / LS_QUOTA;
    const top = document.getElementById('ls-usage-label');
    if (top) {
        let chats = 0;
        for (const v of u.chats.values()) chats += v;
        top.textContent = `LS ${Math.round(pct * 100)}%`;
        top.className   = pct >= 0.9 ? 'token-danger' : pct >= 0.7 ? 'token-warn' : '';
        top.title = `localStorage: ${fmtStorageSize(u.total)} of ~${fmtStorageSize(LS_QUOTA)}\n`
            + `Settings: ${fmtStorageSize(u.settings)}\n`
            + `Chats (history cache, drafts, checkpoints): ${fmtStorageSize(chats)}\n`
            + `Checkpoints (all): ${fmtStorageSize(u.checkpoints)}\n`
            + `Project (chat list, name, unassigned checkpoints): ${fmtStorageSize(u.project)}`;
    }
    const proj = document.getElementById('project-storage-usage');
    if (proj) {
        proj.textContent = `localStorage used by this project: ${fmtStorageSize(projectUsage(u))}`
            + ` (checkpoints ${fmtStorageSize(u.checkpoints)}) · total ${fmtStorageSize(u.total)} of ~${fmtStorageSize(LS_QUOTA)}`;
    }
}

if (typeof window !== 'undefined') {
    Object.assign(window, { refreshStorageUsage });
    // Other tabs writing to the same origin change the totals too.
    window.addEventListener?.('storage', refreshStorageUsage);
}
