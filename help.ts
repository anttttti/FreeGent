// help.ts — the help button in the top-right corner. It opens a popover that explains the view being shown, with a link to that
// view's page of the documentation (a new browser tab), and, in Chat, Project, Chats, Tasks and Settings, a "Show me around" spotlight tour of
// that view (each step dims the page and cuts a hole around the part it explains). The Chat tour ends on the help button itself.
// First load: the Chat popover opens by itself once, without taking focus, with "Don't show again" ticked; it is kept in
// fg_intro_seen when the popover closes. Unticked, it shows again on the next load.
import { KEYS } from './storage-keys.js';
import { canOfferGuestQuota } from './guest-quota.js';

const DOCS = 'https://freegent.ai/docs/webui/';
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const visible = (el: HTMLElement | null) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
const openSettings = () => { closeTour(); closeHelp(); (window as any).activateTab?.('settings'); };

// ── Help text per view ───────────────────────────────────────────────────────

interface Page { title: string; points: string[]; doc: string }
const PAGES: Record<string, Page> = {
    chat: { title: 'Chat', doc: 'chats/', points: [
        'Describe a task or ask a question. <b>Enter</b> sends, <b>Shift+Enter</b> adds a line, <b>Esc</b> stops.',
        'Attach files with the paperclip or speak with the mic. A message sent while the agent works waits in a queue.',
        'The toolbar shows the active model and how much of its context is used. Click the model to change it.',
        '<b>Chat</b> mode is a normal conversation; <b>Cowork</b> adds task tracking on a board.',
    ] },
    workspace: { title: 'Project', doc: 'project/', points: [
        'The agent\'s workspace: everything it reads, writes or runs is here, with an editor and previews.',
        'Files live in this browser until you clear site data. <b>Export</b> a project before you do, and use <b>Save / Load</b> to keep several.',
        'Drop files to upload them. Where the browser allows it, you can attach a folder from your disk; it appears under <code>local/</code>.',
    ] },
    tasks: { title: 'Tasks', doc: 'tasks', points: [
        'A board of small jobs the agent works through. To create tasks, ask in Chat: "add tasks: …".',
        '<b>Run</b> works on the next task in To do. <b>Autopilot</b> keeps going, one chat per task, until none are left.',
        'Moving a card to another column changes the task\'s status. Each task is a Markdown file in <code>fg-tasks/</code>.',
    ] },
    chats: { title: 'Chats', doc: 'chats/', points: [
        'Every conversation is saved with its own history, model and workspace snapshot. Click one to open it.',
        '<b>Ctrl/Cmd+K</b> searches chat titles and <b>Ctrl/Cmd+Shift+F</b> searches the text of all your chats.',
    ] },
    settings: { title: 'Settings', doc: 'settings', points: [
        '<b>Credentials</b> comes first: keys for model providers, search and tools. They stay in this browser and never go into a profile.',
        '<b>Models</b> orders providers and fallbacks, <b>Privacy</b> sets where requests may go, and <b>Profiles</b> saves a whole setup.',
        '<b>Agent</b>, <b>Skills</b>, <b>Tools</b>, <b>MCP</b>, <b>Roles</b> and <b>Voice</b> shape what the agent does and which tools it may call.',
    ] },
};

const TOUR_VIEWS = ['chat', 'workspace', 'chats', 'tasks', 'settings'];
const activeView = () => (q('#tab-content .tab-panel.active') as HTMLElement | null)?.dataset.panel || '';

// ── The popover ──────────────────────────────────────────────────────────────

let firstLoad = false;     // the popover was opened by itself on first load: it has "Don't show again"
let shownFor = '';

const popover = () => document.getElementById('fg-help-pop');

function placeHelp() {   // the first-load popover has no focus to lose, so it never covers the input: it sits under the button
    const pop = popover(); if (!pop) return;
    pop.style.maxWidth = Math.min(360, window.innerWidth - 24) + 'px';
}

export function closeHelp(): void {
    const pop = popover();
    if (!pop) return;
    if (firstLoad) { try { if ((pop.querySelector('.fg-help-dont') as HTMLInputElement | null)?.checked) localStorage.setItem(KEYS.INTRO_SEEN, '1'); } catch {} }
    pop.remove();
    firstLoad = false;
    shownFor = '';
    q('#help-btn')?.setAttribute('aria-expanded', 'false');
}

