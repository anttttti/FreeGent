// tui-app.tsx — Ink component tree for the FreeGent TUI.
// Layout (full-width, Claude Code / Opencode style):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  openai|gpt-4o  ● ready  ctx 3.4K/1050.0K        Alt+? help  │ ← status bar
//   ├──────────────────────────────────────────────────────────────┤
//   │                                                              │
//   │  Event log  (scrollable, fills all available rows)           │
//   │                                                              │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Panel (12 rows when open — dismiss with Esc or same Alt+key)│
//   ├──────────────────────────────────────────────────────────────┤
//   │  > user input_                                               │ ← always visible
//   └──────────────────────────────────────────────────────────────┘

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useWindowSize, useApp } from 'ink';
import TextInput from 'ink-text-input';
import * as Store from './tui-store.js';
import { sendMessage, stopAgent, newSession, setMouseHandler, setScrollHandler, runCompact, listWorkspaceSessions, resumeSession } from './fg-tui.js';
import { dom, PROFILE_PATH } from './headless-runner.js';
import { SETTINGS_DEF, keyedFields, type FieldDef, type SectionDef } from './panel-defs.js';
import { _stripTerminal } from './turn-protocol.js';

// ── Click registry ─────────────────────────────────────────────────────────────
// Maps "row:colFrom:colTo" → action. SectionLabel components populate this after
// each render using yoga node absolute positions. alternateScreen ensures that
// yoga row 0 == terminal row 0, so click coordinates map directly.

const _clickTargets = new Map<string, () => void>();

function _registerClick(row: number, colFrom: number, colTo: number, action: () => void) {
    _clickTargets.set(`${row}:${colFrom}:${colTo}`, action);
}

function _handleMouseClick(row: number, col: number) {
    for (const [key, action] of _clickTargets) {
        const [r, cf, ct] = key.split(':').map(Number);
        if (r === row && col >= cf && col <= ct) { action(); return; }
    }
}

// Scroll-target registry: "rowFrom:rowTo" → (dir: 1|-1) => void.
// SectionContent boxes register themselves here; scroll events are dispatched by row.
const _scrollTargets = new Map<string, (dir: 1 | -1) => void>();

function _handleMouseScroll(row: number, _col: number, dir: 1 | -1) {
    for (const [key, action] of _scrollTargets) {
        const [rf, rt] = key.split(':').map(Number);
        if (row >= rf && row <= rt) { action(dir); return; }
    }
    // Default: scroll the event log (dir +1 = up = older, -1 = down = newer)
    Store.scroll(dir);
}

function _absTop(node: any): number {
    let v = 0, n = node;
    while (n) { v += n.yogaNode?.getComputedTop() ?? 0; n = n.parentNode; }
    return v;
}
function _absLeft(node: any): number {
    let v = 0, n = node;
    while (n) { v += n.yogaNode?.getComputedLeft() ?? 0; n = n.parentNode; }
    return v;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_HEIGHT      = 12;  // rows used by any open panel
const STATUS_HEIGHT     = 1;   // top status bar
const INPUT_HEIGHT      = 1;   // input line (may render 1–3 rows; use min for EventLog sizing)
const MAX_SECTION_LINES = 10;  // max visible lines per expanded section; rest is mouse-scrollable

// ── Store hook ────────────────────────────────────────────────────────────────

function useStore(): Store.AppState {
    const [, forceUpdate] = useState(0);
    useEffect(() => {
        return Store.subscribe(() => forceUpdate(n => n + 1));
    }, []);
    return Store.getState();
}

// ── Turn header (clickable to collapse) ───────────────────────────────────────

function TurnHeader({ turn, turnIndex }: { turn: Store.TurnState; turnIndex: number }) {
    const ref = useRef<any>(null);
    const prevKey = useRef<string | null>(null);

    useEffect(() => {
        if (prevKey.current) { _clickTargets.delete(prevKey.current); prevKey.current = null; }
        const node = ref.current;
        if (!node?.yogaNode) return;
        const w = node.yogaNode.getComputedWidth();
        if (w === 0) return;
        const row = _absTop(node);
        const col = _absLeft(node);
        const key = `${row}:${col}:${col + w - 1}`;
        _registerClick(row, col, col + w - 1, () => Store.toggleTurnCollapse(turn));
        prevKey.current = key;
        return () => { _clickTargets.delete(key); prevKey.current = null; };
    });

    const elapsed = turn.done && turn.steps.length
        ? ` ${((turn.steps.at(-1)!.startTime + turn.steps.at(-1)!.elapsed * 1000 - turn.startTime) / 1000).toFixed(1)}s`
        : '';

    return (
        <Box ref={ref}>
            <Text dimColor bold>
                {turn.collapsed ? '▶' : '▼'}{` Turn ${turnIndex}${elapsed}`}
            </Text>
            {!turn.done && <Text color="yellow"> (running)</Text>}
        </Box>
    );
}

// ── Step display ──────────────────────────────────────────────────────────────

const STATUS_SYMBOL: Record<Store.StepStatus, string> = {
    running:   '●',
    done:      '✓',
    aborted:   '✗',
    compact:   '⊟',
    truncated: '⚠',
};
const STATUS_COLOR: Record<Store.StepStatus, string> = {
    running:   'yellow',
    done:      'green',
    aborted:   'red',
    compact:   'cyan',
    truncated: 'magenta',
};

// ── Step animation ticker ─────────────────────────────────────────────────────
// One shared 200 ms interval drives all running-step animations (2 s / full cycle).
// Components subscribe only while `enabled`; the timer stops when all unsubscribe.

const _SPIN     = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;
const _TICK_MOD = _SPIN.length;  // 10

// Brightness triangle wave: dim → normal → bold → normal → dim  (2 ticks each level).
// Mapped onto Ink's dimColor / bold props so the glow stays a single yellow hue.
const _GLOW: Array<{ dimColor: boolean; bold: boolean }> = [
    { dimColor: true,  bold: false },  // 0 ╮ dim
    { dimColor: true,  bold: false },  // 1 ╯
    { dimColor: false, bold: false },  // 2 ╮ normal
    { dimColor: false, bold: false },  // 3 ╯
    { dimColor: false, bold: true  },  // 4 ╮ bright
    { dimColor: false, bold: true  },  // 5 ╯
    { dimColor: false, bold: false },  // 6 ╮ normal
    { dimColor: false, bold: false },  // 7 ╯
    { dimColor: true,  bold: false },  // 8 ╮ dim
    { dimColor: true,  bold: false },  // 9 ╯
];

let _animTick  = 0;
let _animTimer: ReturnType<typeof setInterval> | null = null;
const _animSubs = new Set<() => void>();

function _tickAnim() {
    _animTick = (_animTick + 1) % _TICK_MOD;
    for (const fn of _animSubs) fn();
}
function _animSub(fn: () => void)   { _animSubs.add(fn);    if (!_animTimer) _animTimer = setInterval(_tickAnim, 200); }
function _animUnsub(fn: () => void) { _animSubs.delete(fn); if (_animSubs.size === 0 && _animTimer) { clearInterval(_animTimer); _animTimer = null; } }

/** Returns the shared animation tick (0–9), updated every 200 ms, only while `enabled`. */
function useAnimTick(enabled: boolean): number {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        const fn = () => bump(n => n + 1);
        _animSub(fn);
        return () => _animUnsub(fn);
    }, [enabled]);
    return _animTick;
}

