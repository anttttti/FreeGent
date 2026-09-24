// tools.js — FreeGent: tool specs, search implementations, tool execution, system prompt
// Depends on: config.js, workspace.js, fetch-blacklist.js, history.js. All top-level consts are module-private.

import { annotateUrl, blacklistAdd, blacklistRemove, stripUnavailable } from './fetch-blacklist.js';
import { checkFetchAllowed, isFetchAllowActive } from './fetch-allow.js';
import { _invalidateReadDedup } from './history.js';

const _REPO_MAP_EXT = {
    js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript',
    ts:'typescript', tsx:'typescript',
    py:'python', pyw:'python',
    go:'go', rs:'rust', java:'java',
    c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp',
    rb:'ruby', php:'php', swift:'swift', kt:'kotlin', kts:'kotlin',
    cs:'csharp', sh:'bash', bash:'bash', sql:'sql',
};

function _rmLang(filename) {
    return _REPO_MAP_EXT[filename.split('.').pop()?.toLowerCase() || ''] || null;
}

function _rmStripComments(content, lang) {
    if (lang === 'javascript' || lang === 'typescript') {
        content = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
        content = content.replace(/\/\/[^\n]*/g, '');
    } else if (lang === 'python' || lang === 'ruby') {
        content = content.replace(/#[^\n]*/g, '');
    }
    return content;
}

function _rmSymbols(filename, content, lang) {
    content = _rmStripComments(content, lang);
    const nodes = [];
    const add = (name, type) => nodes.push({ label: name, type });
    if (lang === 'javascript' || lang === 'typescript') {
        let m;
        const fnDecl = /(?:^|[\s;{}(,])\bfunction\s+(\w+)\s*[\w<(]/gm;
        while ((m = fnDecl.exec(content)) !== null) add(m[1], 'function');
        const arrow = /(?:^|[\s;{}])(?:export\s+)?(?:async\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$_]+)\s*=>/gm;
        while ((m = arrow.exec(content)) !== null) add(m[1], 'function');
        const cls = /(?:^|[\s;{}])(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
        const iface = /(?:^|[\s;{}])(?:export\s+)?interface\s+(\w+)/gm;
        while ((m = iface.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'python') {
        let m;
        const fn = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const cls = /^class\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'go') {
        let m;
        const fn = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*[(<]/gm;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const typ = /^type\s+(\w+)\s+(?:struct|interface)/gm;
        while ((m = typ.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'rust') {
        let m;
        const fn = /(?:^|\s)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/gm;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const st = /(?:^|\s)(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm;
        while ((m = st.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'java') {
        let m;
        const fn = /(?:public|private|protected|static|final|native|synchronized|abstract)\s+(?:[\w<>\[\]]+\s+)+(\w+)\s*\([^)]*\)\s*(?:throws[^{]+)?\{/g;
        while ((m = fn.exec(content)) !== null) { if (!['if','while','for','switch'].includes(m[1])) add(m[1], 'function'); }
        const cls = /(?:public|private|protected)?\s+(?:abstract\s+)?(?:class|interface)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'csharp') {
        let m;
        const fn = /(?:public|private|protected|internal|static|virtual|override|abstract)\s+(?:async\s+)?[\w<>\[\]?]+\s+(\w+)\s*\([^)]*\)\s*(?:where[^{]+)?\{/g;
        while ((m = fn.exec(content)) !== null) { if (!['if','while','for','switch','using','lock'].includes(m[1])) add(m[1], 'function'); }
        const cls = /(?:public|private|protected|internal)?\s+(?:abstract\s+|sealed\s+)?class\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'ruby') {
        let m;
        const fn = /^\s*def\s+(\w+[?!]?)/gm;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const cls = /^class\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'swift') {
        let m;
        const fn = /(?:func|init)\s+(\w+)\s*[<(]/g;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const cls = /(?:class|struct|enum|protocol)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    } else if (lang === 'kotlin') {
        let m;
        const fn = /(?:fun|suspend fun)\s+(\w+)\s*[<(]/g;
        while ((m = fn.exec(content)) !== null) add(m[1], 'function');
        const cls = /(?:class|object|interface|data class|sealed class)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) add(m[1], 'class');
    }
    return nodes;
}


const _fileCheckpoints = new Map(); // path → string[]

// Paths written by blocked workers that must be read back before any edit.
const _requireReadBack = new Set();

function _pushCheckpoint(path, content) {
    if (!_fileCheckpoints.has(path)) _fileCheckpoints.set(path, []);
    _fileCheckpoints.get(path).push(content);
}

// Normalize a path supplied to a file tool so that the model's use of the WASM bash
// mount prefix (/workspace/) never breaks read_file / write_file / replace_in_file /
// apply_patch / delete_file.  Those tools always operate on plain relative paths stored
// in IDB; /workspace/ is the bash-internal mount point and is not a valid prefix here.
// Also strips a lone leading / (e.g. /tictactoe.html → tictactoe.html).
function _normToolPath(p: string): string {
    if (!p) return p;
    if (p.startsWith('/workspace/')) return p.slice('/workspace/'.length);
    if (p === '/workspace') return '';
    if (p.startsWith('/')) return p.slice(1);
    return p;
}


// Patterns that detect LLM-generated truncation markers inside write_file content.
// // and # comment styles share identical structure so each pair is merged into one regex.
const _TRUNCATION_RE = [
    // Inline-comment markers: "// ..." / "# ..."  followed by rest/existing/same/etc.
    /(\/\/|#)\s*\.{3}\s*(rest|existing|previous|same|more|etc\.?)/i,
    // Inline-comment "rest of file/code/…"
    /(\/\/|#)\s*(rest|remaining)\s+(of\s+)?(the\s+)?(file|code|content|implementation|functions?|methods?)/i,
    // Bracket markers: [...existing code...], [rest of file], [same as before], etc.
    /\[\s*(\.{3}\s*(rest|existing|unchanged|same|previous)|existing\s+(code|content|implementation|functions?)|rest\s+of\s+(file|code|content)|(same|unchanged)\s+as\s+(before|above|original))[^\]]*\]/i,
    // Exact bracket phrases
    /\[(omitted for brevity|code continues)\]/i,
    // HTML/block-comment markers: <!-- ... rest  and  /* ... rest
    /(<!--\s*|\/\*[\s*]*)\.{3}\s*(rest|existing|same|more)/i,
    // Parenthesised markers
    /\(\s*rest\s+of\s+(file|code|content)\s+(unchanged|omitted|same)\s*\)/i,
    // Trailing-comment markers: "... // rest" / "... # rest"
    /\.\.\.\s*(\/\/|#)\s*(rest|same|more|end\s+of)/i,
];

function _hasTruncationMarkers(content) {
    return _TRUNCATION_RE.some(re => re.test(content));
}

const _SHRINK_MIN_OLD   = 600;  // only guard files larger than this
const _SHRINK_THRESHOLD = 0.60; // block if new content < 60% of old

// read_file: inline full content up to this many chars; above it, a snippet is shown and the
// user/model must explicitly paginate via start_line/end_line.
const _READ_INLINE_MAX  = 50_000;

// list_files result cap — prevents the tool from overwhelming context on huge trees.
const _LIST_FILES_CAP   = 500;

// search_workspace: hard cap on total returned matches; also the max display chars per match line.
const _SEARCH_MAX_MATCHES    = 500;
const _SEARCH_LINE_DISPLAY   = 500;

function _shrinkError(path, oldLen, newLen) {
    return `write_file: Content shrank from ${oldLen} to ${newLen} chars (${Math.round(newLen / oldLen * 100)}% of original) for "${path}". `
        + `This usually means content was dropped. Use replace_in_file or apply_patch for targeted edits, `
        + `or read the file first and include ALL existing sections in your write.`;
}


const _EDIT_REVIEW_MIN_OLD = 400;    // don't review edits to tiny files
const _EDIT_REVIEW_THRESHOLD = 0.50; // fraction of lines changed that triggers review

// search_workspace: skip files over this size without a path_filter (avoids context blowup).
const _SEARCH_FILE_SIZE_CAP = 300_000;

// repo_map: scan at most this many files when no path_filter is given / when one is given.
const _REPO_MAP_LIMIT_UNFILTERED = 50;
const _REPO_MAP_LIMIT_FILTERED   = 300;

function _changeRatio(oldContent, newContent) {
    // Multiset Jaccard: count each line occurrence so duplicate lines aren't collapsed.
    // A file with 100 identical lines produces 100 counts, not 1.
    const toCounts = (s: string) => {
        const m = new Map<string, number>();
        for (const l of s.split('\n')) {
            const t = l.trim();
            if (t) m.set(t, (m.get(t) ?? 0) + 1);
        }
        return m;
    };
    const A = toCounts(oldContent), B = toCounts(newContent);
    let inter = 0, union = 0;
    const keys = new Set([...A.keys(), ...B.keys()]);
    if (keys.size === 0) return 0;
    for (const k of keys) {
        const a = A.get(k) ?? 0, b = B.get(k) ?? 0;
        inter += Math.min(a, b);
        union += Math.max(a, b);
    }
    return union === 0 ? 0 : 1 - inter / union;
}

async function _reviewFileEdit(path, oldContent, newContent) {
    // Deterministic bands before the LLM review: unmistakable truncation-style
    // content loss → REJECT free; content grew → APPROVE free (no truncation possible);
    // everything between → LLM review as before.
    const _placeholder = /\/\/ \.\.\.|\/\* \.\.\. \*\/|# \.\.\.|rest of (the )?(code|file|function)|remains? (the )?same|unchanged (code|content)|\.\.\. existing|content here\b/i;
    if (newContent.length < oldContent.length * 0.3 && _placeholder.test(newContent))
        return { approved: false, reason: 'new content is a small fraction of the original and contains placeholder markers — content was dropped' };
    if (newContent.length >= oldContent.length)
        return { approved: true };
    const trunc = (s, n) => s.length <= n ? s : s.slice(0, n - 120) + '\n...[truncated]...\n' + s.slice(-120);
    const intent = _currentUserIntent
        ? `\nUser intent: "${_currentUserIntent.slice(0, 200)}"` : '';
    const prompt =
        `You are reviewing a large file edit produced by an AI agent. Determine if the edit is correct and complete, or if content was accidentally dropped.\n` +
        `File: ${path}${intent}\n` +
        `Before (${oldContent.length} chars):\n\`\`\`\n${trunc(oldContent, 2500)}\n\`\`\`\n\n` +
        `After (${newContent.length} chars):\n\`\`\`\n${trunc(newContent, 2500)}\n\`\`\`\n\n` +
        `Check for:\n` +
        `1. Functions, classes, or sections present before but missing after\n` +
        `2. Placeholder comments standing in for omitted content\n` +
        `3. Obviously broken or incomplete code\n\n` +
        `Reply with exactly:\nAPPROVE\nor\nREJECT: [one-line reason]`;
    try {
        // temperature: 0 — binary APPROVE/REJECT classification; deterministic is better.
        const result = await callLLMComplete(prompt, { temperature: 0, label: 'worker:review:review' });
        const trimmed = result.trim();
        if (/^REJECT/i.test(trimmed)) {
            const reason = trimmed.replace(/^REJECT[:\s]*/i, '').trim() || 'Reviewer rejected the edit';
            return { approved: false, reason };
        }
        return { approved: true };
    } catch (e) {
        return { approved: true }; // fail open — don't block on reviewer errors
    }
}


const _IV_HIGH_RISK = new Set(['fetch_url', 'execute_code', 'write_file', 'delete_file']);

const _IV_INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions?/i,
    /disregard\s+(your|all|the)\s+(previous\s+)?instructions?/i,
    /forget\s+(your\s+)?(task|instructions?|goals?|previous)/i,
    /your\s+(new|real|actual|true)\s+(task|goal|instructions?|objective)/i,
    /you\s+are\s+now\s+(an?\s+\w+|instructed)/i,
    /override\s+(your\s+)?instructions?/i,
    /\[SYSTEM]\s*:/i,
    /\[INST]|\[\/INST]/,
    /act\s+as\s+(if\s+you\s+are\s+)?a\s+\w+\s+that/i,
    /new\s+task\s*:/i,
    /stop\s+what\s+you('?re| are)\s+doing/i,
];

const _IV_SENSITIVE_PATH = /(?:^|[/\\])\.(?:ssh|gnupg|aws|env(?:ironments?)?|config|netrc)(?:[/\\]|$)|(?:id_rsa|\.pem|\.key|\.bash_history|\.zsh_history)(?:\b|$)/i;

const _IV_PATH_TRAVERSAL_RE = /\.\.[\/\\]/;

function _ivCheck(name, args) {
    const argsStr = JSON.stringify(args);
    for (const pat of _IV_INJECTION_PATTERNS) {
        if (pat.test(argsStr)) {
            return { level: 'block', reason: `Injection phrase in ${name}() args: "${argsStr.slice(0, 120)}"` };
        }
    }

    if (name === 'write_file' || name === 'delete_file') {
        const path = args.path || '';
        if (_IV_PATH_TRAVERSAL_RE.test(path)) return { level: 'block', reason: `Path traversal in ${name}: ${path}` };
        if (_IV_SENSITIVE_PATH.test(path)) return { level: 'block', reason: `Sensitive path in ${name}: ${path}` };
    }

    return null;
}

async function _ivLog(name, args, check) {
    try {
        const line = `${new Date().toISOString()}  [${check.level.toUpperCase()}]  ${name}(${JSON.stringify(args).slice(0, 200)})  — ${check.reason}\n`;
        const existing = await agentReadFile('memory/injection-attempts.md').catch(() => '');
        await agentWriteFile('memory/injection-attempts.md', existing + line);
    } catch {}
}

// context = { snapshot: Map, staging: Map } for workers, null for main agent

// ── Tool approval ──────────────────────────────────────────────────────────

const _toolApprovalSession = new Set(); // tools the user has whitelisted for this session
let   _approvalResolve     = null;

function requestToolApproval(toolName, args) {
    const toast   = document.getElementById('tool-approval-toast');
    const label   = document.getElementById('tool-approval-label');
    const sesName = document.getElementById('tool-approval-session-name');
    const sesCb   = document.getElementById('tool-approval-session') as HTMLInputElement | null;
    if (!toast) return Promise.resolve(true);

    // Build a one-line summary of what the call will do
    let summary = toolName;
    if (args.path)     summary += `: ${args.path}`;
    if (args.language) summary += ` (${args.language})`;
    if (label)   label.textContent   = summary;
    if (sesName) sesName.textContent = toolName;
    if (sesCb)   sesCb.checked       = false;
    toast.style.display = '';

    return new Promise(resolve => { _approvalResolve = resolve; });
}

function resolveToolApproval(allowed) {
    const toast = document.getElementById('tool-approval-toast');
    const sesCb = document.getElementById('tool-approval-session') as HTMLInputElement | null;
    const label = document.getElementById('tool-approval-session-name');
    if (allowed && sesCb?.checked && label?.textContent)
        _toolApprovalSession.add(label.textContent);
    if (toast) toast.style.display = 'none';
    if (_approvalResolve) { _approvalResolve(allowed); _approvalResolve = null; }
}

window.resolveToolApproval = resolveToolApproval;

const _APPROVAL_HIGH_RISK = new Set(['delete_file', 'execute_code']);
const _APPROVAL_ALL_WRITE = new Set(['delete_file', 'execute_code', 'write_file', 'apply_patch', 'replace_in_file']);

// ── apply_patch helpers: fuzzy offset correction + LLM disambiguation ────────

function _hunkOriginalLines(hunk) {
    return hunk.lines.filter(l => l[0] === ' ' || l[0] === '-').map(l => l.slice(1)).join('\n');
}

function _findNeedleInFile(fileLines, needle) {
    if (!needle) return [];
    const nl = needle.split('\n');
    const results = [];
    for (let i = 0; i <= fileLines.length - nl.length; i++) {
        if (fileLines.slice(i, i + nl.length).join('\n') === needle) results.push(i + 1); // 1-based
    }
    return results;
}


async function _disambiguatePatchHunk(filePath, hunk, candidateLines, fileLines) {
    if (candidateLines.length === 0 || typeof callLLMComplete !== 'function') return null;
    const removed = hunk.lines.filter(l => l[0] === '-').map(l => l.slice(1)).join('\n');
    const added   = hunk.lines.filter(l => l[0] === '+').map(l => l.slice(1)).join('\n');
    const candidateBlocks = candidateLines.map((ln, i) => {
        const ctx = fileLines.slice(Math.max(0, ln - 3), ln + 5).join('\n');
        return `Candidate ${i + 1} (line ${ln}):\n${ctx}`;
    }).join('\n\n');
    const prompt = `A patch for "${filePath}" removes:\n\`\`\`\n${removed}\n\`\`\`\nand adds:\n\`\`\`\n${added}\n\`\`\`\n\nThis content was found at multiple places. Reply with only the candidate number (1, 2, …) that is the correct edit target.\n\n${candidateBlocks}`;
    try {
        const text = await callLLMComplete(prompt, { temperature: 0, maxTokens: 8, label: 'worker:locate:locate' });
        const n = parseInt(text.trim());
        return (!isNaN(n) && n >= 1 && n <= candidateLines.length) ? candidateLines[n - 1] : null;
    } catch { return null; }
}

async function _tryFixPatchOffsets(filePath, original, patch, jsdiff) {
    let parsed;
    try { parsed = jsdiff.parsePatch(patch); } catch { return null; }
    if (!parsed?.length) return null;
    const fileLines = original.split('\n');
    const hunks = parsed[0].hunks;
    const corrections = [];
    for (const hunk of hunks) {
        const needle = _hunkOriginalLines(hunk);
        const found  = _findNeedleInFile(fileLines, needle);
        if (found.length === 0) {
            return { hint: `Hunk starting at line ${hunk.oldStart} not found anywhere in the file — the code may have already changed or the context lines are wrong.` };
        }
        const correctLine = found.length === 1 ? found[0] : await _disambiguatePatchHunk(filePath, hunk, found, fileLines);
        if (correctLine == null) {
            return { hint: `Hunk at line ${hunk.oldStart} matches multiple locations (${found.join(', ')}). Add more context lines to make the hunk unambiguous.` };
        }
        corrections.push({ hunk, correctLine });
    }
    // Rewrite @@ headers with corrected offsets
    let fixedPatch = patch;
    for (const { hunk, correctLine } of corrections) {
        const delta = correctLine - hunk.oldStart;
        if (delta === 0) continue;
        fixedPatch = fixedPatch.replace(
            new RegExp(`@@ -${hunk.oldStart}(,\\d+)? \\+${hunk.newStart}(,\\d+)? @@`),
            (_, oc, nc) => `@@ -${correctLine}${oc || ''} +${hunk.newStart + delta}${nc || ''} @@`
        );
    }
    const result = jsdiff.applyPatch(original, fixedPatch, { fuzzFactor: 2 });
    if (result === false) return null;
    const shifted = corrections.filter(c => c.correctLine !== c.hunk.oldStart);
    return { result, note: shifted.length ? `Auto-corrected line offsets: ${shifted.map(c => `${c.hunk.oldStart}→${c.correctLine}`).join(', ')}` : undefined };
}

// Recompute @@ -a,b +c,d @@ counts from the actual body lines so models that miscalculate
// the counts (81% of apply_patch errors) don't fail. Returns the corrected patch and
// an array of correction descriptions (non-empty when any header was changed).
export function _rewriteHunkCounts(patch: string): { patch: string; corrections: string[] } {
    const lines = patch.split('\n');
    const out: string[] = [];
    const corrections: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? (@@.*)$/);
        if (!m) { out.push(lines[i++]); continue; }
        const [, oldStart, oldCountRaw, newStart, newCountRaw, rest] = m;
        // Collect body until next hunk header or file diff header
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('@@ ') && !lines[j].startsWith('--- ') && !lines[j].startsWith('+++ ')) {
            body.push(lines[j++]);
        }
        let oldCount = 0, newCount = 0;
        for (const l of body) {
            if (l[0] === ' ' || l[0] === '-') oldCount++;
            if (l[0] === ' ' || l[0] === '+') newCount++;
        }
        const expectedOld = oldCountRaw != null ? parseInt(oldCountRaw, 10) : 1;
        const expectedNew = newCountRaw != null ? parseInt(newCountRaw, 10) : 1;
        if (oldCount !== expectedOld || newCount !== expectedNew) {
            corrections.push(`@@ -${oldStart},${expectedOld} +${newStart},${expectedNew} @@ → -${oldStart},${oldCount} +${newStart},${newCount}`);
        }
        out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} ${rest}`);
        for (const l of body) out.push(l);
        i = j;
    }
    return { patch: out.join('\n'), corrections };
}

// Score how well needle matches haystack: count shared trigrams (length-normalized).
function _fuzzyScore(needle: string, haystack: string): number {
    if (!needle || !haystack) return 0;
    const trigrams = (s: string) => { const t = new Set<string>(); for (let i = 0; i < s.length - 2; i++) t.add(s.slice(i, i + 3)); return t; };
    const n = trigrams(needle), h = trigrams(haystack);
    let shared = 0; for (const t of n) if (h.has(t)) shared++;
    return shared / Math.max(n.size, 1);
}

// ---- Per-tool handler functions --------------------------------------------------------
// Self-contained handlers extracted from executeToolAsync for readability.
// Each receives (args, context) and returns the tool result Promise.
// Large handlers (run_workers, list_files, read_file, write_file, replace_in_file,
// apply_patch, execute_code, web_search, fetch_url, generate_image) remain inline.

async function _handleAstQuery(args: any) {
    if (!getAstEnabled()) return { error: 'ast_query is disabled. Enable it in Settings → Code Execution.' };
    try {
        const content = await agentReadFile(args.path).catch(() => null);
        if (content === null) return { error: `ast_query: file not found: ${args.path}` };
        const lang = _rmLang(args.path);
        if (!lang) return { error: `ast_query: unsupported file type: ${args.path}` };
        const results = _astQueryContent(content, lang, args.query || 'symbols');
        const text = _astFormatResults(results, args.query || 'symbols', args.path);
        return { results, text, count: results.length };
    } catch (e) { return { error: `ast_query: ${e.message}` }; }
}

async function _handleRunGit(args: any) {
    if (!getGitEnabled() || getSandboxProvider() !== 'local')
        return { error: 'run_git requires Local Sandbox and Git access enabled in Settings → Code Execution.' };
    // Normalise: accept command string/array aliases; strip leading "git" if included
    let gitArgs = args.args ?? args.command ?? args.cmd ?? args.arguments ?? [];
    if (typeof gitArgs === 'string') gitArgs = gitArgs.trim().replace(/^git\s+/, '').split(/\s+/);
    else if (Array.isArray(gitArgs) && gitArgs[0] === 'git') gitArgs = gitArgs.slice(1);
    try {
        const resp = await fetch('/api/git', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: gitArgs }),
        });
        if (!resp.ok) return { error: `run_git: HTTP ${resp.status}` };
        const gitResult = await resp.json();
        return gitResult;
    } catch (e) { return { error: `run_git: ${e.message}` }; }
}

async function _handleUndoWrite(args: any) {
    const stack = _fileCheckpoints.get(args.path);
    if (!stack || !stack.length) return { error: `undo_write: no checkpoint for "${args.path}" in this session.` };
    const previous = stack.pop();
    try {
        if (previous === '') {
            await agentDeleteFile(args.path);
            return { success: true, path: args.path, note: 'File deleted (it did not exist before the write).' };
        }
        await agentWriteFile(args.path, previous);
        return { success: true, path: args.path, bytes: previous.length, note: 'Restored previous content.' };
    } catch (e) { return { error: `undo_write: ${e.message}` }; }
}

async function _handleDeleteFile(args: any, context: any) {
    args = { ...args, path: _normToolPath(args.path ?? '') };
    if (context) { context.staging.set(args.path, null); return { success: true }; }
    try   { await agentDeleteFile(args.path); return { success: true }; }
    catch (e) { return { error: e.message }; }
}

async function _handleAppendFile(args: any, context: any) {
    args = { ...args, content: args.content ?? args.text ?? args.body ?? args.data ?? '' };
    const doAppend = async (read: () => Promise<string>, write: (c: string) => Promise<void>) => {
        const existing = await read().catch(() => '');
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        const newContent = existing + sep + args.content;
        await write(newContent);
        return { success: true, path: args.path, bytes: newContent.length };
    };
    if (context) {
        return doAppend(
            async () => {
                if (context.staging.has(args.path)) return context.staging.get(args.path) ?? '';
                return context.snapshot.get(args.path) ?? '';
            },
            async c => context.staging.set(args.path, c)
        );
    }
    try {
        return doAppend(
            () => agentReadFile(args.path),
            c  => agentWriteFile(args.path, c)
        );
    } catch (e) { return { error: e.message }; }
}

async function _handleDeepResearch(args: any) {
    return runDeepResearch(args.question ?? args.topic ?? args.query ?? '', args);
}

async function _handleContext7Docs(args: any) {
    try {
        const library_id = await callMCPTool(MCP_CONTEXT7_URL, 'resolve-library-id', { libraryName: args.library ?? args.library_id });
        const mcpArgs: any = { context7CompatibleLibraryId: library_id.trim() };
        if (args.topic)  mcpArgs.topic  = args.topic;
        if (args.tokens) mcpArgs.tokens = args.tokens;
        const result = await callMCPTool(MCP_CONTEXT7_URL, 'get-library-docs', mcpArgs);
        return { content: result };
    } catch (e) { return { error: `context7_docs: ${e.message}` }; }
}

async function _handleAcademicSearch(args: any) {
    const src = (args.source || 'arxiv').toLowerCase();
    const n   = Math.min(args.max_results || 5, 10);
    if (src === 'arxiv') {
        try {
            const rawQ = (args.query || '').replace(/\s+/g, '+');
            // Preserve field prefixes (ti:, au:, abs:, cat:) — only prepend 'all:' for plain queries.
            const q    = encodeURIComponent(rawQ);
            const searchQ = /^[a-z]+:/.test(rawQ.trim()) ? q : `all:${q}`;
            const url = `https://export.arxiv.org/api/query?search_query=${searchQ}&max_results=${n}&sortBy=relevance`;
            const proxy = getEffectiveProxy();
            const resp = await fetch(proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `arXiv HTTP ${resp.status}` };
            const xml = await resp.text();
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const NS  = 'http://www.w3.org/2005/Atom';
            const get = (el, tag) => el.getElementsByTagNameNS(NS, tag)[0]?.textContent?.trim() || '';
            return { results: [...doc.getElementsByTagNameNS(NS, 'entry')].map(e => ({
                title: get(e, 'title').replace(/\s+/g, ' '),
                authors: [...e.getElementsByTagNameNS(NS, 'author')].map(a => get(a, 'name')).slice(0, 3).join(', '),
                abstract: get(e, 'summary').replace(/\s+/g, ' ').slice(0, 350),
                url: get(e, 'id'), published: get(e, 'published').slice(0, 10)
            })) };
        } catch (e) { return { error: `academic_search/arxiv: ${e.message}` }; }
    }
    if (src === 'semantic_scholar') {
        try {
            const q    = encodeURIComponent(args.query || '');
            const url  = `https://api.semanticscholar.org/graph/v1/paper/search?query=${q}&fields=title,abstract,url,year,authors,citationCount&limit=${n}`;
            const proxy = getEffectiveProxy();
            const resp  = await fetch(proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `Semantic Scholar HTTP ${resp.status}` };
            const data  = await resp.json();
            return { results: (data.data || []).map(p => ({
                title: p.title, authors: (p.authors || []).map(a => a.name).slice(0, 3).join(', '),
                abstract: (p.abstract || '').slice(0, 350),
                url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
                year: p.year, citations: p.citationCount
            })) };
        } catch (e) { return { error: `academic_search/semantic_scholar: ${e.message}` }; }
    }
    if (src === 'crossref') {
        try {
            const q    = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://api.crossref.org/works?query=${q}&rows=${n}`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `CrossRef HTTP ${resp.status}` };
            const data = await resp.json();
            return { results: (data.message?.items || []).map(i => `\n1. [${i.title?.[0]}] — ${i.DOI || 'N/A'}\n   ${i.author?.map(a => a.family).slice(0, 3).join(', ') || ''} | ${i.published?.['date-parts']?.[0]?.[0] || ''} | citations: ${i['is-referenced-by-count'] || 0}`).join('') };
        } catch (e) { return { error: `academic_search/crossref: ${e.message}` }; }
    }
    if (src === 'pubmed') {
        try {
            const q        = encodeURIComponent(args.query || '');
            const searchResp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${q}&retmode=json&retmax=${n}`, { signal: activeAbortController?.signal });
            if (!searchResp.ok) return { error: `PubMed HTTP ${searchResp.status}` };
            const ids = (await searchResp.json()).esearchresult?.idlist || [];
            if (!ids.length) return { results: [] };
            const fetchResp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml`, { signal: activeAbortController?.signal });
            if (!fetchResp.ok) return { error: `PubMed fetch HTTP ${fetchResp.status}` };
            const doc = new DOMParser().parseFromString(await fetchResp.text(), 'application/xml');
            return { results: [...doc.getElementsByTagName('PubmedArticle')].map(a => `\n1. [${a.getElementsByTagName('ArticleTitle')[0]?.textContent || ''}] — PMID:${a.getElementsByTagName('PMID')[0]?.textContent || ''}\n   ${a.getElementsByTagName('AbstractText')[0]?.textContent?.slice(0, 150) || ''}`).join('') };
        } catch (e) { return { error: `academic_search/pubmed: ${e.message}` }; }
    }
    return { error: `academic_search: unknown source "${args.source}"` };
}

async function _handlePackageSearch(args: any) {
    const reg = (args.registry || 'npm').toLowerCase();
    if (reg === 'npm') {
        try {
            const q    = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://registry.npmjs.org/-/v1/search?text=${q}&size=10`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `npm HTTP ${resp.status}` };
            const data = await resp.json();
            return { results: (data.objects || []).map(o => `\n1. [${o.package.name}] — ${o.package.links.npm}\n   ${o.package.description || 'N/A'} | Version: ${o.package.version}`).join('') };
        } catch (e) { return { error: `package_search/npm: ${e.message}` }; }
    }
    if (reg === 'pypi') {
        try {
            const q = encodeURIComponent(args.query || '');
            // PyPI JSON API only does exact package lookup; use the search endpoint via fetch
            const resp = await fetch(`https://pypi.org/pypi/${q}/json`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `PyPI HTTP ${resp.status}` };
            const data = await resp.json();
            return { results: `\n1. [${data.info.name}] — ${data.info.package_url}\n   ${data.info.summary || 'N/A'} | Version: ${data.info.version} | Homepage: ${data.info.home_page || 'N/A'}` };
        } catch (e) { return { error: `package_search/pypi: ${e.message}` }; }
    }
    return { error: `package_search: unknown registry "${args.registry}"` };
}

async function _handleRepoMap(args: any) {
    try {
        const filter = (args.path_filter || '').toLowerCase();
        const files  = await agentListFiles();
        // Without a path_filter, cap to avoid multi-minute scans on large repos.
        // With a filter, allow more — the user has already narrowed the scope.
        const FILE_LIMIT = filter ? _REPO_MAP_LIMIT_FILTERED : _REPO_MAP_LIMIT_UNFILTERED;
        const eligible = files.filter(f => (!filter || f.name.toLowerCase().includes(filter)) && _rmLang(f.name));
        const truncated = eligible.length > FILE_LIMIT;
        const toScan = truncated ? eligible.slice(0, FILE_LIMIT) : eligible;
        const lines = [];
        for (const f of toScan) {
            const content = await agentReadFile(f.name).catch(() => '');
            const symbols = _rmSymbols(f.name, content, _rmLang(f.name));
            if (!symbols.length) continue;
            const classes = symbols.filter(s => s.type === 'class').map(s => `[${s.label}]`);
            const fns     = symbols.filter(s => s.type === 'function').map(s => s.label + '()');
            lines.push(`${f.name}: ${[...classes, ...fns].join(', ')}`);
        }
        if (!lines.length) return { map: '(no code symbols found)', files_scanned: toScan.length };
        return { map: lines.join('\n'), files_mapped: lines.length, files_scanned: toScan.length, ...(truncated && { note: `Scanned first ${FILE_LIMIT} of ${eligible.length} matching files. Use path_filter to narrow the scope (e.g. "src/components").` }) };
    } catch (e) { return { error: `repo_map: ${e.message}` }; }
}

async function _handleSearchWorkspace(args: any) {
    args = { ...args, pattern: args.pattern ?? args.query ?? args.search ?? args.term ?? args.text ?? args.expr ?? '' };
    if (!args.pattern) return { error: 'search_workspace: missing required argument "pattern". Use: search_workspace({"pattern": "text to find"})' };
    try {
        const pattern      = args.pattern || '';
        const isRegex      = !!args.is_regex;
        const caseSensitive = args.is_regex ? (args.case_sensitive !== false) : !!args.case_sensitive;
        const pathFilter   = (args.path_filter || '').toLowerCase().split('|').map(s => s.trim()).filter(Boolean);
        const ctxLines     = Math.min(Math.max(0, args.context_lines || 0), 50);
        const maxMatches   = Math.min(args.max_matches || 100, _SEARCH_MAX_MATCHES);
        // scope: 'both' (default) matches filenames AND contents; 'contents' is a plain grep;
        // 'names' matches filenames only. Case-insensitive per args.case_sensitive.
        const scope = String(args.scope ?? 'both').toLowerCase();

        let re;
        if (isRegex) {
            re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
        } else {
            // Split on | to allow multi-term literal search (e.g. "foo|bar") without requiring is_regex
            const terms = pattern.split('|').map(t => t.trim()).filter(Boolean)
                .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            re = new RegExp(terms.join('|'), caseSensitive ? 'g' : 'gi');
        }

        const files   = await agentListFiles();
        const matches = [];

        for (const f of files) {
            if (pathFilter.length && !pathFilter.some(p => f.name.toLowerCase().includes(p))) continue;
            // Skip log files by default — they contain historical tool call names that cause false positives
            if (!pathFilter.length && /^logs\//.test(f.name)) continue;
            // Fast-path: skip files whose IDB size metadata is already over 300KB (name-only search skips this
            // read cost, but content search needs the file contents below).
            if (scope !== 'names' && !pathFilter.length && f.size > _SEARCH_FILE_SIZE_CAP) continue;
            // Filename match (name-only when scope='names').
            let nameMatched = false;
            if (scope !== 'contents') {
                re.lastIndex = 0;
                nameMatched = re.test(f.name);
            }

            const content = scope === 'names' ? null : await agentReadFile(f.name).catch(() => '');
            // Recheck with actual content length — covers local/ FSA files with no size metadata
            if (content !== null && !pathFilter.length && content.length > _SEARCH_FILE_SIZE_CAP) continue;
            const lines   = content !== null ? content.split('\n') : [];
            let contentMatched = false;
            const contentBlocks = [];
            for (let i = 0; i < lines.length; i++) {
                re.lastIndex = 0;
                if (!re.test(lines[i])) continue;
                contentMatched = true;
                const start = Math.max(0, i - ctxLines);
                const end   = Math.min(lines.length - 1, i + ctxLines);
                const block = [];
                for (let j = start; j <= end; j++) {
                    // Cap individual lines to avoid single-line JSON blobs blowing up results
                    const raw = lines[j];
                    const display = raw.length > _SEARCH_LINE_DISPLAY ? raw.slice(0, _SEARCH_LINE_DISPLAY) + '…' : raw;
                    block.push(`${j === i ? '>' : ' '} ${f.name}:${j + 1}: ${display}`);
                }
                contentBlocks.push(block.join('\n'));
            }
            // scope='both': show the filename line only when the same file has no content matches,
            // so a common token isn't double-reported for every file.
            const showNameLine = scope === 'names' || (scope === 'both' && nameMatched && !contentMatched);
            if (showNameLine && nameMatched) {
                matches.push(`> ${f.name}  (filename match)`);
                if (matches.length >= maxMatches) break;
            }
            for (const b of contentBlocks) {
                matches.push(b);
                if (matches.length >= maxMatches) break;
            }
            if (matches.length >= maxMatches) break;
        }

        if (!matches.length) return { matches: [], note: 'No matches found.' };
        const _capped = matches.length >= maxMatches;
        return {
            matches,
            match_count: matches.length,
            ...(_capped && { note: `Results capped at ${maxMatches} matches — there may be more. Narrow your search with path_filter or a more specific pattern. Do not repeat this exact search.` }),
        };
    } catch (e) { return { error: `search_workspace: ${e.message}` }; }
}

async function _handleSubmitAnswer(args: any) {
    const answer = args?.answer ?? args?.result ?? args?.response ?? args?.value ?? '';
    return { ok: true, answer_recorded: answer, note: "submit_answer is not a valid tool — write your answer as plain text in your response, then end with COMPLETED on the last line." };
}

async function _handleUpdateTaskStatus(args: any) {
    const { path, status, log_entry } = args;
    if (!path || !status) return { error: 'path and status are required.' };
    if (path.startsWith('local/') && !(typeof fsaHandle !== 'undefined' && fsaHandle)) {
        const fallback = path.replace(/^local\//, '');
        return { error: `update_task_status: No local folder is open — use the workspace path "${fallback}" instead of "${path}".` };
    }
    try {
        // Route through transitionTask so QA gates fire on every status change.
        // transitionTask calls setTaskStatus internally on success, and short-circuits
        // straight to it when gates are disabled (fg_qa_enabled=false, the headless
        // default). qa.js is loaded by every entry point — index.html and
        // headless-runner.ts, which also backs fg-run and the TUI — so no typeof guard:
        // if this throws, the tool is genuinely broken and must not report success.
        const result = await transitionTask(path, status);
        if (!result.transitioned) {
            return { ok: false, path, status, blocked: true, reason: result.reason || 'QA gate blocked transition' };
        }
        if (log_entry) {
            const date = new Date().toISOString().slice(0, 10);
            await agentWriteFile(path,
                (await agentReadFile(path)).trimEnd() + `\n### ${date}\n${log_entry}\n`);
        }
        // Always sync ledger directly — guards against any call-chain path that skips _updateLedgerRow
        await _updateLedgerRow(path, status);
        refreshTasks?.();
        return { ok: true, path, status };
    } catch (e) { return { error: e.message }; }
}


// ─────────────────────────────────────────────────────────────────────────────
// Helpers hoisted from executeToolAsync to module scope
// ─────────────────────────────────────────────────────────────────────────────

// Post-write syntax check: runs after any successful file write in the non-staging path.
// Returns an error string on failure, null if the file is clean or the check is unavailable.
async function _syntaxCheck(path) {
    const ext = (path.match(/\.([^./\\]+)$/) ?? [])[1]?.toLowerCase();
    if (!ext || typeof nativeExec !== 'function') return null;
    let r = null;
    if (ext === 'py') {
        r = await nativeExec('bash', `python3 -m py_compile ${JSON.stringify(path)} 2>&1`).catch(() => null);
    } else if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) {
        r = await nativeExec('bash', `node --check ${JSON.stringify(path)} 2>&1`).catch(() => null);
    }
    if (!r || r.exit_code === 0) return null;
    return (r.stdout || r.stderr || '').trim().split('\n').slice(0, 5).join('\n') || null;
}

// Image / SVG inline-display helper for write_file.
// Returns a display object for image/SVG content, or {} for all other content.
function _writeFileImageDisplay(path, content) {
    if (typeof nativeExec === 'function') return null; // headless: no browser UI to display images
    const imgKey = `img_${path.replace(/\W/g, '_')}`;
    _pyodideImageStore = _pyodideImageStore || {};
    if (/^data:image\//i.test(content)) {
        _pyodideImageStore[imgKey] = content;
        return { display: `[IMAGE:${imgKey}]` };
    }
    if (/\.svg$/i.test(path) && /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(content)) {
        _pyodideImageStore[imgKey] = { type: 'svg', content };
        return { display: `[IMAGE:${imgKey}]` };
    }
    return {};
}

// SWE-bench: grader strips test-file changes before scoring — agent edits score zero.
// 17/36 failed SWE tasks edited test files; 14 passed a self-modified test and were
// still rejected. Headless-only (nativeExec present); interactive sessions unaffected.
const _SWE_TEST_RE = /(^|\/)(tests?|testing|specs?)\/|(^|\/)test_|_test\.|\.test\./;

async function _handleRunWorkers(args, context) {
    if (context) {
        const maxDepth = getAgentMaxDelegationDepth();
        if (maxDepth === 0 || context.depth >= maxDepth) {
            return { error: 'Max delegation depth reached. Complete this task without spawning sub-workers.' };
        }
        const result = await executeWorkers({
            ...args,
            depth: context.depth + 1,
            _parentSnapshot: context.snapshot,
            _parentRequest: context.parentRequest?.() ?? null,
        });
        // Propagate committed sub-worker files into parent staging so the
        // top-level commit phase sees them for conflict detection.
        const written = [...(result.applied || []), ...(result.conflictsResolved || [])];
        await Promise.all(written.map(async path => {
            try { context.staging.set(path, await agentReadFile(path)); } catch {}
        }));
        return result;
    }
    const result = await executeWorkers(args);
    // Files in "incomplete" were written by blocked workers and may be corrupt.
    // Force a read-back before any edit to those files.
    for (const p of (result.incomplete || [])) _requireReadBack.add(p);
    return result;
}

async function _handleListFiles(args, context) {
    // Strip surrounding quotes — fn-tag models sometimes double-encode: path: '""' instead of ''
    // Then normalise current-directory forms: "." / "./" / "/" mean the workspace root
    // (list everything), and a leading "./" is dropped — the filter is a literal name
    // prefix, so an unnormalised "." only matched dotfiles and returned an empty list
    // for a populated workspace (fg-chat 2026-07-16).
    const pathFilter = (args.path || '').trim().replace(/^(["']).*\1$/, m => m.slice(1, -1)).trim()
        .replace(/^(?:\.\/?|\/)$/, '')
        .replace(/^\.\/(?=.)/, '');
    // Normalise both the filter and each filename by stripping the leading "local/" (or bare
    // "local") so that "tasks/", "local/tasks/", and "local" all work as filters.
    // "local" → "" (match all local files), "local/tasks/" → "tasks/", "tasks/" → "tasks/"
    const normFilter = pathFilter.replace(/^local(\/|$)/, '');
    const normName   = f => (f.name || f).replace(/^local\//, '');
    const applyFilter = files => {
        if (!pathFilter) return files;
        const filtered = files.filter(f => normName(f).startsWith(normFilter));
        // Sort so files directly at the requested path come before subdirectory files,
        // ensuring e.g. local/tasks/038-*.md appears before local/tasks/archive/*.md
        const base = normFilter.endsWith('/') ? normFilter : normFilter + '/';
        return filtered.sort((a, b) => {
            const aSub = normName(a).slice(base.length).includes('/');
            const bSub = normName(b).slice(base.length).includes('/');
            return aSub - bSub;
        });
    };
    const _cap = (all) => {
        if (all.length <= _LIST_FILES_CAP) return { files: all };
        return { files: all.slice(0, _LIST_FILES_CAP), note: `Showing first ${_LIST_FILES_CAP} of ${all.length} files. Use a more specific path filter to narrow results.` };
    };
    if (context) {
        const seen = new Set();
        const files = [];
        for (const [n, c] of [...context.snapshot, ...context.staging]) {
            if (!seen.has(n) && c !== null) { seen.add(n); files.push({ name: n, size: (c || '').length }); }
        }
        return { path: pathFilter, ..._cap(applyFilter(files)) };
    }
    try   { return { path: pathFilter, ..._cap(applyFilter(await agentListFiles())) }; }
    catch (e) { return { error: e.message }; }
}

async function _handleReadFile(args, context) {
    args = { ...args, path: args.path ?? args.filename ?? args.file ?? args.filepath
                          ?? (typeof args.paths === 'string' ? JSON.parse(args.paths)[0] : args.paths?.[0])
                          ?? '' };
    args = { ...args, path: _normToolPath(args.path) };
    if (!args.path) return { error: 'read_file: missing required argument "path". Use: read_file({"path": "relative/path/to/file"})' };
    // line_range may arrive as a JSON string ('[1,100]') instead of an array — parse it.
    if (typeof args.line_range === 'string') { try { args.line_range = JSON.parse(args.line_range); } catch {} }
    if (args.line_range) {
        args.start_line = args.start_line ?? args.line_range[0];
        args.end_line   = args.end_line   ?? args.line_range[1];
    }
    // start/end are common aliases for start_line/end_line.
    args.start_line = args.start_line ?? args.start;
    args.end_line   = args.end_line   ?? args.end;
    const _sliceLines = (text, start, end) => {
        if (!start && !end && text.length > _READ_INLINE_MAX) {
            const lines = text.split('\n');
            return lines.slice(0, 200).join('\n')
                + `\n\n[File is ${text.length} chars / ${lines.length} lines. Only the first 200 lines shown. Use start_line/end_line to read a specific range.]`;
        }
        if (!start && !end) return text;
        const lines = text.split('\n');
        const s = Math.max(0, (start || 1) - 1);
        const e = end ? Math.min(lines.length, end) : lines.length;
        return lines.slice(s, e).join('\n');
    };
    let sl = args.start_line || null, el = args.end_line || null;
    if (sl && el && sl > el) return { error: `read_file: start_line (${sl}) must be ≤ end_line (${el}).` };
    // Block known binary extensions before reading — avoids 4M-char dead turns on PDFs.
    if (/\.(pdf)$/i.test(args.path))
        return { error: `binary file: ${args.path} is a PDF — read_file cannot extract text`, hint: 'extract text with execute_code: pdftotext <path> - | head -200' };
    if (/\.(so|pyc|pkl|bin|gz|zip|tar|jar|class|o|a|whl|pyd|dylib|dex|exe|dll)$/i.test(args.path))
        return { error: `binary file: ${args.path} cannot be read as text`, hint: 'do not read binary files as text; use execute_code to inspect (e.g. file, strings, hexdump)' };
    // Expand narrow ranges to a 50-line minimum so one read covers the surrounding
    // function context. Prevents the search-hit→narrow-read→re-read step pattern;
    // each saved re-read is worth ~8-16k prompt tokens (full history re-submission).
    if (sl && el && (el - sl + 1) < 50) { const mid = Math.round((sl + el) / 2); sl = Math.max(1, mid - 25); el = mid + 25; }
    const _ret = (path, full, sliced) => {
        const totalLines = full ? full.split('\n').length : 0;
        const _oob = sl && totalLines && sl > totalLines
            ? `start_line (${sl}) exceeds file length (${totalLines} lines) — no content returned.` : undefined;
        return {
            path, content: sliced, length: full.length,
            lines_returned: sliced.split('\n').length,
            ...((sl || el) ? { total_lines: totalLines } : {}),
            ...(sl ? { start_line: sl } : {}),
            ...(el ? { end_line: el }   : {}),
            ...(_oob ? { note: _oob } : {}),
        };
    };
    const _imgPreview = (path, content) => {
        if (typeof nativeExec === 'function') return null; // headless: no browser UI to display images
        const imgKey = `img_${path.replace(/\W/g, '_')}`;
        _pyodideImageStore = _pyodideImageStore || {};
        if (/^data:image\//i.test(content)) {
            _pyodideImageStore[imgKey] = content;
            return { path, display: `[IMAGE:${imgKey}]`, length: content.length, note: 'Image file — displayed inline above.' };
        }
        if (/\.svg$/i.test(path) && /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(content)) {
            _pyodideImageStore[imgKey] = { type: 'svg', content };
            return { path, display: `[IMAGE:${imgKey}]`, length: content.length, note: 'SVG file — displayed inline above.' };
        }
        return null;
    };
    // Content-header binary detection: catches unlabeled PDFs and binary files not caught
    // by the extension check above. Runs after read so extension check should handle common cases.
    const _checkBinary = (path: string, content: string) => {
        const head = content.slice(0, 512);
        if (head.startsWith('%PDF-'))
            return { error: `binary file: ${path} is a PDF`, hint: 'extract text with execute_code: pdftotext <path> - | head -200' };
        if (head.includes('\0'))
            return { error: `binary file: ${path} contains null bytes`, hint: 'do not read binary files as text; use execute_code to inspect' };
        const _ctrl = [...head].filter(ch => { const c = ch.charCodeAt(0); return c < 32 && c !== 9 && c !== 10 && c !== 13; }).length;
        if (head.length > 16 && _ctrl / head.length > 0.05)
            return { error: `binary file: ${path} contains non-text bytes`, hint: 'do not read binary files as text' };
        return null;
    };
    if (context) {
        const path = args.path;
        if (context.staging.has(path)) {
            const c = context.staging.get(path);
            if (c === null) return { error: `File deleted: ${path}` };
            return _checkBinary(path, c) ?? _imgPreview(path, c) ?? _ret(path, c, _sliceLines(c, sl, el));
        }
        if (context.snapshot.has(path)) {
            const c = context.snapshot.get(path);
            return _checkBinary(path, c) ?? _imgPreview(path, c) ?? _ret(path, c, _sliceLines(c, sl, el));
        }
        // local/ files are not in the snapshot — read directly from filesystem
        try {
            const content = await agentReadFile(path);
            return _checkBinary(path, content) ?? _imgPreview(path, content) ?? _ret(path, content, _sliceLines(content, sl, el));
        } catch (e) {
            if (/\bledger\b|\bprogress\.md$/.test(path || '')) {
                return _ret(path, '', '');
            }
            return { error: e.message };
        }
    }
    try {
        const content = await agentReadFile(args.path);
        _requireReadBack.delete(args.path); // satisfied — allow edits again
        return _checkBinary(args.path, content) ?? _imgPreview(args.path, content) ?? _ret(args.path, content, _sliceLines(content, sl, el));
    } catch (e) {
        // Ledger/progress files may not exist yet — return empty content so the agent
        // can continue without treating a missing ledger as a blocking error.
        if (/\bledger\b|\bprogress\.md$/.test(args.path || '')) {
            return _ret(args.path, '', '');
        }
        return { error: e.message };
    }
}

async function _handleWriteFile(args, context) {
    args = { ...args,
        path:    _normToolPath(args.path    ?? args.filename ?? args.file ?? args.filepath ?? ''),
        content: args.content ?? args.text     ?? args.body ?? args.data    ?? '',
    };
    if (!args.path) return { error: 'write_file: "path" is required' };
    if (args.encoding === 'base64') {
        try {
            await agentWriteFile(args.path, args.content, 'base64');
            return { success: true, path: args.path, bytes: Math.round(args.content.length * 0.75) };
        } catch (e) { return { error: e.message }; }
    }
    if (!context && _requireReadBack.has(args.path)) {
        return { error: `write_file: "${args.path}" was written by a blocked worker and may be corrupt. Read it back first to verify its contents before making further edits.` };
    }
    // Reject calls where the model faked the history-compression format instead of writing real content.
    // _contentCompressed is added by _patchOAIWriteArgs to stored history only — never a valid live argument.
    if (args._contentCompressed) {
        return { error: `write_file: Do not use "_contentCompressed" in your tool calls — that flag is added by the system to compress history and is not valid here. Write the actual file content.` };
    }
    if (/^\[write_file:\s/.test((args.content || '').trimStart())) {
        return { error: `write_file: Content looks like a history-compression placeholder, not real file content. Write the actual content of the file.` };
    }
    if (_hasTruncationMarkers(args.content)) {
        return { error: `write_file: Truncation placeholder detected in content (e.g. "// ... rest of code", "[existing code]"). Write the COMPLETE file — never use ellipsis or placeholder comments to stand in for omitted content.` };
    }
    if (context) {
        const old = context.staging.has(args.path)
            ? (context.staging.get(args.path) ?? '')
            : (context.snapshot.get(args.path) ?? '');
        if (old.length >= _SHRINK_MIN_OLD && args.content.length < old.length * _SHRINK_THRESHOLD) {
            return { error: _shrinkError(args.path, old.length, args.content.length) };
        }
        if (old.length >= _EDIT_REVIEW_MIN_OLD && getEditReviewEnabled()
                && _changeRatio(old, args.content) > _EDIT_REVIEW_THRESHOLD) {
            const review = await _reviewFileEdit(args.path, old, args.content);
            if (!review.approved)
                return { error: `write_file: Edit review rejected for "${args.path}" — ${review.reason}. Revise and retry.` };
        }
        context.staging.set(args.path, args.content);
        const imgDisplay = _writeFileImageDisplay(args.path, args.content);
        return { success: true, path: args.path, bytes: args.content.length, ...imgDisplay };
    }
    try {
        let previous = '';
        try { previous = await agentReadFile(args.path); } catch {}
        if (previous.length >= _SHRINK_MIN_OLD && args.content.length < previous.length * _SHRINK_THRESHOLD) {
            return { error: _shrinkError(args.path, previous.length, args.content.length) };
        }
        if (previous.length >= _EDIT_REVIEW_MIN_OLD && getEditReviewEnabled()
                && _changeRatio(previous, args.content) > _EDIT_REVIEW_THRESHOLD) {
            const review = await _reviewFileEdit(args.path, previous, args.content);
            if (!review.approved)
                return { error: `write_file: Edit review rejected for "${args.path}" — ${review.reason}. Revise and retry.` };
        }
        _pushCheckpoint(args.path, previous);
        await agentWriteFile(args.path, args.content);
        const imgDisplay = _writeFileImageDisplay(args.path, args.content);
        const synErr = await _syntaxCheck(args.path);
        const wfResult = { success: true, path: args.path, bytes: args.content.length, ...imgDisplay };
        return synErr ? { ...wfResult, syntax_error: synErr } : wfResult;
    } catch (e) { return { error: e.message }; }
}

async function _handleReplaceInFile(args, context) {
    // Normalise parameter aliases that small models sometimes emit
    args = { ...args,
        path:       _normToolPath(args.path ?? ''),
        old_string: args.old_string ?? args.old_content ?? args.old_str ?? args.old_text ?? args.original_text ?? args.original ?? args.old_target ?? args.old_lines ?? args.search ?? args.find ?? args.old ?? '',
        new_string: args.new_string ?? args.new_content ?? args.new_str ?? args.new_text ?? args.replacement_text ?? args.replace ?? args.replacement ?? args.new ?? args.content ?? args.text ?? '',
    };
    if (!context && _requireReadBack.has(args.path)) {
        return { error: `replace_in_file: "${args.path}" was written by a blocked worker and may be corrupt. Read it back first to verify its contents before making further edits.` };
    }
    if (!args.old_string) {
        return { error: `replace_in_file: old_string is empty. To REPLACE text, set old_string to the exact lines to find. To INSERT text, include the surrounding lines as old_string and repeat them plus your addition in new_string. Example — insert after a function signature: old_string='def foo():\\n    pass', new_string='def foo():\\n    # new line\\n    pass'. Read the file first to get exact content.` };
    }
    if (args.old_string === args.new_string) {
        return { error: `replace_in_file: old_string and new_string are identical — this would change nothing. Provide different text.` };
    }
    if (_hasTruncationMarkers(args.new_string || '')) {
        return { error: `replace_in_file: Truncation placeholder detected in new_string (e.g. "// ... rest of code"). Provide the complete replacement text — no ellipsis or omission placeholders.` };
    }
    const doReplace = async (read, write) => {
        const original = await read();
        const lines = original.split('\n');
        // Compute character offset for the search window
        let searchOffset = 0, searchText = original;
        if (args.start_line != null || args.end_line != null) {
            const s = Math.max(0, (args.start_line ?? 1) - 1);
            const e = Math.min(lines.length, args.end_line ?? lines.length);
            searchOffset = lines.slice(0, s).join('\n').length + (s > 0 ? 1 : 0);
            searchText = lines.slice(s, e).join('\n');
        }
        let idx = searchText.indexOf(args.old_string);
        let matchLen = args.old_string.length;
        if (idx === -1) {
            // Fallback: allow trailing-whitespace differences per line (editor stripping vs LLM output)
            try {
                const escaped = args.old_string.replace(/\r\n/g, '\n').split('\n')
                    .map(l => l.trimEnd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('[ \\t]*\\n');
                const re = new RegExp(escaped + '[ \\t]*', 'g');
                const hits = [...searchText.matchAll(re)];
                if (hits.length === 1) { idx = hits[0].index; matchLen = hits[0][0].length; }
            } catch {}
        }
        if (idx === -1) {
            let hint = '';
            if (args.start_line != null || args.end_line != null) {
                const s = Math.max(0, (args.start_line ?? 1) - 1);
                const e = Math.min(lines.length, (args.end_line ?? lines.length));
                hint = `\nActual content at lines ${s + 1}–${e}:\n${lines.slice(s, e).join('\n')}`;
            } else {
                // Find the closest matching lines so the model can adjust without re-reading the file.
                const needle = args.old_string.split('\n')[0].trim().toLowerCase();
                if (needle.length >= 4) {
                    const scored = lines
                        .map((l, i) => ({ i, l, score: _fuzzyScore(needle, l.trim().toLowerCase()) }))
                        .filter(x => x.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 3);
                    if (scored.length > 0) {
                        hint = '\nClosest matches in file (adjust old_string to one of these):\n' +
                            scored.map(x => `  L${x.i + 1}: ${x.l}`).join('\n');
                    }
                }
            }
            return { error: `replace_in_file: old_string not found in "${args.path}"${args.start_line != null || args.end_line != null ? ` within lines ${args.start_line ?? 1}–${args.end_line ?? lines.length}` : ''}.${hint}` };
        }
        const absIdx = searchOffset + idx;
        const updated = original.slice(0, absIdx) + args.new_string + original.slice(absIdx + matchLen);
        await write(updated);
        return { success: true, path: args.path, replacements_made: 1, bytes: updated.length, note: 'Change applied. No need to re-read the file to verify.' };
    };
    if (context) {
        return doReplace(
            async () => {
                if (context.staging.has(args.path)) return context.staging.get(args.path) ?? '';
                return context.snapshot.get(args.path) ?? '';
            },
            async c => context.staging.set(args.path, c)
        );
    }
    try {
        const before = await agentReadFile(args.path).catch(() => '');
        _pushCheckpoint(args.path, before);
        const rif = await doReplace(
            () => Promise.resolve(before),
            c  => agentWriteFile(args.path, c)
        );
        if (rif.success) {
            const synErr = await _syntaxCheck(args.path);
            if (synErr) return { ...rif, syntax_error: synErr };
        }
        return rif;
    } catch (e) { return { error: e.message }; }
}

async function _handleApplyPatch(args, context) {
    // Resolve patchRaw and derive path from header before any I/O — fail fast, no pointless reads.
    const _KNOWN_PATCH_KEYS = new Set(['path', 'patch', 'diff', 'content', 'old_string', 'old_text', 'description']);
    // Auto-detect patch string passed under a wrong parameter name (e.g., apply_patch(pixel=<diff>)).
    const _wrongParamPatch = Object.entries(args).find(
        ([k, v]) => !_KNOWN_PATCH_KEYS.has(k) && typeof v === 'string' && v.length > 20 && (v.includes('---') || v.includes('@@'))
    )?.[1] as string | undefined;
    const patchRaw = args.patch ?? args.diff ?? args.content ?? _wrongParamPatch;
    if (!patchRaw) {
        // Model passed old_string/new_string instead of a unified diff — silently delegate.
        if (args.old_string != null || args.old_text != null)
            return executeToolAsync('replace_in_file', args, context);
        const _extraKeys = Object.keys(args).filter(k => !_KNOWN_PATCH_KEYS.has(k));
        const _extraHint = _extraKeys.length ? ` You passed unrecognized parameter(s): ${_extraKeys.map(k => `'${k}'`).join(', ')}. The patch must be passed as 'patch'.` : '';
        return { error: `apply_patch: missing required argument "patch" (unified diff string).${_extraHint}` };
    }
    // Derive path from '--- a/<file>' header when args.path is absent — symmetric to the
    // header-synthesis below that handles the reverse case (path given, headerless patch).
    if (!args.path) {
        const m = patchRaw.trimStart().match(/^--- a\/([^\n]+)/);
        if (m) args = { ...args, path: m[1] };
    }
    // Normalize /workspace/ prefix (WASM bash mount point) to a plain relative path.
    args = { ...args, path: _normToolPath(args.path ?? '') };
    if (typeof nativeExec === 'function' && args.path && _SWE_TEST_RE.test(args.path)) {
        return { error: `Editing test files is not reflected in the grade — the grader strips test-file changes before scoring; fix the source code instead (${args.path}).` };
    }
    if (!context && _requireReadBack.has(args.path)) {
        return { error: `apply_patch: "${args.path}" was written by a blocked worker and may be corrupt. Read it back first to verify its contents before making further edits.` };
    }
    const doApply = async (read, write) => {
        let jsdiff;
        try {
            // Always use CDN — avoids bare-specifier import('diff') which causes Vite to
            // inject /@vite/client into tools.ts, breaking module loading on Safari 12.
            // @ts-ignore — ESM URL import has no TypeScript type declarations
            jsdiff = await import(/* @vite-ignore */ 'https://esm.sh/diff@7');
        } catch (e: any) {
            return { error: `apply_patch: failed to load diff library: ${e?.message}` };
        }
        const original = await read();
        // patchRaw resolved above; synthesise header when args.path is given but patch lacks one.
        let patch = patchRaw.trimStart();
        if (!patch.startsWith('---')) {
            patch = `--- a/${args.path}\n+++ b/${args.path}\n` + patch;
        }
        const { patch: fixedCounts, corrections: countFixes } = _rewriteHunkCounts(patch);
        patch = fixedCounts;
        // Try exact, then with fuzz, then auto-correct line offsets
        let result = jsdiff.applyPatch(original, patch);
        if (result === false) result = jsdiff.applyPatch(original, patch, { fuzzFactor: 2 });
        if (result !== false) {
            await write(result);
            const note = countFixes.length ? `Recomputed hunk counts: ${countFixes.join('; ')}` : undefined;
            return { success: true, path: args.path, bytes: result.length, ...(note ? { note } : {}) };
        }
        const fixed = await _tryFixPatchOffsets(args.path, original, patch, jsdiff);
        if (fixed?.result) {
            await write(fixed.result);
            return { success: true, path: args.path, bytes: fixed.result.length, ...(fixed.note ? { note: fixed.note } : {}) };
        }
        return { error: `apply_patch: patch did not apply to "${args.path}". ${fixed?.hint ?? 'Context lines may not match — read the file first and regenerate the patch.'}` };
    };
    if (context) {
        return doApply(
            async () => {
                if (context.staging.has(args.path)) return context.staging.get(args.path) ?? '';
                return context.snapshot.get(args.path) ?? '';
            },
            async c => context.staging.set(args.path, c)
        );
    }
    try {
        const ap = await doApply(
            () => agentReadFile(args.path),
            c  => agentWriteFile(args.path, c)
        );
        if ('success' in ap && ap.success) {
            const synErr = await _syntaxCheck(args.path);
            if (synErr) return { ...ap, syntax_error: synErr };
        }
        return ap;
    } catch (e) { return { error: e.message }; }
}

async function _handleWebSearch(args) {
    const src = (args.source || 'web').toLowerCase();
    if (src === 'wikipedia') return wikipediaSearch(args.query);
    if (src === 'hackernews') {
        try {
            const q = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=10`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `Hacker News HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data.hits || []).map(h => `\n1. [${h.title}] — ${_an(h.url)}\n   ${h.points} pts | ${h.num_comments} comments | ${h.author}`).join('') };
        } catch (e) { return { error: `web_search/hackernews: ${e.message}` }; }
    }
    if (src === 'github') {
        try {
            const q = encodeURIComponent(args.query || '');
            const headers: Record<string, string> = {};
            const token = getGithubToken();
            if (token) headers.Authorization = `Bearer ${token}`;
            const resp = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`, { headers, signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `GitHub HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data.items || []).map(i => `\n1. [${i.full_name}] — ${_an(i.html_url)}\n   ${i.description || ''} | ★${i.stargazers_count} | ${i.language || 'N/A'}`).join('') };
        } catch (e) { return { error: `web_search/github: ${e.message}` }; }
    }
    if (src === 'stackoverflow') {
        try {
            const q = encodeURIComponent(args.query || '');
            const key = getStackExchangeKey();
            const resp = await fetch(`https://api.stackexchange.com/2.3/search/advanced?q=${q}&site=stackoverflow&filter=!9YdnSM67&pagesize=10${key ? '&key=' + encodeURIComponent(key) : ''}`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `Stack Overflow HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data.items || []).map(i => `\n1. [${i.title}] — ${_an(i.link)}\n   Score: ${i.score} | Answers: ${i.answer_count}`).join('') };
        } catch (e) { return { error: `web_search/stackoverflow: ${e.message}` }; }
    }
    if (src === 'reddit') {
        try {
            const q = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://www.reddit.com/search.json?q=${q}&sort=relevance&t=year&limit=10`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `Reddit HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data.data?.children || []).map(c => `\n1. [${c.data.title}] — ${_an(c.data.url)}\n   ${c.data.selftext?.slice(0, 150) || ''} | r/${c.data.subreddit}`).join('') };
        } catch (e) { return { error: `web_search/reddit: ${e.message}` }; }
    }
    if (src === 'devto') {
        try {
            const tag = (args.query || '').replace(/\s+/g, '').toLowerCase();
            const resp = await fetch(`https://dev.to/api/articles?tag=${tag}&per_page=10&top=30`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `DEV.to HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data || []).map(a => `\n1. [${a.title}] — ${_an(a.url)}\n   ${a.description || ''}`).join('') };
        } catch (e) { return { error: `web_search/devto: ${e.message}` }; }
    }
    if (src === 'gdelt') {
        try {
            const q = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=10&format=json`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `GDELT HTTP ${resp.status}` };
            const data = await resp.json();
            const _an = annotateUrl;
            return { results: (data.articles || []).map(a => `\n1. [${a.title}] — ${_an(a.url)}\n   ${a.seendate}`).join('') };
        } catch (e) { return { error: `web_search/gdelt: ${e.message}` }; }
    }
    if (src === 'duckduckgo') {
        try {
            const q = encodeURIComponent(args.query || '');
            const resp = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1`, { signal: activeAbortController?.signal });
            if (!resp.ok) return { error: `DuckDuckGo HTTP ${resp.status}` };
            const data = await resp.json();
            return { results: (data.RelatedTopics || []).map(t => `\n1. [${t.Text}] — ${t.FirstURL}`).join('') || data.AbstractText || 'No results' };
        } catch (e) { return { error: `web_search/duckduckgo: ${e.message}` }; }
    }
    return performWebSearch(args.query);
}

// Serialized size above which a fetch_url JSON response is shrunk by _fitJson.
const _FETCH_JSON_MAX = 8000;

// Shrink a parsed JSON value to fit `budget` serialized chars while keeping it valid JSON:
// whole array items / object keys are kept in order; the first one that doesn't fit is shrunk
// recursively when there is room, and the rest are dropped (counted in `dropped`).
function _fitJson(v: any, budget: number, dropped: { items: number; keys: number }): any {
    const s = JSON.stringify(v);
    if (s === undefined || s.length <= budget) return v;
    if (typeof v === 'string') return v.slice(0, Math.max(0, budget - 3)) + '…';
    const isArr = Array.isArray(v);
    if (!isArr && (v === null || typeof v !== 'object')) return v;
    const entries: [string, any][] = isArr ? v.map((x: any, i: number) => [String(i), x]) : Object.entries(v);
    const out: [string, any][] = [];
    let used = 2;   // [] or {}
    for (let i = 0; i < entries.length; i++) {
        const [k, x] = entries[i];
        const head = (out.length ? 1 : 0) + (isArr ? 0 : JSON.stringify(k).length + 1);
        const xs = JSON.stringify(x) ?? 'null';
        if (used + head + xs.length <= budget) { out.push([k, x]); used += head + xs.length; continue; }
        const room = budget - used - head;
        if (room >= 200) { out.push([k, _fitJson(x, room, dropped)]); i++; }
        if (isArr) dropped.items += entries.length - i; else dropped.keys += entries.length - i;
        break;
    }
    return isArr ? out.map(([, x]) => x) : Object.fromEntries(out);
}

async function _handleFetchUrl(args) {
    args = { ...args, url: args.url ?? args.link ?? args.href ?? args.uri ?? '' };
    // Strip [UNAVAILABLE] suffix if the model passes an annotated URL from search results.
    args = { ...args, url: stripUnavailable(args.url) };
    // Models reach for fetch_url with file:// to read workspace files; the browser
    // fetch fails with an unactionable "Failed to fetch". Redirect deterministically.
    if (/^file:/i.test(args.url)) {
        const _p = args.url.replace(/^file:\/{0,3}/i, '');
        // Triage role doesn't have read_file — tell it to hand over rather than retry.
        const _hasReadFile = typeof mainAgentRole === 'undefined' || !mainAgentRole?.tools || mainAgentRole.tools.has('read_file');
        return { error: _hasReadFile
            ? `fetch_url cannot read file:// URLs. Use read_file with path "${_p}" instead.`
            : `fetch_url cannot read file:// URLs and read_file is not in your tool set. BLOCKED: cannot read "${_p}" — no file-reading tool available in this role.` };
    }
    // Sandboxed run: refuse anything outside the --fetch-allow origins before any request.
    // The GitHub rewrites, README fallback and CORS proxy below all fetch other hosts, so they
    // are skipped while the allowlist is active, and redirects are not followed.
    const _sandboxed = isFetchAllowActive();
    const _denied = checkFetchAllowed(args.url);
    if (_denied) return { error: _denied };
    // GitHub HTML pages are blocked for bots. Rewrite blob URLs to raw content
    // deterministically; capture repo-root URLs for a README fallback on failure.
    const _ghBlobMatch = _sandboxed ? null : /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/blob\/([^/?#]+)\/(.+?)(?:\?.*)?$/.exec(args.url);
    if (_ghBlobMatch) {
        const [, _o, _r, _b, _p] = _ghBlobMatch;
        args = { ...args, url: `https://raw.githubusercontent.com/${_o}/${_r}/${_b}/${_p}` };
    }
    const _ghRootMatch = _sandboxed ? null : /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?(?:\?.*)?$/.exec(args.url);
    try {
        const method  = (args.method || 'GET').toUpperCase();
        const reqHdrs = { ...(args.headers || {}) };
        const hasAuth = Object.keys(reqHdrs).some(k => k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key');

        let body;
        if (args.body !== undefined) {
            if (typeof args.body === 'object') {
                body = JSON.stringify(args.body);
                if (!Object.keys(reqHdrs).some(k => k.toLowerCase() === 'content-type'))
                    reqHdrs['Content-Type'] = 'application/json';
            } else {
                body = String(args.body);
            }
        }

        // Use proxy only for plain GET page fetches — not for authenticated or non-GET requests.
        const proxy   = getEffectiveProxy();
        const isPlain = method === 'GET' && !hasAuth && body === undefined
            && !/\.json(\?|$)/.test(args.url) && !/\/api\//.test(args.url);
        // For plain page fetches, inject the browser headers that a real navigation sends.
        // FreeGent runs inside the browser so the TLS fingerprint is already genuine Chrome/
        // Firefox — these headers complete the picture for sites doing HTTP-level bot detection.
        // Caller-supplied headers always win (spread order: defaults first, reqHdrs on top).
        if (isPlain) Object.assign(reqHdrs, {
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest':  'document',
            'Sec-Fetch-Mode':  'navigate',
            'Sec-Fetch-Site':  'none',
            'Sec-Fetch-User':  '?1',
            'Upgrade-Insecure-Requests': '1',
            ...reqHdrs,   // caller overrides sit on top
        });
        const _fetchTimeout = AbortSignal.timeout(30_000);
        const _fetchSignal  = activeAbortController?.signal
            ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([activeAbortController.signal, _fetchTimeout]) : _fetchTimeout)
            : _fetchTimeout;
        let resp;
        if (isPlain && proxy && !_sandboxed) {
            resp = await fetch(`${proxy}?url=${encodeURIComponent(args.url)}`, { signal: _fetchSignal });
        } else {
            resp = await fetch(args.url, { method, headers: reqHdrs, body, signal: _fetchSignal,
                                           ...(_sandboxed && { redirect: 'manual' as const }) });
        }

        const status = resp.status;
        const ct     = resp.headers.get('content-type') || '';

        if (!resp.ok) {
            // GitHub repo-root fallback: try raw README on main then master.
            if (_ghRootMatch) {
                const [, _o, _r] = _ghRootMatch;
                for (const _branch of ['main', 'master']) {
                    const _rawUrl = `https://raw.githubusercontent.com/${_o}/${_r}/${_branch}/README.md`;
                    try {
                        const _rawResp = await fetch(_rawUrl, { signal: AbortSignal.timeout(15_000) });
                        if (_rawResp.ok) {
                            const _rawText = await _rawResp.text();
                            return { status: _rawResp.status, content: _rawText.slice(0, 8000),
                                     note: `github.com blocked (HTTP ${status}); served README from ${_rawUrl}` };
                        }
                    } catch (_e) { /* try next branch */ }
                }
            }
            // Blacklist plain-GET pages that block bots (403/429/503/other 4xx-5xx).
            // API/JSON/POST requests are excluded — a 401 on an auth'd call is a config
            // issue, not a site-wide block.
            if (isPlain) blacklistAdd(args.url);
            const errText = ct.includes('application/json')
                ? JSON.stringify(await resp.json().catch(() => ({})))
                : (await resp.text().catch(() => '')).slice(0, 500);
            return { error: `HTTP ${status}`, status, ...(errText && { body: errText }) };
        }

        // Optional relevance extraction: when the caller set `extract` and the body is
        // large, return only passages relevant to that goal instead of the truncated page,
        // keeping boilerplate out of the agent's context. Reuses the deep-research
        // extractor. Returns null when extraction is off, the body is small, or it finds
        // nothing — so the caller falls back to the normal (truncated) response.
        const _extractGoal = typeof args.extract === 'string' ? args.extract.trim() : '';
        const _maybeExtract = async (fullText, srcLabel) => {
            if (!_extractGoal || fullText.length <= 4000 || typeof extractRelevant !== 'function') return null;
            const extracted = await extractRelevant(_extractGoal, fullText, srcLabel, { label: 'fetch:extract' });
            if (!extracted) return null;
            return { status, source: args.url, extracted_for: _extractGoal, content: extracted };
        };

        // Successful fetch — remove site from blacklist (it's accessible again).
        if (isPlain) blacklistRemove(args.url);

        if (ct.includes('application/json')) {
            const json = await resp.json();
            const str  = JSON.stringify(json);
            const ex   = await _maybeExtract(str, `${method} ${args.url}`);
            if (ex) return ex;
            if (str.length <= _FETCH_JSON_MAX) return { status, content: json };
            const dropped = { items: 0, keys: 0 };
            return { status, content: _fitJson(json, _FETCH_JSON_MAX, dropped), truncated: true,
                     note: `Response was ${str.length} chars; shown as valid JSON within ${_FETCH_JSON_MAX} chars — kept whole entries in order, dropped ${dropped.items} array item(s) and ${dropped.keys} key(s) at the end. Narrow the request to see the rest.` };
        }

        const text = await resp.text();
        if (ct.includes('text/html') || isPlain) {
            const stripped = text
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            const ex = await _maybeExtract(stripped, args.url);
            if (ex) return ex;
            return { status, content: stripped.slice(0, 8000) };
        }
        const ex = await _maybeExtract(text, args.url);
        if (ex) return ex;
        return { status, content: text.slice(0, 8000) };
    } catch (e) {
        // Network-level failure (timeout, CORS, connection refused) on a plain GET —
        // treat as a temporary block and refresh the blacklist timer.
        const method = (args.method || 'GET').toUpperCase();
        const hasAuth = Object.keys(args.headers || {}).some(k => k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key');
        const _isPlainCatch = method === 'GET' && !hasAuth && args.body === undefined
            && !/\.json(\?|$)/.test(args.url) && !/\/api\//.test(args.url);
        if (_isPlainCatch && typeof blacklistAdd === 'function') blacklistAdd(args.url);
        return { error: `fetch_url: ${e.message}` };
    }
}

async function _handleGenerateImage(args) {
    const prompt         = args.prompt || '';
    const negativePrompt = args.negative_prompt || '';
    const outFilename    = args.filename || `generated_${Date.now()}.png`;
    if (!prompt) return { error: 'generate_image: prompt is required.' };

    // Shared: convert a successful binary fetch response to a saved data URI.
    async function _saveImageResp(resp: Response, model: string): Promise<object | null> {
        const ct = resp.headers.get('Content-Type') || '';
        if (!resp.ok || ct.includes('application/json')) return null;
        const buf    = await resp.arrayBuffer();
        const bytes  = new Uint8Array(buf);
        let binary   = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64     = btoa(binary);
        const imgType = ct.startsWith('image/') ? ct.split(';')[0].trim() : 'image/png';
        const dataUri = `data:${imgType};base64,${b64}`;
        const imgKey  = `fg_img_${Date.now()}`;
        if (typeof nativeExec !== 'function') {
            _pyodideImageStore = _pyodideImageStore || {};
            _pyodideImageStore[imgKey] = dataUri;
        }
        try { await writeWorkspaceFile(outFilename, dataUri); } catch {}
        return { success: true, path: outFilename, model, prompt, display: `[IMAGE:${imgKey}]` };
    }

    let lastError: string | null = null;

    // ── 1. Pollinations.ai — free, no API key required ───────────────────────
    // Uses FLUX under the hood; works out of the box without credentials.
    try {
        const seed = Math.floor(Math.random() * 1_000_000);
        const polUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
            + `?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`;
        const resp = await fetch('/api/proxy', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url: polUrl, method: 'GET' }),
            signal:  activeAbortController?.signal,
        });
        const result = await _saveImageResp(resp, 'pollinations/flux');
        if (result) return result;
        const errText = await resp.text().catch(() => '');
        lastError = `pollinations: HTTP ${resp.status} — ${errText.slice(0, 200)}`;
    } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        lastError = `pollinations: ${e.message}`;
    }

    // ── 2. HuggingFace Inference — requires token in Settings → API Credentials ─
    const hfKey = getHFKey();
    if (hfKey) {
        const hfModels = [
            'black-forest-labs/FLUX.1-schnell',
            'stabilityai/stable-diffusion-xl-base-1.0',
        ];
        for (const model of hfModels) {
            try {
                const reqBody: any = { inputs: prompt };
                if (negativePrompt && model.includes('stable-diffusion')) reqBody.negative_prompt = negativePrompt;
                const resp = await fetch('/api/proxy', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        url:     `https://router.huggingface.co/hf-inference/models/${model}`,
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hfKey}` },
                        body:    JSON.stringify(reqBody),
                    }),
                    signal: activeAbortController?.signal,
                });
                const result = await _saveImageResp(resp, model);
                if (result) return result;
                const errText = await resp.text().catch(() => '');
                lastError = `${model}: HTTP ${resp.status} — ${errText.slice(0, 200)}`;
            } catch (e: any) {
                if (e?.name === 'AbortError') throw e;
                lastError = `${model}: ${e.message}`;
            }
        }
    }

    return { error: `Image generation failed. ${lastError || 'Unknown error'}${!getHFKey() ? ' (Tip: add a HuggingFace API key in Settings → Models → API Credentials for an additional provider.)' : ''}` };
}

// Error signatures in stderr worth flagging when the exit code is 0 (see _handleExecuteCode).
const _STDERR_ERROR_RE = /Traceback \(most recent call last\)|^\w*(?:Error|Exception):|\berror:|\bFAILED\b|\bfatal:/m;

// Python markers at the start of a line. Bash scripts don't start lines this way, and a bash
// script wrapping Python (heredoc, python -c) is excluded. On v0.54's 227 execute_code calls
// without a language this picked 46, 45 of which had failed as Python-run-as-bash and none of
// which had succeeded as bash.
const _PY_LINE_RE = /^(?:import \w|from [\w.]+ import |def \w+\s*\(|class \w+[(:]|print\(|if __name__ ==)/m;
export function _looksLikePython(code: string): boolean {
    const s = (code || '').trimStart();
    if (s.startsWith('#!')) return /python/.test(s.split('\n', 1)[0]);
    if (code.includes('<<') || /\bpython3?\s+-c\b/.test(code)) return false;
    return _PY_LINE_RE.test(code);
}

async function _handleExecuteCode(args, context) {
    // Alias lists owned by tool-call-repair.ts — dispatch and pre-dispatch repair
    // must accept the same keys or they drift (pre-repair normally handles this;
    // dispatch aliasing is the backstop for paths that skip repair).
    const _firstStr = (keys) => { for (const k of keys) { if (typeof args[k] === 'string' && args[k]) return args[k]; } return undefined; };
    const _code = _firstStr(EXEC_CODE_ALIASES) ?? '';
    const _lang = _firstStr(EXEC_LANG_ALIASES);   // undefined when the model omitted it
    // No language given: Python when the code clearly is Python, else bash (the old default).
    // An explicit language is never overridden.
    args = { ...args, code: _code, language: _lang ?? (_looksLikePython(_code) ? 'python' : 'bash') };
    // Strip trailing newlines: a literal \n at the end of a bash code string causes
    // the shell to receive an empty second command that exits 0 with no stdout,
    // silently masking the real command's absence. Safe for all languages. (T1.5)
    if (args.code) args = { ...args, code: args.code.replace(/[\r\n]+$/, '') };
    if (!args.code?.trim()) {
        return { error: 'No code provided. Use the "code" parameter (not "content", "command", "bash", etc.).',
                 note: `Received keys: ${Object.keys(args).join(', ')}` };
    }
    let execResult = null;
    const _needsDisplay = /^\s*(?:import|from)\s+(pygame|pygame_ce|turtle|tkinter|wx|gi\.repository|PyQt[456]|PySide[26])\b/m.test(args.code);
    // Static browser JavaScript: eval with virtual fs shim (no nativeExec, no local sandbox)
    const _isStaticJS = args.language === 'javascript'
        && getSandboxProvider() !== 'local'
        && typeof nativeExec !== 'function';
    if (_isStaticJS) {
        execResult = await (async () => {
            // Collect workspace files into memory
            const files = {};
            try {
                const allFiles = await agentListFiles();
                for (const f of allFiles) {
                    const c = await agentReadFile(f.name).catch(() => null);
                    if (c != null && c.length <= 500_000) files[f.name] = c;
                }
            } catch {}
            const written = {};
            const stdout_lines = [], stderr_lines = [];
            const _norm = p => p.replace(/^\.\//, '');
            // Virtual fs — readFileSync/writeFileSync/existsSync/readdirSync/appendFileSync
            const _fs = {
                readFileSync:  (p, _enc) => { const k = _norm(p); if (!(k in files)) { const e = new Error(`ENOENT: no such file or directory, open '${p}'`); e.code = 'ENOENT'; throw e; } return files[k]; },
                writeFileSync: (p, c)    => { const k = _norm(p); written[k] = typeof c === 'string' ? c : String(c); files[k] = written[k]; },
                appendFileSync:(p, c)    => { const k = _norm(p); const prev = files[k] ?? ''; written[k] = prev + c; files[k] = written[k]; },
                existsSync:    (p)       => _norm(p) in files,
                readdirSync:   (p)       => { const pre = (p === '.' || p === '') ? '' : p.replace(/\/?$/, '/'); return [...new Set(Object.keys(files).filter(f => f.startsWith(pre)).map(f => f.slice(pre.length).split('/')[0]).filter(Boolean))]; },
            };
            // path shim
            const _path = {
                join:     (...a) => a.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '.',
                dirname:  (p)    => p.includes('/') ? p.split('/').slice(0, -1).join('/') || '/' : '.',
                basename: (p, e) => { const b = p.split('/').pop(); return e && b.endsWith(e) ? b.slice(0, -e.length) : b; },
                extname:  (p)    => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ''; },
                resolve:  (...a) => a.join('/').replace(/\/+/g, '/'),
            };
            const _require = m => {
                if (m === 'fs')   return _fs;
                if (m === 'path') return _path;
                throw new Error(`Cannot find module '${m}' — only 'fs' and 'path' are available in the browser JS sandbox`);
            };
            const _console = {
                log:   (...a) => stdout_lines.push(a.map(String).join(' ')),
                info:  (...a) => stdout_lines.push(a.map(String).join(' ')),
                error: (...a) => stderr_lines.push(a.map(String).join(' ')),
                warn:  (...a) => stderr_lines.push(a.map(String).join(' ')),
            };
            try {
                // eslint-disable-next-line no-new-func
                const fn = new Function('fs', 'require', 'console', 'process', `return (async()=>{ ${args.code} })()`);
                await fn(_fs, _require, _console, { env: {}, argv: ['node', 'script.js'], cwd: () => '.' });
                const write_errors = [];
                for (const [path, content] of Object.entries(written)) {
                    try {
                        await agentWriteFile(path, content);
                        if (context?.staging) context.staging.set(path, content);
                        _invalidateReadDedup(path);
                    } catch (e) {
                        write_errors.push(`${path}: ${e.message ?? e}`);
                    }
                }
                const written_ok = Object.keys(written).filter(p => !write_errors.some(e => e.startsWith(p + ':')));
                const extra_stderr = write_errors.length ? (stderr_lines.length ? '\n' : '') + write_errors.map(e => `[write failed] ${e}`).join('\n') : '';
                return { stdout: stdout_lines.join('\n'), stderr: stderr_lines.join('\n') + extra_stderr, exit_code: write_errors.length && !written_ok.length ? 1 : 0, ...(written_ok.length ? { files_written: written_ok } : {}), ...(write_errors.length ? { write_errors } : {}) };
            } catch (e) {
                return { stdout: stdout_lines.join('\n'), stderr: e.stack || e.message, exit_code: 1 };
            }
        })();
    } else if (typeof nativeExec === 'function') {
        // Headless mode: execute directly via Node child_process (bash/python/javascript).
        // Must come before Pyodide and local-sandbox so headless runs never
        // hit localhost:5000 or the Pyodide-loading-forever path.
        try { execResult = await nativeExec(args.language, args.code); }
        catch (e) { return { error: `nativeExec: ${e.message}` }; }
    } else if (_needsDisplay && args.language !== 'bash' && args.language !== 'javascript') {
        // pygame / tkinter / etc. need a real canvas — execute_code can't provide one.
        // The browser pygame runner (launched from the file panel) handles this: write
        // the game to a .py file and the user can run it in-browser with canvas + audio.
        return { error: 'pygame and other GUI libraries cannot run inside execute_code (no display). ' +
            'Write the game to a .py file using write_file, then tell the user to open it from the file panel — ' +
            'the browser pygame runner provides a full canvas and synthesised audio.' };
    } else if (args.language !== 'bash' && args.language !== 'javascript' && (pyodideStatus === 'ready' || pyodideStatus === 'loading')) {
        try { execResult = await runWithPyodide(args.code); }
        catch (e) { return { error: `Pyodide: ${e.message}` }; }
    } else {
        const provider = getSandboxProvider();
        if (provider === 'local') {
            try {
                const files = {};
                try {
                    // Use raw workspace records so binary files (encoding='base64') are sent
                    // as '\x00BIN\x00<base64>' instead of their text-extracted content.
                    const recs = await listWorkspaceFiles();
                    for (const rec of (recs || [])) {
                        if (!rec?.name || !rec.content) continue;
                        if (rec.content.length > 1_000_000) continue;
                        files[rec.name] = rec.encoding === 'base64'
                            ? `\x00BIN\x00${rec.content}`
                            : rec.content;
                    }
                } catch {}
                const resp = await fetch('http://localhost:5000/api/execute', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ language: args.language, code: args.code, files }),
                    signal:  activeAbortController?.signal,
                });
                if (!resp.ok) return { error: `Local sandbox HTTP ${resp.status}` };
                execResult = await resp.json();
                if (execResult.files_written) {
                    const writtenPaths = [];
                    for (const [path, content] of Object.entries(execResult.files_written as Record<string, string>)) {
                        const isBin = typeof content === 'string' && content.startsWith('\x00BIN\x00');
                        const enc   = isBin ? 'base64' : null;
                        const data  = isBin ? content.slice(5) : content;
                        await agentWriteFile(path, data, enc).catch(() => {});
                        if (context?.staging) context.staging.set(path, data);
                        // Invalidate dedup so a subsequent read_file sees the new content
                        _invalidateReadDedup(path);
                        writtenPaths.push(path);
                    }
                    // Strip file contents — they're in the workspace now; history only needs the paths
                    execResult = { ...execResult, files_written: writtenPaths };
                }
            } catch (e) { return { error: `Local sandbox: ${e.message} — is server.py running?` }; }
        } else if (args.language === 'bash' && provider === 'wasm' && typeof runWithWasm === 'function') {
            // Browser bash via x86-64 WASM emulator + musl-static binaries
            try { execResult = await runWithWasm(args.code); }
            catch (e) { return { error: `WASM: ${e.message}` }; }
        } else {
            return { error: args.language === 'bash'
                ? 'Bash requires a sandbox — enable WASM or Local in Settings → Code Execution.'
                : 'Load Pyodide in Settings → Code Execution to run Python in the browser.' };
        }
    }
    // Explicit bash that failed on what looks like Python: say so (never switch an explicit choice).
    if (_lang === 'bash' && execResult && !execResult.error && execResult.exit_code > 0 && _looksLikePython(args.code))
        execResult = { ...execResult, note: 'This looks like Python code but ran as bash — set language: "python".' };
    // Exit 0 with an error signature in stderr: a multi-command script's exit code reflects only
    // its last command, so an earlier failure can hide behind it. Annotate; never strip or replace
    // output — stderr also carries legitimate output (gcc -v, progress, warnings).
    if (execResult && !execResult.error && !(execResult.exit_code > 0) && _STDERR_ERROR_RE.test(execResult.stderr ?? ''))
        execResult = { ...execResult, note: 'Exit code 0, but stderr contains errors. An earlier command may have failed; the exit code only reflects the last one.' };
    return execResult;
}

async function _handlePhantomAlias(name, args, context) {
    // Shared remap helpers — each maps the alias's argument bag to the canonical tool's args.
    const _rBash   = (a) => ({ language: 'bash',              code: a.command ?? a.code ?? a.cmd ?? '' });
    const _rPy     = (a) => ({ language: 'python',            code: a.code ?? a.command ?? '' });
    const _rLang   = (a) => ({ language: a.language ?? 'bash', code: a.code ?? a.command ?? a.cmd ?? '' });
    const _rRead   = (a) => ({ path: a.path ?? a.file ?? a.filename ?? '' });
    const _rSearch = (a) => ({ pattern: a.pattern ?? a.query ?? a.regex ?? '' });

    const _PHANTOM_ALIASES = {
        // execute_code aliases — bash
        execute_bash:    { tool: 'execute_code',     remap: a => ({ language: 'bash', code: a.command ?? a.code ?? a.cmd ?? a.bash ?? '' }), hint: "Use execute_code(language='bash', code=…)" },
        execute_shell:   { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        run_bash:        { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        run_shell:       { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        bash:            { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        Bash:            { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        execute_command: { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…)" },
        run_tests:       { tool: 'execute_code',     remap: _rBash,  hint: "Use execute_code(language='bash', code=…) to run tests" },
        // execute_code aliases — python
        execute_python:  { tool: 'execute_code',     remap: _rPy,    hint: "Use execute_code(language='python', code=…)" },
        run_python:      { tool: 'execute_code',     remap: _rPy,    hint: "Use execute_code(language='python', code=…)" },
        // execute_code aliases — language passthrough
        execute:         { tool: 'execute_code',     remap: _rLang,  hint: "Use execute_code(language='bash', code=…)" },
        execute_tool:    { tool: 'execute_code',     remap: _rLang,  hint: "Use execute_code(language='bash', code=…)" },
        // read_file aliases
        read:            { tool: 'read_file',        remap: _rRead,  hint: "Use read_file(path=…)" },
        cat:             { tool: 'read_file',        remap: _rRead,  hint: "Use read_file(path=…)" },
        view:            { tool: 'read_file',        remap: _rRead,  hint: "Use read_file(path=…)" },
        read_code:       { tool: 'read_file',        remap: a => ({ path: a.path ?? a.file ?? '' }), hint: "Use read_file(path=…)" },
        // replace_in_file aliases
        edit_file:       { tool: 'replace_in_file',  remap: a => ({ path: a.path ?? a.file ?? '', old_string: a.old_string ?? a.old ?? '', new_string: a.new_string ?? a.new ?? a.replacement ?? '' }), hint: "Use replace_in_file(path=…, old_string=…, new_string=…)" },
        apply_change:    { tool: 'replace_in_file',  remap: a => ({ path: a.path ?? '',             old_string: a.old_string ?? a.old ?? '', new_string: a.new_string ?? a.new ?? '' }),                  hint: "Use replace_in_file(path=…, old_string=…, new_string=…)" },
        // write_file alias
        create_file:     { tool: 'write_file',       remap: a => ({ path: a.path ?? a.file ?? '', content: a.content ?? a.text ?? '' }), hint: "Use write_file(path=…, content=…)" },
        // search_workspace aliases
        grep:            { tool: 'search_workspace', remap: _rSearch, hint: "Use search_workspace(pattern=…)" },
        grep_files:      { tool: 'search_workspace', remap: a => ({ pattern: a.pattern ?? a.query ?? '' }), hint: "Use search_workspace(pattern=…)" },
        grep_workspace:  { tool: 'search_workspace', remap: _rSearch, hint: "Use search_workspace(pattern=…)" },
    };
    const _alias = _PHANTOM_ALIASES[name];
    if (_alias) {
        const result = await executeToolAsync(_alias.tool, _alias.remap(args ?? {}), context);
        // Suppress the note for code-execution aliases: the command already ran; telling the agent
        // it used the wrong tool causes it to retry execute_code with rewritten code, producing
        // format divergence (different date formats, SQL predicates, etc.) vs. the first run.
        const _isSilentAlias = ['execute_bash', 'execute_shell', 'run_bash', 'run_shell', 'bash', 'Bash', 'execute', 'execute_python', 'run_python'].includes(name);
        if (_isSilentAlias) return result;
        return { ...result, _note: `'${name}' is not a valid tool name. ${_alias.hint}` };
    }
    return { error: `Unknown tool: ${name}` };
}
export async function executeToolAsync(name, args, context = null) {
    // Role tool-filter enforcement: reject calls to tools outside the role's allowed set.
    // context is non-null for sub-worker calls; those bypass the role filter (forWorker=true).
    if (!context && typeof mainAgentRole !== 'undefined' && mainAgentRole?.tools
        && !mainAgentRole.tools.has(name)) {
        const hint = mainAgentRole.name === 'director'
            ? 'Delegate this via run_workers if needed.'
            : `Declare BLOCKED: '${name}' is not available in this role — the Director will handle it.`;
        return { error: `Tool '${name}' is not available in the current role (${mainAgentRole.name}). ${hint}` };
    }

    if (getIntentValidation() !== 'off' && _IV_HIGH_RISK.has(name)) {
        const check = _ivCheck(name, args);
        if (check) {
            _ivLog(name, args, check).catch(() => {});
            return { error: `[Intent validation — ${check.level === 'block' ? 'BLOCKED' : 'FLAGGED'}] ${check.reason}. If this is intentional, make the request explicit in your message.` };
        }
    }

    // Tool approval gate — only in main agent context (not sub-workers), only when enabled
    if (!context && !_toolApprovalSession.has(name)) {
        const approval = getToolApproval();
        const needsApproval =
            (approval === 'high' && (_APPROVAL_HIGH_RISK.has(name) && !(name === 'execute_code' && args.language === 'python'))) ||
            (approval === 'all'  && _APPROVAL_ALL_WRITE.has(name));
        if (needsApproval) {
            const allowed = await requestToolApproval(name, args);
            if (!allowed) return { error: 'User denied tool execution.' };
        }
    }

    if (name === 'run_workers')        return _handleRunWorkers(args, context);
    if (name === 'list_files')         return _handleListFiles(args, context);
    if (name === 'read_file')          return _handleReadFile(args, context);

    // SWE-bench test-file gate (headless only) — must precede write-tool dispatch.
    if (typeof nativeExec === 'function' &&
        (name === 'write_file' || name === 'replace_in_file' || name === 'append_file' || name === 'apply_patch') &&
        args.path && _SWE_TEST_RE.test(args.path))
        return { error: `Editing test files is not reflected in the grade — the grader strips test-file changes before scoring; fix the source code instead (${args.path}).` };

    if (name === 'write_file')         return _handleWriteFile(args, context);
    if (name === 'ast_query')          return _handleAstQuery(args);
    if (name === 'run_git')            return _handleRunGit(args);
    if (name === 'undo_write')         return _handleUndoWrite(args);
    if (name === 'replace_in_file')    return _handleReplaceInFile(args, context);
    if (name === 'apply_patch')        return _handleApplyPatch(args, context);
    if (name === 'delete_file')        return _handleDeleteFile(args, context);
    if (name === 'append_file')        return _handleAppendFile(args, context);
    if (name === 'web_search')         return _handleWebSearch(args);
    if (name === 'deep_research')      return _handleDeepResearch(args);
    if (name === 'context7_docs')      return _handleContext7Docs(args);
    if (name === 'fetch_url')          return _handleFetchUrl(args);
    if (name === 'generate_image')     return _handleGenerateImage(args);
    if (name === 'execute_code')       return _handleExecuteCode(args, context);
    if (name === 'academic_search')    return _handleAcademicSearch(args);
    if (name === 'package_search')     return _handlePackageSearch(args);
    if (name === 'repo_map')           return _handleRepoMap(args);
    if (name === 'search_workspace')   return _handleSearchWorkspace(args);
    if (name === 'submit_answer')      return _handleSubmitAnswer(args);
    if (name === 'update_task_status') return _handleUpdateTaskStatus(args);
    return _handlePhantomAlias(name, args, context);
}


export function toolLabel(name, args) {
    const a = args || {};
    if (name === 'read_file')         return `read:${a.path}`;
    if (name === 'write_file')        return `write:${a.path}`;
    if (name === 'undo_write')        return `undo:${a.path}`;
    if (name === 'replace_in_file')   return `replace:${a.path}`;
    if (name === 'apply_patch')        return `patch:${a.path}`;
    if (name === 'append_file')       return `append:${a.path}`;
    if (name === 'delete_file')       return `del:${a.path}`;

    if (name === 'list_files')        return 'list_files';
    if (name === 'web_search')        return `search:${(a.query || '').slice(0, 28)}${a.source ? '/' + a.source : ''}`;
    if (name === 'academic_search')   return `academic:${(a.query || '').slice(0, 24)}${a.source ? '/' + a.source : ''}`;
    if (name === 'package_search')    return `pkg:${(a.query || '').slice(0, 28)}${a.registry ? '/' + a.registry : ''}`;
    if (name === 'deep_research')     return `research:${(a.question || a.topic || '').slice(0, 36)}`;
    if (name === 'fetch_url')         return `fetch:${(a.url || '').replace(/^https?:\/\//, '').slice(0, 36)}`;
    if (name === 'generate_image')    return `imagine:${(a.prompt || '').slice(0, 40)}`;
    if (name === 'execute_code')      return `exec(${a.language})`;
    if (name === 'ast_query')         return `ast:${a.path}?${a.query || 'symbols'}`;
    if (name === 'run_git')           return `git ${(a.args || []).join(' ')}`;
    if (name === 'run_workers')       return `workers(${(Array.isArray(a.agents) ? a.agents : []).map(w => w.role ? `${w.id}:${w.role}` : w.id).join(',')})`;
    if (name === 'repo_map')                  return `repo_map${a.path_filter ? ':' + a.path_filter : ''}`;
    if (name === 'search_workspace')            return `grep:${(a.pattern || '').slice(0, 32)}${a.path_filter ? ' in ' + a.path_filter : ''}`;
    if (name === 'update_task_status')        return `task:${a.path ? a.path.replace('fg-tasks/', '') : '?'} → ${a.status || '?'}`;
    if (name === 'context7_docs')             return `context7:${a.library || ''}${a.topic ? '/' + a.topic : ''}`;
    // Fallback for unknown tool names (custom MCP tools, or a model emitting malformed
    // markup as a tool name): strip tags and clamp so the badge can't become a wall of text.
    const clean = String(name).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 45) + '…' : clean;
}


// Window bridge for classic scripts.
Object.assign(window, { executeToolAsync, toolLabel, _rewriteHunkCounts });