function openHelp(auto = false): void {
    const view = activeView();
    const page = PAGES[view];
    if (!page || popover()) return;
    firstLoad = auto;
    shownFor = view;
    const hosted = canOfferGuestQuota();
    const intro = auto && view === 'chat'
        ? `<p><b>Welcome to FreeGent</b>, an AI agent that runs in your browser: it reads and writes project files, runs code and searches the web.
           ${hosted ? '<b>No key needed to start:</b> send a message and choose <b>Use the guest quota</b>, shared free-tier accounts with a daily limit for each network.'
                    : 'Add an API key, or connect a local model, to send your first message.'}
           For more models and no guest limit, add your own key in <b>Settings → Credentials</b>.</p>` : '';
    const pop = document.createElement('div');
    pop.id = 'fg-help-pop';
    pop.className = 'fg-modal';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'fg-help-title');
    pop.innerHTML = `<div class="fg-modal-header"><span class="fg-modal-title" id="fg-help-title">${page.title}</span>
        <button class="fg-modal-close" aria-label="Close help" data-act="close">✕</button></div>
        <div class="fg-modal-body">${intro}<ul class="fg-help-list">${page.points.map(p => `<li>${p}</li>`).join('')}</ul>
        ${auto ? '<label class="fg-modal-check-label"><input type="checkbox" class="fg-help-dont" checked> Don\'t show again</label>' : ''}</div>
        <div class="fg-modal-btns">
          <a class="fg-help-doc" href="${DOCS}${page.doc}" target="_blank" rel="noopener">Full documentation ↗</a>
          ${TOUR_VIEWS.includes(view) ? '<button class="fg-modal-btn fg-modal-btn-cancel" data-act="tour">Show me around</button>' : ''}
          ${auto ? '<button class="fg-modal-btn fg-modal-btn-ok" data-act="close">Got it</button>' : ''}</div>`;
    pop.addEventListener('click', e => {
        const act = ((e.target as HTMLElement).closest('[data-act]') as HTMLElement | null)?.dataset.act;
        if (act === 'close') closeHelp();
        else if (act === 'tour') { const v = shownFor; closeHelp(); startTour(v); }
    });
    document.body.appendChild(pop);
    placeHelp();
    q('#help-btn')?.setAttribute('aria-expanded', 'true');
    if (!auto) (pop.querySelector('.fg-modal-close') as HTMLElement).focus();   // opened by the reader: keyboard users land in it
}

export function toggleHelp(): void { if (popover()) closeHelp(); else openHelp(); }

/** First load: the Chat help opens once, unless it was dismissed for good, something else is open, or the page is the OpenRouter return. */
export function maybeShowHelp(): void {
    try { if (localStorage.getItem(KEYS.INTRO_SEEN)) return; } catch { return; }   // no storage: it could never be dismissed, so never show it
    if (document.querySelector('.fg-modal-overlay') || document.body.classList.contains('preview-mode')) return;
    if (new URLSearchParams(location.search).has('code')) return;   // back from Connect OpenRouter: the Credentials result is the page to see
    if (activeView() !== 'chat') return;
    openHelp(true);
}

// ── The spotlight tour ───────────────────────────────────────────────────────

interface Step {
    sel: string[];
    /** Boxed instead when none of `sel` is on screen. */
    fallback?: string[];
    title: string;
    html: string;
    place?: ('bottom' | 'top' | 'right' | 'left')[];
    action?: { label: string; run: () => void };
    /** Runs before the step is measured: opens the Settings tab the step is about. */
    enter?: () => void;
}

let steps: Step[] = [];
let idx = -1;
let prevFocus: HTMLElement | null = null;
const TOUR = 'fg-tour';
const tourEl = () => document.getElementById(TOUR);

const settingsTab = (tab: string) => () => (window as any).switchSettingsTab?.(tab);
const stab = (tab: string) => `.settings-tab-btn[data-tab="${tab}"]`;