function _friendlyLabel(raw: string): string {
    if (!raw) return raw;
    const s = raw.trim();
    if (s.startsWith('worker:')) {
        const parts = s.slice(7).split(':');
        const id = (parts[1] || parts[0]).toLowerCase();
        if (/director/i.test(id))               return 'Directing';
        if (/orchestrat/i.test(id))             return 'Orchestrating';
        if (/planner?$/i.test(id) || id === 'plan' || id === 'replan') return 'Planning';
        if (/research/i.test(id))               return 'Researching';
        if (/cod(e|er|ing)/i.test(id))          return 'Coding';
        if (/synthes/i.test(id))                return 'Synthesising';
        if (/reduc/i.test(id))                  return 'Reducing';
        if (/review/i.test(id))                 return 'Reviewing';
        if (/search/i.test(id))                 return 'Searching';
        if (/find/i.test(id))                   return 'Finding';
        if (/read/i.test(id))                   return 'Reading';
        if (/write|generat|creat/i.test(id))    return 'Writing';
        if (/analys|analyz/i.test(id))          return 'Analysing';
        if (/test|verif/i.test(id))             return 'Verifying';
        if (/fix|patch|repair/i.test(id))       return 'Fixing';
        return id.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (/^Thinking/i.test(s)) {
        const ci = s.indexOf(':');
        return ci >= 0 ? s.slice(ci + 1).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Working';
    }
    if (/^compact/i.test(s))             return 'Compacting';
    if (/summariz/i.test(s))             return 'Synthesising';
    if (/resolv.*conflict/i.test(s))     return 'Resolving';
    if (s.startsWith('read:'))           return 'Reading';
    if (s.startsWith('write:'))          return 'Writing';
    if (s.startsWith('replace:'))        return 'Editing';
    if (s.startsWith('patch:'))          return 'Patching';
    if (s.startsWith('append:'))         return 'Appending';
    if (s.startsWith('del:'))            return 'Deleting';
    if (s.startsWith('undo:'))           return 'Undoing';
    if (s.startsWith('search:'))         return 'Searching';
    if (s.startsWith('wiki:'))           return 'Looking up';
    if (s.startsWith('fetch:'))          return 'Fetching';
    if (s.startsWith('grep:'))           return 'Searching';
    if (s.startsWith('arxiv:'))          return 'Researching';
    if (s.startsWith('s2:'))             return 'Researching';
    if (s.startsWith('exec('))           return 'Executing';
    if (s.startsWith('workers('))        return 'Delegating';
    if (s.startsWith('task:'))           return 'Updating task';
    if (s.startsWith('git '))            return 'Git';
    if (s === 'list_files')              return 'Listing files';
    if (s.startsWith('<handover>') || s === 'handover') return 'Handing over';
    const clean = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 45) + '…' : clean;
}

// Sections in display order: Prompt (sent context), Thinking, Output, raw Request
const SECTION_ORDER: Store.StepSection[] = ['Prompt', 'Thinking', 'Output', 'Request'];

function _hasSection(step: Store.StepState, s: Store.StepSection): boolean {
    return s === 'Output' ? !!step.output : s === 'Thinking' ? !!step.thinking
         : s === 'Prompt' ? !!step.prompt : !!step.request;
}

function SectionLabel({ step, section }: { step: Store.StepState; section: Store.StepSection }) {
    const ref = useRef<any>(null);
    const prevKey = useRef<string | null>(null);

    // "Glowing" = this section is actively streaming right now
    const streaming = step.status === 'running' && (
        section === 'Thinking' ? !!(step.thinking || step._buf.thinking) :
        section === 'Output'   ? !step._buf.thinking :
        false
    );
    const open = step.openSection === section;
    const tick = useAnimTick(streaming);
    // Glow applies when streaming but not open (open sections show cyan, no pulse)
    const glow = streaming && !open ? _GLOW[tick] : null;

    useEffect(() => {
        // Remove stale registration before setting new one
        if (prevKey.current) { _clickTargets.delete(prevKey.current); prevKey.current = null; }
        const node = ref.current;
        if (!node?.yogaNode) return;
        const w = node.yogaNode.getComputedWidth();
        if (w === 0) return;
        const row = _absTop(node);
        const col = _absLeft(node);
        const key = `${row}:${col}:${col + w - 1}`;
        _registerClick(row, col, col + w - 1, () => Store.toggleStepSection(step, section));
        prevKey.current = key;
        return () => { _clickTargets.delete(key); prevKey.current = null; };
    });

    return (
        <Box ref={ref} marginRight={1}>
            <Text
                color={open ? 'cyan' : streaming ? 'yellow' : undefined}
                bold={glow ? glow.bold : false}
                dimColor={glow ? glow.dimColor : (!open && !streaming)}
                underline={open}
            >
                {`[${section}]`}
            </Text>
        </Box>
    );
}

