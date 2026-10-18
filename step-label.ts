// Maps raw internal step labels to human-readable verb phrases for the step badges (WebUI and TUI).

export function friendlyLabel(raw: string): string {
    if (!raw) return raw;
    const s = raw.trim();

    // Worker role labels — e.g. "worker:W1:researcher", "worker:W2:coder"
    if (s.startsWith('worker:')) {
        const parts = s.slice(7).split(':');
        // Label format is "worker:id:role" — role is always parts[1] (line 1011 in workers.ts
        // guarantees every agent has a role before labels are built; id is an internal key).
        const id = parts[1].toLowerCase();
        if (/director/i.test(id))             return 'Directing';
        if (/orchestrat/i.test(id))           return 'Orchestrating';
        if (/planner?$/i.test(id) || id === 'plan' || id === 'replan') return 'Planning';
        if (/research/i.test(id))             return 'Researching';
        if (/cod(e|er|ing)/i.test(id))        return 'Coding';
        if (/synthes/i.test(id))              return 'Synthesising';
        if (/reduc/i.test(id))                return 'Reducing';
        if (/review/i.test(id))               return 'Reviewing';
        if (/config.*read|read.*config/i.test(id)) return 'Reading config';
        if (/ui.*config|config.*ui/i.test(id))     return 'Reading UI config';
        if (/task.*find|find.*task/i.test(id))     return 'Finding tasks';
        if (/search/i.test(id))               return 'Searching';
        if (/find/i.test(id))                 return 'Finding';
        if (/read/i.test(id))                 return 'Reading';
        if (/write|generat|creat/i.test(id))  return 'Writing';
        if (/analys|analyz/i.test(id))        return 'Analysing';
        if (/test|verif/i.test(id))           return 'Verifying';
        if (/fix|patch|repair/i.test(id))     return 'Fixing';
        if (/plan/i.test(id))                 return 'Planning';
        if (/locat|disambig/i.test(id))       return 'Locating';
        if (/resolv/i.test(id))               return 'Resolving';
        // Capitalise unknown role ids, replacing underscores/hyphens with spaces
        return id.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Special named steps
    if (/^Thinking/i.test(s))           return 'Working';
    if (/^compact/i.test(s))            return 'Compacting';
    if (/summariz/i.test(s))            return 'Synthesising';

    if (/resolv.*conflict/i.test(s))    return 'Resolving';
    if (s.startsWith('read:'))          return 'Reading';
    if (s.startsWith('write:'))         return 'Writing';
    if (s.startsWith('replace:') && s.includes('ledger.md')) return 'Updating ledger';
    if (s.startsWith('replace:'))       return 'Editing';
    if (s.startsWith('patch:'))         return 'Patching';
    if (s.startsWith('append:'))        return 'Appending';
    if (s.startsWith('del:'))           return 'Deleting';
    if (s.startsWith('undo:'))          return 'Undoing';
    if (s.startsWith('search:'))        return 'Searching';
    if (s.startsWith('wiki:'))          return 'Looking up';
    if (s.startsWith('fetch:'))         return 'Fetching';
    if (s.startsWith('context7_'))     return 'Looking up docs';
    if (s.startsWith('grep:'))          return 'Searching';
    if (s.startsWith('arxiv:'))         return 'Researching';
    if (s.startsWith('s2:'))            return 'Researching';
    if (s.startsWith('sem:'))           return 'Searching';
    if (s.startsWith('repo_map'))       return 'Mapping';
    if (s.startsWith('exec('))          return 'Executing';
    if (s.startsWith('workers(')) {
        // Parse role from "id:role" segments, e.g. "workers(news:researcher,code:coder)"
        const inner = s.slice(8, -1);
        const roles = inner ? inner.split(',').map(a => { const p = a.split(':'); return p[1] || ''; }).filter(Boolean) : [];
        const r = roles[0] || '';
        if (/research/i.test(r))              return 'Researching';
        if (/cod(e|er|ing)/i.test(r))         return 'Coding';
        if (/synthes/i.test(r))               return 'Synthesising';
        if (/review/i.test(r))                return 'Reviewing';
        if (/planner?$|^plan$/i.test(r))      return 'Planning';
        if (/director|orchestrat/i.test(r))   return 'Directing';
        if (/find|search/i.test(r))           return 'Searching';
        if (/write|generat|creat/i.test(r))   return 'Writing';
        return 'Delegating';
    }
    if (s.startsWith('task:'))          return 'Updating task';
    // entity memory removed
    if (s.startsWith('git '))           return 'Git';
    if (s === 'list_files')             return 'Listing files';
    if (s.startsWith('<handover>') || s === 'handover') return 'Handing over';

    // Fallback for any unrecognized label. Strip angle-bracket markup and clamp length so a
    // malformed input (e.g. a model emitting an XML block as a tool name) can't dump a wall
    // of text or raw tags into a step badge.
    const clean = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 45) + '…' : clean;
}