/** One tour per view that has one. The Chat tour ends on the help button, which is where the others start. */
function buildTours(): Record<string, Step[]> {
    const hosted = canOfferGuestQuota();
    return {
        chat: [
            { sel: ['.chat-input-area'], place: ['top', 'bottom'], title: 'Ask for something',
              html: 'Describe a task or ask a question. Attach files with the paperclip, speak with the mic, and keep typing while it works: messages queue up.' },
            { sel: ['.hdr-model-display-wrap'], fallback: ['#input-model-btn'], place: ['bottom', 'top'], title: 'The model',
              html: `${hosted ? 'You start on the guest models. ' : ''}Click the model name to change models or add providers. Your own keys under <b>Settings → Credentials</b> are always used before the guest quota.` },
            { sel: ['#hdr-mode'], place: ['bottom', 'top'], title: 'Chat or Cowork',
              html: '<b>Chat</b> is a normal conversation. <b>Cowork</b> adds task tracking on a kanban board, and Autopilot can work through the tasks for you.' },
            { sel: ['.left-rail [onclick^="newChat"]', '.rail-nav-btn[data-tab="workspace"]', '.rail-nav-btn[data-tab="tasks"]', '.rail-nav-btn[data-tab="chat"]'],
              place: ['right', 'bottom'], title: 'Projects, tasks and chats',
              html: '<b>New Chat</b> starts a conversation. <b>Project</b> holds the files the agent works on. <b>Tasks</b> is the board and Autopilot. <b>Chats</b> lists your past conversations.' },
            { sel: ['#privacy-btn', '#dark-mode-btn'], place: ['right', 'top'], title: 'Privacy and theme',
              html: '<b>Privacy</b> picks where requests may go: through FreeGent\'s Cloudflare Worker, straight to the providers, or to your local network only. The moon switches between light and dark.' },
            { sel: ['.left-rail .rail-nav-btn[data-tab="settings"]'], place: ['right', 'top'], title: 'Settings',
              html: '<b>Credentials</b> comes first: keys for model providers, search and tools. Then <b>Models</b>, <b>Skills</b> and <b>MCP</b> to extend the agent, and <b>Agent</b> for limits and behavior.',
              action: { label: 'Open Credentials', run: openSettings } },
            { sel: ['#help-btn'], place: ['bottom', 'left'], title: 'Help is always here',
              html: 'Click <b>?</b> in any view for a short explanation of it and a link to its page in the full documentation. Project, Chats, Tasks and Settings have their own tour there too.' },
        ],
        workspace: [
            { sel: ['#project-name-input'], place: ['bottom'], title: 'The project',
              html: 'Everything the agent reads, writes or runs lives in the project. Give it a name here.' },
            { sel: ['.project-save-btn', 'button[onclick^="loadProjectUI"]'], place: ['bottom'], title: 'Save and Load',
              html: '<b>Save</b> keeps the project, with its chat history, in this browser under its name. <b>Load</b> switches to one you saved earlier.' },
            { sel: ['button[onclick^="exportProject"]', '.project-import-label'], place: ['bottom'], title: 'Export, Import and Merge',
              html: '<b>Export</b> downloads the project as a file, <b>Import</b> restores one, and <b>Merge</b> adds the new files of a project file to this one. Export before you clear site data: the project is stored nowhere else.' },
            { sel: ['.workspace-list-wrap'], place: ['top', 'bottom'], title: 'Files',
              html: 'The agent\'s files appear here as it writes them. Click one to open it in an editor tab. Upload with the buttons above the list or by dropping files, and <b>Local Folder</b> attaches a folder from your disk where the browser allows it.' },
        ],
        chats: [
            { sel: ['.chats-search'], place: ['bottom'], title: 'Find a chat',
              html: 'Type to filter the chats below by name. <b>Ctrl/Cmd+K</b> focuses this box from anywhere.' },
            { sel: ['.chats-toolbar .ws-action-btn'], place: ['bottom'], title: 'Messages and Import',
              html: '<b>Messages</b> searches the text of every message in every chat (<b>Ctrl/Cmd+Shift+F</b>). <b>Import</b> loads a chat you exported earlier.' },
            { sel: ['.chats-list > :first-child'], fallback: ['.chats-empty'], place: ['bottom', 'top'], title: 'Your chats',
              html: 'Click a chat to open it. Each card shows its turns and the models it used, and keeps workspace snapshots from its start and end, so you can reset the project to either.' },
        ],
        tasks: [
            { sel: ['#sync-ledger-btn'], place: ['bottom'], title: 'Sync',
              html: 'Each task is a Markdown file in <code>fg-tasks/</code>. <b>Sync</b> rebuilds the board from those files.' },
            { sel: ['#autopilot-btn', '#runner-run-btn', '#runner-status'], place: ['bottom'], title: 'Run and Autopilot',
              html: '<b>Run</b> completes the next task in its own chat, then stops. <b>Autopilot</b> keeps going, one chat per task, until none are left. While one runs, Pause, Resume, Restart and Stop appear here.' },
            { sel: ['.kanban-board'], place: ['bottom', 'top'], title: 'The board',
              html: 'Tasks move from <b>To Do</b> through <b>In Progress</b> and <b>Review</b> to <b>Done</b>. Moving a card changes its status, and the agent moves them as it works.' },
            { sel: ['.kanban-col[data-status="todo"] .kanban-add-btn'], place: ['bottom', 'right'], title: 'Add a task',
              html: 'Add a task by hand, or ask the agent in Chat: "add tasks: …". It writes the files and does not start them.' },
            { sel: ['#runner-zone'], place: ['top'], title: 'The Runner',
              html: 'Opens while a task runs: the live steps, a session log, and a box to interrupt the agent or answer when it is blocked.' },
        ],
        settings: [
            { sel: [stab('credentials')], enter: settingsTab('credentials'), place: ['bottom'], title: 'Credentials',
              html: 'A key for each model provider you use, plus search and tool keys. Keys stay in this browser and never go into a profile; a passkey can lock them. The guest quota needs none.' },
            { sel: [stab('profiles')], enter: settingsTab('profiles'), place: ['bottom'], title: 'Profiles',
              html: 'Save the current models, tools, skills and agent settings under a name, and switch between setups in a click. Sharing a profile never shares your keys.' },
            { sel: [stab('model')], enter: settingsTab('model'), place: ['bottom'], title: 'Models',
              html: 'Order the models FreeGent tries and its fallbacks, add providers and endpoints, and pick the worker and utility models.' },
            { sel: [stab('privacy')], enter: settingsTab('privacy'), place: ['bottom'], title: 'Privacy',
              html: 'Where requests may go: through FreeGent\'s Cloudflare Worker, straight to the providers, or to your local network only.' },
            { sel: [stab('agent'), stab('skills'), stab('tools'), stab('mcp'), stab('roles'), stab('voice')], enter: settingsTab('agent'), place: ['bottom'], title: 'Shaping the agent',
              html: '<b>Agent</b>: step limits, retries, compaction and checks. <b>Skills</b>: extra instructions it loads on demand. <b>Tools</b>: where code runs and what it may call. <b>MCP</b>: connect servers. <b>Roles</b> and <b>Voice</b> follow.' },
        ],
    };
}