function StepView({ step, width }: { step: Store.StepState; width: number }) {
    const isRunning = step.status === 'running';
    const tick      = useAnimTick(isRunning);
    // Running: slow braille spinner + yellow glow (dim → normal → bold → normal → dim, 2 s/cycle)
    const sym   = isRunning ? _SPIN[tick]              : STATUS_SYMBOL[step.status];
    const glow  = isRunning ? _GLOW[tick]              : null;
    const color = isRunning ? 'yellow'                 : STATUS_COLOR[step.status];
    const label = _friendlyLabel(step.label);
    const model = step.model ? ` [${step.model.split('/').pop()}]` : '';
    const tokIn  = step.tokens.inp != null ? `↑${step.tokens.inp}` : '';
    const tokOut = step.tokens.out != null ? `↓${step.tokens.out}` : '';
    const tok = (tokIn || tokOut) ? ' ' + [tokIn, tokOut].filter(Boolean).join(' ') : '';
    const secs  = ` ${step.elapsed.toFixed(1)}s`;
    const header = `  ${sym} ${label}${model}${tok}${secs}`;
    const visibleSections = SECTION_ORDER.filter(s => _hasSection(step, s));

    return (
        <Box flexDirection="column">
            <Box>
                <Text color={color} bold={!!glow?.bold} dimColor={!!glow?.dimColor}>{header}</Text>
                {visibleSections.length > 0 && !step.collapsed && (
                    <Box marginLeft={2} flexDirection="row">
                        {visibleSections.map(s => (
                            <SectionLabel key={s} step={step} section={s} />
                        ))}
                    </Box>
                )}
            </Box>
            {!step.collapsed && step.openSection && (
                <SectionContent step={step} section={step.openSection} width={width - 4} />
            )}
        </Box>
    );
}

function SectionContent({ step, section, width }: { step: Store.StepState; section: Store.StepSection; width: number }) {
    const raw = section === 'Output'   ? _cleanOutput(step.output)
              : section === 'Thinking' ? step.thinking
              : section === 'Prompt'   ? step.prompt ?? ''
              :                          step.request ?? '';

    // scrollOffset 0 = anchored to bottom (newest); +N = N lines above bottom.
    const [scrollOffset, setScrollOffset] = useState(0);
    const boxRef = useRef<any>(null);
    const prevScrollKey = useRef<string | null>(null);

    const lines    = raw.split('\n');
    const total    = lines.length;
    const clamped  = Math.max(0, Math.min(scrollOffset, Math.max(0, total - MAX_SECTION_LINES)));
    const endIdx   = total - clamped;
    const startIdx = Math.max(0, endIdx - MAX_SECTION_LINES);
    const visible  = lines.slice(startIdx, endIdx);
    const aboveCnt = startIdx;
    const belowCnt = total - endIdx;

    // Register this box as a scroll target so mouse wheel scrolls its content.
    useEffect(() => {
        const node = boxRef.current;
        if (!node?.yogaNode) return;
        const h = node.yogaNode.getComputedHeight();
        if (h === 0) return;
        const top = _absTop(node);
        const key = `${top}:${top + h - 1}`;
        if (key === prevScrollKey.current) return;              // position unchanged — skip
        if (prevScrollKey.current) _scrollTargets.delete(prevScrollKey.current);
        // dir +1 = wheel up = show older lines (increase offset); -1 = wheel down = newer
        _scrollTargets.set(key, (dir: 1 | -1) => setScrollOffset(o => Math.max(0, o + dir * 3)));
        prevScrollKey.current = key;
        return () => {
            if (prevScrollKey.current) { _scrollTargets.delete(prevScrollKey.current); prevScrollKey.current = null; }
        };
    });

    return (
        <Box ref={boxRef} paddingLeft={4} flexDirection="column">
            <Text dimColor>{'─'.repeat(Math.max(0, width - 4))}</Text>
            {aboveCnt > 0 && (
                <Text dimColor>{`  ↑ ${aboveCnt} line${aboveCnt > 1 ? 's' : ''} above  (scroll ↑)`}</Text>
            )}
            <Text wrap="wrap">{visible.join('\n')}</Text>
            {belowCnt > 0 && (
                <Text dimColor>{`  ↓ ${belowCnt} line${belowCnt > 1 ? 's' : ''} below  (scroll ↓)`}</Text>
            )}
        </Box>
    );
}

function _cleanFinalText(text: string): string {
    try {
        const stripped = _stripTerminal(text);
        return (dom.window as any).cleanResponse?.(stripped) ?? stripped;
    } catch { return text; }
}

function _cleanOutput(raw: string): string {
    try {
        const stripped = _stripTerminal(raw);
        return (dom.window as any).cleanResponse?.(stripped) ?? stripped;
    } catch { return raw; }
}

// ── Event log ─────────────────────────────────────────────────────────────────

type FlatItem =
    | { kind: 'user';        id: number; text: string }
    | { kind: 'turn-header'; turn: Store.TurnState; turnIndex: number }
    | { kind: 'step';        step: Store.StepState }
    | { kind: 'final-text';  turn: Store.TurnState };

function _buildFlatItems(entries: Store.Entry[]): FlatItem[] {
    const out: FlatItem[] = [];
    // turnIndex counts real agent turns in display order (not entity IDs),
    // so "Turn 1 / Turn 2 …" matches the user's mental model.
    let turnIndex = 0;
    for (const e of entries) {
        if (e.type === 'user') {
            out.push({ kind: 'user', id: e.id, text: e.text });
        } else {
            turnIndex++;
            out.push({ kind: 'turn-header', turn: e.turn, turnIndex });
            if (!e.turn.collapsed) {
                for (const step of e.turn.steps)
                    out.push({ kind: 'step', step });
                // Only show final-text when there's something non-trivial to display
                // (protocol-only responses like bare "COMPLETED" clean to empty).
                if (e.turn.done && e.turn.finalText?.trim())
                    out.push({ kind: 'final-text', turn: e.turn });
            }
        }
    }
    return out;
}

function EventLog({ height, width, entries, scrollOffset }: { height: number; width: number; entries: Store.Entry[]; scrollOffset: number }) {
    if (height <= 0) return null;
    const items    = _buildFlatItems(entries);
    // Each item is ~1 line (step/header); overflow="hidden" clips taller sections
    const maxItems = Math.max(1, height);
    const endIdx   = Math.max(maxItems, items.length - scrollOffset);
    const visible  = items.slice(Math.max(0, endIdx - maxItems), endIdx);

    return (
        <Box flexDirection="column" height={height} overflow="hidden">
            {scrollOffset > 0 && (
                <Text dimColor>{`  ↑ scrolled up ${scrollOffset} (↓ to return)`}</Text>
            )}
            {visible.map((item, i) => {
                if (item.kind === 'user') {
                    return (
                        <Box key={item.id}>
                            <Text color="cyan" bold>{`> ${item.text}`}</Text>
                        </Box>
                    );
                }
                if (item.kind === 'turn-header') {
                    return <TurnHeader key={`th-${item.turn.id}`} turn={item.turn} turnIndex={item.turnIndex} />;
                }
                if (item.kind === 'step') {
                    return <StepView key={item.step.id} step={item.step} width={width} />;
                }
                if (item.kind === 'final-text') {
                    const displayText = _cleanFinalText(item.turn.finalText!);
                    return (
                        <Box key={`ft-${item.turn.id}`} paddingLeft={2} paddingTop={1}>
                            <Text wrap="wrap" bold>{displayText}</Text>
                        </Box>
                    );
                }
                return null;
            })}
        </Box>
    );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function ModelPanel() {
    const [models, setModels] = useState<string[]>([]);
    const [paused, setPaused] = useState<string[]>([]);

    useEffect(() => {
        const refresh = () => {
            try {
                setModels(dom.window.getMainModelList?.() ?? []);
                setPaused(dom.window.getPausedMainModels?.() ?? []);
            } catch {}
        };
        refresh();
        const t = setInterval(refresh, 2000);
        return () => clearInterval(t);
    }, []);

    return (
        <Box flexDirection="column">
            <Text bold>Primary models</Text>
            <Text dimColor>{`  profile: ${PROFILE_PATH}`}</Text>
            <Text dimColor>{'  /model <provider>|<model> to change  •  --model flag overrides on start'}</Text>
            {models.length === 0
                ? <Text dimColor>  No models configured. Edit profile or use /model openai|gpt-4o</Text>
                : models.map((m, i) => {
                    const isPaused = paused.includes(m);
                    const [prov, ...rest] = m.split('|');
                    return (
                        <Text key={m}>
                            <Text dimColor>{`  ${i + 1}. `}</Text>
                            <Text color="cyan">{prov}</Text>
                            <Text>{`|${rest.join('|')}`}</Text>
                            {isPaused && <Text color="red"> [paused]</Text>}
                            {i === 0 && !isPaused && <Text color="green"> ←active</Text>}
                        </Text>
                    );
                })}
        </Box>
    );
}

function RolePanel() {
    const [currentRole, setCurrentRole] = useState<any>(null);
    const [roles, setRoles] = useState<any[]>([]);

    useEffect(() => {
        const refresh = () => {
            try {
                setCurrentRole((globalThis as any).mainAgentRole ?? null);
                const reg: Map<string, any> | undefined = (globalThis as any).rolesRegistry;
                if (reg) setRoles([...reg.values()]);
            } catch {}
        };
        refresh();
        const t = setInterval(refresh, 2000);
        return () => clearInterval(t);
    }, []);

    const activeName = currentRole?.name ?? 'none';

    return (
        <Box flexDirection="column">
            <Text bold>
                {'Active role: '}
                <Text color="cyan">{activeName}</Text>
                {currentRole?.description ? <Text dimColor>{`  — ${currentRole.description}`}</Text> : null}
            </Text>
            <Text dimColor>{'  Switch: /role <name>  •  Reset to default: /role director'}</Text>
            {roles.map(r => (
                <Text key={r.name}>
                    <Text color={r.name === activeName ? 'cyan' : undefined} dimColor={r.name !== activeName}>
                        {`  ${r.name}`}
                    </Text>
                    {r.description
                        ? <Text dimColor>{`  — ${r.description}`}</Text>
                        : null}
                </Text>
            ))}
        </Box>
    );
}

function TasksPanel() {
    const [tasks, setTasks] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await (dom.window as any).loadTaskFiles?.();
            setTasks(result ?? []);
        } catch {
            setTasks([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
    }, []);

    const byStatus = (s: string) => tasks.filter(t => (t.fm?.status ?? 'todo').toLowerCase() === s.toLowerCase());
    const todo       = byStatus('todo').length + byStatus('open').length;
    const inProgress = byStatus('in-progress').length;
    const inReview   = byStatus('in-review').length;
    const done       = byStatus('done').length;

    const recent = tasks
        .filter(t => (t.fm?.status ?? 'todo').toLowerCase() !== 'done')
        .slice(0, 6);

    return (
        <Box flexDirection="column">
            <Box flexDirection="row" gap={3}>
                <Text bold>Tasks</Text>
                {loading && <Text dimColor>loading…</Text>}
                <Text dimColor>{'  /tasks to refresh'}</Text>
            </Box>
            <Box flexDirection="row" gap={4} marginTop={0}>
                <Text>{`Todo `}<Text color="yellow">{todo}</Text></Text>
                <Text>{'›'}</Text>
                <Text>{`In Progress `}<Text color="cyan">{inProgress}</Text></Text>
                <Text>{'›'}</Text>
                <Text>{`In Review `}<Text color="magenta">{inReview}</Text></Text>
                <Text>{'›'}</Text>
                <Text>{`Done `}<Text color="green">{done}</Text></Text>
            </Box>
            {tasks.length === 0 && !loading && (
                <Text dimColor>  No tasks found. Create task files in fg-tasks/ directory.</Text>
            )}
            {recent.map((task: any) => {
                const status = (task.fm?.status ?? 'todo').toLowerCase();
                const color = status === 'in-progress' ? 'cyan' : status === 'in-review' ? 'magenta' : 'white';
                const title = task.fm?.title ?? task.path?.replace(/^.*\//, '').replace('.md', '') ?? '?';
                return (
                    <Text key={task.path}>
                        <Text dimColor>{'  '}</Text>
                        <Text color={color}>{`[${status}]`}</Text>
                        <Text>{`  ${title}`}</Text>
                    </Text>
                );
            })}
        </Box>
    );
}

function AgentPanel() {
    const [uptime, setUptime] = useState(0);
    const _startRef = useRef(Date.now());

    useEffect(() => {
        const t = setInterval(() => setUptime(Math.floor((Date.now() - _startRef.current) / 1000)), 1000);
        return () => clearInterval(t);
    }, []);

    const mm  = String(Math.floor(uptime / 60)).padStart(2, '0');
    const ss  = String(uptime % 60).padStart(2, '0');

    return (
        <Box flexDirection="column">
            <Text bold>Agent Session</Text>
            <Text>{`  Uptime: ${mm}:${ss}`}</Text>
            <Text dimColor>{'  Keys: Alt+B break-after-step  •  Alt+X stop  •  Alt+N new chat'}</Text>
            <Text dimColor>{'  Autonomous loop: use browser UI (fg-tasks/ + Agent tab) to run autopilot'}</Text>
            <Text dimColor>{'  /role director — switch to director role for autonomous task execution'}</Text>
            <Text dimColor>{'  /role researcher — read-only research worker'}</Text>
            <Text dimColor>{'  Convergence nudge fires every 20 steps without a file edit'}</Text>
            <Text dimColor>{'  Role step cap at 60 steps (emits BLOCKED rather than silent stop)'}</Text>
        </Box>
    );
}

function _lsGet(key: string, fallback = ''): string {
    try { return dom.window.localStorage?.getItem(key) ?? fallback; } catch { return fallback; }
}
function _lsSet(key: string, value: string): void {
    try { dom.window.localStorage?.setItem(key, value); } catch {}
}

// ── TUI renderer for panel-defs.ts schema ────────────────────────────────────
// Reads localStorage values and renders each FieldDef as Ink Text.
// Edits are made via the /set slash command (same localStorage key space as WebUI).

function renderTuiField(field: FieldDef, val: string): React.ReactNode {
    if (field.kind === 'heading') {
        return <Text key={field.text} bold dimColor>{`  ${field.text}`}</Text>;
    }
    if (field.kind === 'hint') {
        return <Text key={field.text} dimColor>{`    ${field.text}`}</Text>;
    }
    if (field.kind === 'toggle') {
        const on = val === 'true';
        return (
            <Text key={field.key}>
                <Text dimColor>{`  ${field.label.padEnd(36)}`}</Text>
                <Text color={on ? 'green' : 'red'}>{on ? '✓ on' : '✗ off'}</Text>
            </Text>
        );
    }
    if (field.kind === 'select') {
        const opt = field.options.find(o => o.value === val);
        const display = opt?.label ?? (val || '');
        const hint = field.options.map(o => o.value).join(' | ');
        return (
            <Text key={field.key}>
                <Text dimColor>{`  ${field.label.padEnd(36)}`}</Text>
                <Text color={val ? 'cyan' : undefined} dimColor={!val}>{val ? display : 'default'}</Text>
                <Text dimColor>{`  (${hint})`}</Text>
            </Text>
        );
    }
    // number / text
    const masked = field.kind === 'text' && field.secret && val;
    const display = masked ? '••••••••' : val;
    const placeholder = 'placeholder' in field ? field.placeholder : undefined;
    return (
        <Text key={field.key}>
            <Text dimColor>{`  ${field.label.padEnd(36)}`}</Text>
            <Text color={val ? 'cyan' : undefined} dimColor={!val}>
                {val ? display : 'default'}
            </Text>
            {placeholder && !val && <Text dimColor>{`  (${placeholder})`}</Text>}
        </Text>
    );
}

function TuiSection({ section, vals }: { section: SectionDef; vals: Record<string, string> }) {
    return (
        <Box flexDirection="column" marginTop={1}>
            {section.title && (
                <Text bold>{`  ${section.title}`}</Text>
            )}
            {section.hint && (
                <Text dimColor>{`    ${section.hint}`}</Text>
            )}
            {section.fields.map((field, i) => (
                <React.Fragment key={i}>
                    {renderTuiField(field, 'key' in field ? (vals[field.key] ?? '') : '')}
                </React.Fragment>
            ))}
        </Box>
    );
}

function SettingsPanel() {
    const keys = keyedFields(SETTINGS_DEF).map(f => f.key);
    const [vals, setVals] = useState<Record<string, string>>({});

    useEffect(() => {
        const refresh = () => {
            const v: Record<string, string> = {};
            for (const k of keys) v[k] = _lsGet(k, '');
            setVals(v);
        };
        refresh();
        const t = setInterval(refresh, 3000);
        return () => clearInterval(t);
    }, []);

    return (
        <Box flexDirection="column">
            <Text bold>Settings</Text>
            <Text dimColor>{'  /set <key> <value> to change  •  e.g. /set fg_temperature 0.8'}</Text>
            {SETTINGS_DEF.sections.map((section, i) => (
                <TuiSection key={i} section={section} vals={vals} />
            ))}
        </Box>
    );
}

// ── Project panel ─────────────────────────────────────────────────────────────

function ProjectPanel({ workspaceRoot, height }: { workspaceRoot: string; height: number }) {
    const [files, setFiles] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const refresh = async () => {
            setLoading(true);
            try {
                const list = await (dom.window as any).listWorkspaceFiles?.() ?? [];
                setFiles(list.slice(0, height - 6));
            } catch {
                setFiles([]);
            } finally {
                setLoading(false);
            }
        };
        refresh();
        const t = setInterval(refresh, 8000);
        return () => clearInterval(t);
    }, [height]);

    return (
        <Box flexDirection="column">
            <Box flexDirection="row" gap={2}>
                <Text bold>Project</Text>
                {loading && <Text dimColor>loading…</Text>}
            </Box>
            <Text dimColor>{`  root: ${workspaceRoot}`}</Text>
            <Text dimColor>{'  /workspace to refresh  •  files shown below'}</Text>
            <Text> </Text>
            {files.length === 0 && !loading && (
                <Text dimColor>  No files found in workspace root.</Text>
            )}
            {files.map((f: string) => (
                <Text key={f} dimColor>{'  '}<Text>{f}</Text></Text>
            ))}
        </Box>
    );
}