function rectOf(sels: string[]): DOMRect | null {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, any = false;
    for (const s of sels) for (const el of document.querySelectorAll<HTMLElement>(s)) {
        if (!visible(el)) continue;
        const x = el.getBoundingClientRect();
        l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom); any = true;
    }
    return any ? new DOMRect(l, t, r - l, b - t) : null;
}
const stepRect = (s: Step) => rectOf(s.sel) || (s.fallback ? rectOf(s.fallback) : null);
/** Steps whose target is not on screen (collapsed toolbar, a control hidden on a phone) are left out. */
const usable = (s: Step) => !!stepRect(s);

function placeCard(card: HTMLElement, hole: DOMRect, order: string[]) {
    const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 14;
    card.style.maxWidth = Math.min(360, vw - 2 * m) + 'px';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const clampX = (x: number) => Math.max(m, Math.min(x, vw - cw - m));
    const clampY = (y: number) => Math.max(m, Math.min(y, vh - ch - m));
    const fits: Record<string, () => [number, number] | null> = {
        bottom: () => hole.bottom + gap + ch <= vh - m ? [clampX(hole.left), hole.bottom + gap] : null,
        top:    () => hole.top - gap - ch >= m ? [clampX(hole.left), hole.top - gap - ch] : null,
        right:  () => hole.right + gap + cw <= vw - m ? [hole.right + gap, clampY(hole.top)] : null,
        left:   () => hole.left - gap - cw >= m ? [hole.left - gap - cw, clampY(hole.top)] : null,
    };
    for (const p of [...order, 'bottom', 'top', 'right', 'left']) {
        const at = fits[p]();
        if (at) { card.style.left = at[0] + 'px'; card.style.top = at[1] + 'px'; return; }
    }
    card.style.left = clampX((vw - cw) / 2) + 'px'; card.style.top = clampY(vh - ch - m) + 'px';   // nothing fits: over the bottom edge
}