// ── Panel wrapper — fills the full main area ──────────────────────────────────

function Panel({ name, height, workspaceRoot }: {
    name: string;
    height: number;
    workspaceRoot: string;
}) {
    const inner = (
        name === 'project'  ? <ProjectPanel workspaceRoot={workspaceRoot} height={height} /> :
        name === 'model'    ? <ModelPanel /> :
        name === 'role'     ? <RolePanel /> :
        name === 'tasks'    ? <TasksPanel /> :
        name === 'agent'    ? <AgentPanel /> :
        name === 'settings' ? <SettingsPanel /> :
        (() => {
            const content: Record<string, string> = {
                help: 'Keyboard shortcuts (Alt + key):\n' +
                      '  Alt+N  new chat        Alt+M  model list\n' +
                      '  Alt+T  tasks           Alt+A  agent info\n' +
                      '  Alt+,  settings        Alt+R  role\n' +
                      '  Alt+P  project files   Alt+H  this help\n' +
                      '  Esc    close panel      ↑/↓   scroll log\n' +
                      '\n' +
                      'While agent runs:\n' +
                      '  Ctrl+C  break after step (exit when idle)\n' +
                      '  Alt+X   hard stop    Alt+B  soft break\n' +
                      '  Alt+U   retry last turn\n' +
                      '\n' +
                      'Slash commands:\n' +
                      '  /clear /compact /rewind\n' +
                      '  /export  — save chat as markdown file\n' +
                      '  /resume [N]  — list or restore a previous session\n' +
                      '  /model <prov|model>    /role [name]\n' +
                      '  /set <key> <value>     /tasks /help\n' +
                      '  /steer N  /queue N  /cancel N',
            };
            return (
                <>
                    <Text bold>{name.charAt(0).toUpperCase() + name.slice(1)}</Text>
                    <Text wrap="wrap">{content[name] ?? ''}</Text>
                </>
            );
        })()
    );

    return (
        <Box flexDirection="column" height={height} overflow="hidden" paddingX={2} paddingY={1}>
            {inner}
        </Box>
    );
}