function renderTour() {
    const el = tourEl();
    if (!el) return;
    const s = steps[idx];
    s.enter?.();
    for (const sel of s.sel) { const el = q(sel); if (visible(el)) { el!.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' as ScrollBehavior }); break; } }   // a row that scrolls (Settings tabs on a phone)
    const holeEl = el.querySelector('.fg-tour-hole') as HTMLElement;
    const card = el.querySelector('.fg-tour-card') as HTMLElement;
    const shown = steps.filter(usable);
    card.innerHTML = `<div class="fg-modal-header"><span class="fg-modal-title" id="fg-tour-title">${s.title}</span>
        <button class="fg-modal-close" aria-label="Close" data-act="close">✕</button></div>
        <div class="fg-modal-body"><p>${s.html}</p></div>
        <div class="fg-modal-btns"><span class="fg-tour-count">${shown.indexOf(s) + 1} / ${shown.length}</span>
        ${s.action ? `<button class="fg-modal-btn fg-modal-btn-cancel" data-act="action">${s.action.label}</button>` : ''}
        ${shown[0] === s ? '' : '<button class="fg-modal-btn fg-modal-btn-cancel" data-act="back">Back</button>'}
        <button class="fg-modal-btn fg-modal-btn-ok" data-act="next">${shown[shown.length - 1] === s ? 'Done' : 'Next'}</button></div>`;
    const r0 = stepRect(s)!, pad = 6;
    const hl = Math.max(0, r0.left), ht = Math.max(0, r0.top), hole = new DOMRect(hl, ht, Math.min(window.innerWidth, r0.right) - hl, Math.min(window.innerHeight, r0.bottom) - ht);   // what is on screen of it
    Object.assign(holeEl.style, { left: hole.left - pad + 'px', top: hole.top - pad + 'px', width: hole.width + 2 * pad + 'px', height: hole.height + 2 * pad + 'px' });
    placeCard(card, new DOMRect(hole.left - pad, hole.top - pad, hole.width + 2 * pad, hole.height + 2 * pad), s.place || []);
    (card.querySelector('[data-act="next"]') as HTMLElement).focus();
}

function go(dir: 1 | -1) {
    let i = idx + dir;
    while (i >= 0 && i < steps.length && !usable(steps[i])) i += dir;
    if (i < 0) return;
    if (i >= steps.length) { closeTour(); return; }
    idx = i;
    renderTour();
}

function onTourKey(e: KeyboardEvent) {
    const el = tourEl();
    if (!el) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTour(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Tab') {   // keep focus inside the card
        const f = [...el.querySelectorAll<HTMLElement>('button')];
        const at = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); f[e.shiftKey ? (at <= 0 ? f.length - 1 : at - 1) : (at === f.length - 1 ? 0 : at + 1)].focus();
    }
}
const onResize = () => renderTour();

export function closeTour(): void {
    if (!tourEl()) return;
    tourEl()!.remove();
    document.removeEventListener('keydown', onTourKey, true);
    window.removeEventListener('resize', onResize);
    idx = -1;
    prevFocus?.focus?.();
}

export function startTour(view = activeView()): void {
    if (tourEl() || !TOUR_VIEWS.includes(view)) return;
    if (activeView() !== view || view === 'settings') (window as any).activateTab?.(view);   // Settings opens on Credentials, where its tour starts
    prevFocus = document.activeElement as HTMLElement | null;
    steps = buildTours()[view];
    const first = steps.findIndex(usable);
    if (first < 0) return;
    const el = document.createElement('div');
    el.id = TOUR;
    el.innerHTML = `<div class="fg-tour-hole"></div><div class="fg-tour-card fg-modal" role="dialog" aria-modal="true" aria-labelledby="fg-tour-title"></div>`;
    el.addEventListener('click', e => {
        const act = ((e.target as HTMLElement).closest('[data-act]') as HTMLElement | null)?.dataset.act;
        if (act === 'close') closeTour();
        else if (act === 'next') go(1);
        else if (act === 'back') go(-1);
        else if (act === 'action') steps[idx].action?.run();
    });
    document.body.appendChild(el);
    document.addEventListener('keydown', onTourKey, true);
    window.addEventListener('resize', onResize);
    idx = first;
    renderTour();
}

// ── The button ───────────────────────────────────────────────────────────────

/** The button is there on the views that have help; the popover follows the view, so changing view closes it. */
function syncButton() {
    const btn = q('#help-btn');
    if (!btn) return;
    const has = !!PAGES[activeView()];
    btn.hidden = !has;
    if (popover() && shownFor !== activeView()) closeHelp();
}

function install() {
    const btn = q('#help-btn');
    if (!btn) return;
    new MutationObserver(syncButton).observe(q('#tab-content')!, { subtree: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && popover()?.contains(document.activeElement)) { e.preventDefault(); closeHelp(); q('#help-btn')?.focus(); } });
    document.addEventListener('pointerdown', e => {   // a click elsewhere closes what the reader opened; the first-load one stays until dismissed
        const pop = popover();
        if (pop && !firstLoad && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) closeHelp();
    });
    syncButton();
}
document.addEventListener('DOMContentLoaded', install);

Object.assign(window, { toggleHelp, startTour });