// ── Status bar (top, 1 row) ───────────────────────────────────────────────────
// Shows active model, running state, context usage, and a key hint.

function StatusBar({ agentRunning, ready }: {
    agentRunning: boolean;
    ready:        boolean;
}) {
    const [model,  setModel]  = useState('');
    const [ctxUsed, setCtxUsed]   = useState(0);
    const [ctxLimit, setCtxLimit] = useState(0);

    useEffect(() => {
        const refresh = () => {
            try { setModel((dom.window.getMainModelList?.() ?? [])[0] ?? ''); } catch {}
            try {
                const u = (dom.window as any).getContextUsage?.() as { used: number; limit: number } | undefined;
                if (u) { setCtxUsed(u.used); setCtxLimit(u.limit); }
            } catch {}
        };
        refresh();
        const t = setInterval(refresh, 2000);
        return () => clearInterval(t);
    }, []);

    const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n > 0 ? String(n) : '';

    // Context window fill fraction — colour-coded like the web UI (warn ≥70%, danger ≥90%)
    const ctxPct   = ctxLimit > 0 ? ctxUsed / ctxLimit : 0;
    const ctxColor = ctxPct >= 0.9 ? 'red' : ctxPct >= 0.7 ? 'yellow' : undefined;
    const ctxLabel = ctxUsed > 100
        ? `ctx ${fmtK(ctxUsed)}/${fmtK(ctxLimit)}`
        : '';

    if (!ready) {
        return (
            <Box paddingX={1}>
                <Text color="yellow" dimColor>{'⟳ starting…'}</Text>
            </Box>
        );
    }

    return (
        <Box paddingX={1} gap={2}>
            <Text color="cyan" dimColor>{model || '—'}</Text>
            <Text color={agentRunning ? 'yellow' : 'green'} dimColor>
                {agentRunning ? '⟳ running' : '● ready  '}
            </Text>
            {ctxLabel ? <Text color={ctxColor} dimColor={!ctxColor}>{ctxLabel}</Text> : null}
            <Box flexGrow={1} />
            <Text dimColor>{'Alt+? help'}</Text>
        </Box>
    );
}

// ── Message queue panel ───────────────────────────────────────────────────────

function QueueItemRow({ item, index, total }: { item: Store.QueuedMsg; index: number; total: number }) {
    const badgeRef  = useRef<any>(null);
    const cancelRef = useRef<any>(null);
    const upRef     = useRef<any>(null);
    const downRef   = useRef<any>(null);
    const prevKeys  = useRef<string[]>([]);

    useEffect(() => {
        for (const k of prevKeys.current) _clickTargets.delete(k);
        prevKeys.current = [];

        const reg = (ref: React.RefObject<any>, action: () => void) => {
            const node = ref.current;
            if (!node?.yogaNode) return;
            const w = node.yogaNode.getComputedWidth();
            if (w === 0) return;
            const row = _absTop(node);
            const col = _absLeft(node);
            const key = `${row}:${col}:${col + w - 1}`;
            _registerClick(row, col, col + w - 1, action);
            prevKeys.current.push(key);
        };

        const q = dom.window.msgQueue as any;
        reg(badgeRef,  () => q?.setMode(item.id, item.mode === 'steering' ? 'queued' : 'steering'));
        reg(cancelRef, () => q?.cancel(item.id));
        if (index > 0)           reg(upRef,   () => q?.move(item.id, -1));
        if (index < total - 1)   reg(downRef, () => q?.move(item.id,  1));
    });

    const isSteering = item.mode === 'steering';
    const preview    = item.text.length > 52 ? item.text.slice(0, 49) + '…' : item.text;

    return (
        <Box gap={1}>
            <Box ref={badgeRef}>
                <Text color={isSteering ? 'yellow' : 'cyan'} bold>
                    {isSteering ? '[⚡Steer]' : '[⏎Queue]'}
                </Text>
            </Box>
            <Text dimColor>{preview}</Text>
            {index > 0 && (
                <Box ref={upRef}><Text dimColor>[↑]</Text></Box>
            )}
            {index < total - 1 && (
                <Box ref={downRef}><Text dimColor>[↓]</Text></Box>
            )}
            <Box ref={cancelRef}><Text color="red">[✕]</Text></Box>
        </Box>
    );
}

function QueuePanel({ queue }: { queue: Store.QueuedMsg[] }) {
    if (!queue.length) return null;
    return (
        <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor="gray">
            {queue.map((item, i) => (
                <QueueItemRow key={item.id} item={item} index={i} total={queue.length} />
            ))}
        </Box>
    );
}

// ── Input line ────────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
    '/clear', '/stop', '/break', '/retry', '/rewind', '/compact',
    '/export', '/resume',
    '/project', '/tasks', '/agent', '/model', '/role',
    '/set', '/skills', '/settings', '/help',
    '/steer', '/queue', '/cancel',
];

// /model <provider>|<model> — set the active model and register it as a custom model if needed.
function _setModel(spec: string): void {
    const parts = spec.split('|');
    if (parts.length < 2) return;
    const [provider, ...rest] = parts;
    const model = rest.join('|');
    try {
        const reg: any[] = JSON.parse(dom.window.localStorage?.getItem?.('fg_custom_models') || '[]');
        if (!reg.find(m => `${m.provider}|${m.model}` === spec)) {
            reg.push({ provider, model, label: model, released: '', contextK: 128,
                       params: 0, media: ['text'], tools: true, thinking: false, note: 'tui' });
            dom.window.localStorage?.setItem?.('fg_custom_models', JSON.stringify(reg));
        }
        dom.window.saveMainModelList?.([spec]);
    } catch {}
}

function InputLine({ ready, running, promptSuggestion }: {
    ready:           boolean;
    running:         boolean;
    promptSuggestion: string;
}) {
    const [value, setValue] = useState('');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    // Message typed and submitted before startup finished — fired once ready.
    const pendingRef = useRef<string | null>(null);

    // As soon as startup completes, dispatch any message the user sent early.
    useEffect(() => {
        if (!ready || !pendingRef.current) return;
        const t = pendingRef.current;
        pendingRef.current = null;
        (async () => {
            const activeModels = dom.window.getActiveMainModelList?.() ?? [];
            if (activeModels.length === 0) return;
            if (t.startsWith('/')) { await handleSlash(t); return; }
            Store.addUserMessage(t);
            await sendMessage(t);
        })();
    }, [ready]);

    const onChange = useCallback((v: string) => {
        setValue(v);
        if (v) Store.setPromptSuggestion('');
        if (v.startsWith('/')) {
            setSuggestions(SLASH_COMMANDS.filter(c => c.startsWith(v)));
        } else {
            setSuggestions([]);
        }
    }, []);

    const onSubmit = useCallback(async (text: string) => {
        const t = text.trim();
        if (!t) return;
        setValue('');
        setSuggestions([]);
        Store.setPromptSuggestion('');

        if (!ready) {
            // Startup still in progress — buffer the message; useEffect fires it once ready.
            pendingRef.current = t;
            return;
        }

        const activeModels = dom.window.getActiveMainModelList?.() ?? [];
        if (activeModels.length === 0) return; // no model configured — silently drop

        if (t.startsWith('/')) {
            await handleSlash(t);
            return;
        }

        if (running) {
            // Agent busy — enqueue; the message appears in the queue panel, not the chat log yet.
            (dom.window.msgQueue as any)?.enqueue(t, 'queued');
            return;
        }

        Store.addUserMessage(t);
        await sendMessage(t);
    }, [running, ready]);

    // Tab with empty input accepts the prompt suggestion.
    useInput((_, key) => {
        if (key.tab && !value && promptSuggestion) {
            setValue(promptSuggestion);
            Store.setPromptSuggestion('');
        }
    });


    const showSuggestion = ready && promptSuggestion && !value && !running;
    // Show pending indicator while startup finishes and the user has queued a message.
    const [_tick, _setTick] = useState(0);
    const hasPending = !ready && !!pendingRef.current;
    useEffect(() => {
        if (!hasPending) return;
        const t = setInterval(() => _setTick(n => n + 1), 400);
        return () => clearInterval(t);
    }, [hasPending]);

    return (
        <Box flexDirection="column">
            {suggestions.length > 0 && (
                <Box paddingLeft={2}>
                    <Text dimColor>{suggestions.join('  ')}</Text>
                </Box>
            )}
            {showSuggestion && (
                <Box paddingLeft={2}>
                    <Text dimColor italic>{promptSuggestion}</Text>
                    <Text dimColor> ↹</Text>
                </Box>
            )}
            {hasPending && (
                <Box paddingLeft={2}>
                    <Text color="yellow" dimColor>{`⟳ queued: ${pendingRef.current}`}</Text>
                </Box>
            )}
            <Box>
                <Text color={!ready ? 'yellow' : running ? 'yellow' : 'green'}>
                    {!ready ? '⟳ ' : running ? '⟳ ' : '> '}
                </Text>
                <Box flexGrow={1}>
                    {(() => {
                        const activeModels = dom.window.getActiveMainModelList?.() ?? [];
                        const noModel = activeModels.length === 0;
                        return (
                            <TextInput
                                value={value}
                                onChange={onChange}
                                onSubmit={onSubmit}
                                placeholder={
                                    !ready      ? 'starting… (you can type now)' :
                                    running     ? 'agent running…' :
                                    noModel     ? 'no model — /model <provider|id> to configure…' :
                                    'message…'
                                }
                            />
                        );
                    })()}
                </Box>
            </Box>
        </Box>
    );
}

// ── /resume ───────────────────────────────────────────────────────────────────
// `/resume`    — list sessions for this workspace (most recent first).
// `/resume N`  — restore session N from that list (1-based).
async function runResume(arg?: string): Promise<void> {
    const sessions = await listWorkspaceSessions();

    // No arg — print the list so the user can pick.
    if (!arg) {
        if (!sessions.length) {
            const t = Store.addTurn();
            Store.finalizeTurn(t, '_No previous sessions found for this workspace._');
            return;
        }
        const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
        const lines = [
            '**Previous sessions** — use `/resume N` to restore one:\n',
            ...sessions.map((s, i) => `  **${i + 1}.** ${s.name}  _(last active ${fmt(s.lastAt)})_`),
        ];
        const t = Store.addTurn();
        Store.finalizeTurn(t, lines.join('\n'));
        return;
    }

    // Numeric arg — pick by index.
    const idx = parseInt(arg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        const t = Store.addTurn();
        Store.finalizeTurn(t, `_Invalid session number. Use \`/resume\` to see the list._`);
        return;
    }

    const session = sessions[idx];
    const ok = await resumeSession(session.id);
    const t = Store.addTurn();
    Store.finalizeTurn(t, ok
        ? `Resumed session: **${session.name}**`
        : `_Could not restore session (no messages saved)._`);
}

// ── /export ───────────────────────────────────────────────────────────────────
// Workspace root captured from opts when TuiApp mounts — used by runExport()
// which is module-level (no access to React props).
let _workspaceRoot = process.cwd();

// Writes the current conversation to a dated markdown file in the workspace root.
// Format: alternating ## User / ## Assistant sections, same text shown in the TUI.
async function runExport(workspaceRoot: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const { join }      = await import('node:path');

    const entries = Store.getState().entries;
    if (!entries.length) {
        const t = Store.addTurn();
        Store.finalizeTurn(t, '_Nothing to export — conversation is empty._');
        return;
    }

    const lines: string[] = [];
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);                    // YYYY-MM-DD
    const timeStr = now.toISOString().slice(11, 16).replace(':', ''); // HHmm

    lines.push(`# Chat Export`);
    lines.push(`**Date**: ${now.toLocaleString()}`);
    lines.push(`**Workspace**: ${workspaceRoot}`);
    lines.push('');

    for (const entry of entries) {
        if (entry.type === 'user') {
            lines.push('---', '', `## User`, '', entry.text, '');
        } else {
            const text = entry.turn.finalText?.trim();
            if (text) {
                lines.push(`## Assistant`, '', text, '');
            }
        }
    }

    const filename = `chat-export-${dateStr}-${timeStr}.md`;
    const outPath  = join(workspaceRoot, filename);
    await writeFile(outPath, lines.join('\n'), 'utf8');

    const t = Store.addTurn();
    Store.finalizeTurn(t, `Exported to \`${filename}\``);
}

async function handleSlash(cmd: string) {
    const parts = cmd.split(' ');
    const base  = parts[0];
    switch (base) {
        case '/clear':    newSession(); Store.getState().entries.splice(0); break;
        case '/stop':     stopAgent(); break;
        case '/break':    try { dom.window.stopAfterStep?.(); } catch {} break;
        case '/retry':    try { (globalThis as any).retryLastTurn?.();    } catch {} break;
        case '/rewind':   try { (globalThis as any).rewindToCheckpoint?.(); } catch {} break;
        case '/compact':  await runCompact(); break;
        case '/export':   await runExport(_workspaceRoot); break;
        case '/resume':   await runResume(parts[1]); break;
        case '/project':  Store.setActivePanel('project'); break;
        case '/tasks':    Store.setActivePanel('tasks'); break;
        case '/agent':    Store.setActivePanel('agent'); break;
        case '/model': {
            const spec = parts[1];
            if (spec) _setModel(spec);
            else Store.setActivePanel('model');
            break;
        }
        case '/role': {
            const roleName = parts[1];
            if (roleName) { try { (globalThis as any).setMainAgentRole(roleName); } catch {} }
            else Store.setActivePanel('role');
            break;
        }
        case '/set': {
            const [key, ...valParts] = parts.slice(1);
            if (key && valParts.length) {
                _lsSet(key, valParts.join(' '));
                Store.setActivePanel('settings');
            }
            break;
        }
        case '/skills':   Store.setActivePanel('model'); break;  // model panel lists skills context
        case '/settings': Store.setActivePanel('settings'); break;
        case '/help':     Store.setActivePanel('help'); break;
        // Queue management: /steer N  /queue N  /cancel N  (1-based index)
        case '/steer': case '/queue': case '/cancel': {
            const idx = parseInt(parts[1] ?? '1', 10) - 1;
            const q   = Store.getState().queue;
            const item = q[idx];
            if (item) {
                const mq = dom.window.msgQueue as any;
                if (base === '/cancel') mq?.cancel(item.id);
                else mq?.setMode(item.id, base === '/steer' ? 'steering' : 'queued');
            }
            break;
        }
    }
}

// ── Root app ──────────────────────────────────────────────────────────────────

export function TuiApp({ opts }: { opts: Record<string, any> }) {
    const state = useStore();
    const { columns, rows } = useWindowSize();
    const { exit } = useApp();

    useEffect(() => {
        setMouseHandler(_handleMouseClick);
        setScrollHandler(_handleMouseScroll);
        return () => { setMouseHandler(() => {}); setScrollHandler(() => {}); };
    }, []);

    // Height partitioning (all rows accounted for):
    //   STATUS_HEIGHT + logH + panelH + queueH + INPUT_HEIGHT = rows
    const queueH  = state.queue.length ? state.queue.length + 2 : 0;
    const panelH  = state.activePanel ? PANEL_HEIGHT : 0;
    const logH    = Math.max(1, rows - STATUS_HEIGHT - INPUT_HEIGHT - panelH - queueH);

    useInput((input, key) => {
        // Ctrl-C: soft break if running, hard exit if idle
        if (key.ctrl && input === 'c') {
            if (state.agentRunning) { try { dom.window.stopAfterStep?.(); } catch {} }
            else exit();
            return;
        }
        // Esc: close open panel, or stop generation if none open
        if (key.escape) {
            if (state.activePanel) Store.setActivePanel(state.activePanel); // toggle = close
            else if (state.agentRunning) stopAgent();
            return;
        }
        // Alt+key panel toggles and agent controls
        if (key.meta) {
            if (input === 'n') { Store.getState().entries.splice(0); Store.setActivePanel(null); newSession(); return; }
            if (input === 'p') { Store.setActivePanel('project');  return; }
            if (input === 't') { Store.setActivePanel('tasks');    return; }
            if (input === 'a') { Store.setActivePanel('agent');    return; }
            if (input === ',') { Store.setActivePanel('settings'); return; }
            if (input === 'm') { Store.setActivePanel('model');    return; }
            if (input === 'r') { Store.setActivePanel('role');     return; }
            if (input === 'h') { Store.setActivePanel('help');     return; }
            if (input === 'x') { stopAgent(); return; }
            if (input === 'b') { try { dom.window.stopAfterStep?.(); } catch {} return; }
            if (input === 'u') { try { (globalThis as any).retryLastTurn?.(); } catch {} return; }
        }
        // Scroll event log
        if (key.upArrow)   Store.scroll(1);
        if (key.downArrow) Store.scroll(-1);
    });

    const workspaceRoot: string = opts?.workspaceRoot ?? process.cwd();
    // Keep the module-level variable in sync so handleSlash (no prop access) can use it.
    _workspaceRoot = workspaceRoot;

    return (
        <Box flexDirection="column" width={columns} height={rows}>
            {/* Top: 1-line status bar — model, running state, context fill */}
            <StatusBar agentRunning={state.agentRunning} ready={state.ready} />

            {/* Middle: scrollable conversation log */}
            <EventLog
                height={logH} width={columns}
                entries={state.entries} scrollOffset={state.scrollOffset}
            />

            {/* Optional panel (12 rows) — opens below log, above input */}
            {state.activePanel && (
                <Panel
                    name={state.activePanel}
                    height={PANEL_HEIGHT}
                    workspaceRoot={workspaceRoot}
                />
            )}

            {/* Pending-message queue (collapses when empty) */}
            <QueuePanel queue={state.queue} />

            {/* Bottom: always-visible input line */}
            <InputLine
                ready={state.ready}
                running={state.agentRunning}
                promptSuggestion={state.promptSuggestion ?? ''}
            />
        </Box>
    );
}
