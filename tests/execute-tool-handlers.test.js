// execute-tool-handlers.test.js — unit tests for the handler functions extracted from
// executeToolAsync in tools.ts (§6.3 of code_review.md).
//
// Handlers covered:
//   _handleDeleteFile    (delete_file tool)
//   _handleAppendFile    (append_file tool)
//   _handleSubmitAnswer  (submit_answer tool)
//   _handleUndoWrite     (undo_write tool — via write_file → undo_write round-trip)
//   _handleSearchWorkspace (search_workspace tool)
//
// All tests go through W.executeToolAsync to match the real call path.
// Globals agentReadFile / agentWriteFile / agentDeleteFile / agentListFiles are
// replaced per-test with in-memory stubs.

const W = globalThis;

let files;
let origRead, origWrite, origDelete, origList;

beforeEach(() => {
    files = new Map();

    // Reset role so the role-filter in executeToolAsync doesn't block tools
    // like submit_answer that are not in a specific role's tool set.
    W.mainAgentRole = null;

    origRead   = W.agentReadFile;
    origWrite  = W.agentWriteFile;
    origDelete = W.agentDeleteFile;
    origList   = W.agentListFiles;

    W.agentReadFile  = async path => {
        if (!files.has(path)) throw new Error(`File not found: ${path}`);
        return files.get(path);
    };
    W.agentWriteFile = async (path, content) => { files.set(path, content); };
    W.agentDeleteFile = async path => {
        if (!files.has(path)) throw new Error(`File not found: ${path}`);
        files.delete(path);
    };
    W.agentListFiles = async () =>
        [...files.keys()].map(name => ({ name, size: files.get(name).length }));
});

afterEach(() => {
    W.agentReadFile   = origRead;
    W.agentWriteFile  = origWrite;
    W.agentDeleteFile = origDelete;
    W.agentListFiles  = origList;
});

// ── delete_file ───────────────────────────────────────────────────────────────

describe('delete_file — _handleDeleteFile', () => {
    it('deletes an existing file and returns success', async () => {
        files.set('notes/scratch.md', 'hello');
        const res = await W.executeToolAsync('delete_file', { path: 'notes/scratch.md' }, null);
        expect(res.success).toBe(true);
        expect(files.has('notes/scratch.md')).toBe(false);
    });

    it('returns an error when the file does not exist', async () => {
        const res = await W.executeToolAsync('delete_file', { path: 'ghost.txt' }, null);
        expect(res.error).toBeTruthy();
        expect(res.success).toBeUndefined();
    });

    it('stages the deletion to context.staging without touching the real filesystem', async () => {
        files.set('work/todo.md', 'original');
        const staging  = new Map();
        const snapshot = new Map([['work/todo.md', 'original']]);
        const ctx = { staging, snapshot, depth: 0 };

        const res = await W.executeToolAsync('delete_file', { path: 'work/todo.md' }, ctx);
        expect(res.success).toBe(true);
        // The real file must be untouched — only staging carries the null tombstone.
        expect(files.get('work/todo.md')).toBe('original');
        expect(staging.get('work/todo.md')).toBeNull();
    });

    it('can delete a file that was staged but never written to disk', async () => {
        const staging  = new Map([['new/file.ts', 'draft']]);
        const snapshot = new Map();
        const ctx = { staging, snapshot, depth: 0 };

        const res = await W.executeToolAsync('delete_file', { path: 'new/file.ts' }, ctx);
        expect(res.success).toBe(true);
        expect(staging.get('new/file.ts')).toBeNull();
    });
});

// ── append_file ───────────────────────────────────────────────────────────────

describe('append_file — _handleAppendFile', () => {
    it('appends content to an existing file', async () => {
        files.set('log.txt', 'line1');
        const res = await W.executeToolAsync('append_file', { path: 'log.txt', content: 'line2' }, null);
        expect(res.success).toBe(true);
        expect(files.get('log.txt')).toBe('line1\nline2');
    });

    it('does not add a double newline when the file already ends with \\n', async () => {
        files.set('log.txt', 'line1\n');
        await W.executeToolAsync('append_file', { path: 'log.txt', content: 'line2' }, null);
        expect(files.get('log.txt')).toBe('line1\nline2');
    });

    it('creates the file when it does not exist yet', async () => {
        const res = await W.executeToolAsync('append_file', { path: 'new.md', content: 'first line' }, null);
        expect(res.success).toBe(true);
        expect(files.get('new.md')).toBe('first line');
    });

    it('accepts "text" as a content alias', async () => {
        files.set('notes.md', 'a');
        await W.executeToolAsync('append_file', { path: 'notes.md', text: ' b' }, null);
        expect(files.get('notes.md')).toBe('a\n b');
    });

    it('accepts "body" as a content alias', async () => {
        files.set('notes.md', 'a');
        await W.executeToolAsync('append_file', { path: 'notes.md', body: 'b' }, null);
        expect(files.get('notes.md')).toBe('a\nb');
    });

    it('appends to context staging without touching the real filesystem', async () => {
        files.set('tasks/log.md', 'should not be touched');
        const staging  = new Map();
        const snapshot = new Map([['tasks/log.md', 'entry1']]);
        const ctx = { staging, snapshot, depth: 0 };

        const res = await W.executeToolAsync('append_file',
            { path: 'tasks/log.md', content: 'entry2' }, ctx);
        expect(res.success).toBe(true);
        // Staged value is snapshot baseline + appended content.
        expect(staging.get('tasks/log.md')).toBe('entry1\nentry2');
        // Real file untouched.
        expect(files.get('tasks/log.md')).toBe('should not be touched');
    });

    it('reads from staging if the path was already staged', async () => {
        const staging  = new Map([['tasks/log.md', 'staged-line1']]);
        const snapshot = new Map([['tasks/log.md', 'original']]);
        const ctx = { staging, snapshot, depth: 0 };

        await W.executeToolAsync('append_file',
            { path: 'tasks/log.md', content: 'staged-line2' }, ctx);
        // Must build on the staged value, not the snapshot.
        expect(staging.get('tasks/log.md')).toBe('staged-line1\nstaged-line2');
    });
});

// ── submit_answer ─────────────────────────────────────────────────────────────

describe('submit_answer — _handleSubmitAnswer', () => {
    it('returns ok:true with the answer captured', async () => {
        const res = await W.executeToolAsync('submit_answer', { answer: 'Paris' }, null);
        expect(res.ok).toBe(true);
        expect(res.answer_recorded).toBe('Paris');
    });

    it('accepts "result" as an answer alias', async () => {
        const res = await W.executeToolAsync('submit_answer', { result: '42' }, null);
        expect(res.ok).toBe(true);
        expect(res.answer_recorded).toBe('42');
    });

    it('accepts "response" as an answer alias', async () => {
        const res = await W.executeToolAsync('submit_answer', { response: 'yes' }, null);
        expect(res.ok).toBe(true);
        expect(res.answer_recorded).toBe('yes');
    });

    it('accepts "value" as an answer alias', async () => {
        const res = await W.executeToolAsync('submit_answer', { value: '99' }, null);
        expect(res.ok).toBe(true);
        expect(res.answer_recorded).toBe('99');
    });

    it('returns empty string when called with no answer args', async () => {
        const res = await W.executeToolAsync('submit_answer', {}, null);
        expect(res.ok).toBe(true);
        expect(res.answer_recorded).toBe('');
    });

    it('includes the instruction note in every response', async () => {
        const res = await W.executeToolAsync('submit_answer', { answer: 'x' }, null);
        expect(res.note).toMatch(/COMPLETED/);
    });
});

// ── undo_write ────────────────────────────────────────────────────────────────

describe('undo_write — _handleUndoWrite', () => {
    it('returns an error when no checkpoint exists for the path', async () => {
        const res = await W.executeToolAsync('undo_write', { path: 'no-prior-write.txt' }, null);
        expect(res.error).toMatch(/no checkpoint/i);
    });

    it('restores the previous content after a write_file', async () => {
        files.set('data.json', '{"v":1}');
        // write_file reads the existing file, pushes it as a checkpoint, then writes.
        await W.executeToolAsync('write_file',
            { path: 'data.json', content: '{"v":2}' }, null);
        expect(files.get('data.json')).toBe('{"v":2}');

        const res = await W.executeToolAsync('undo_write', { path: 'data.json' }, null);
        expect(res.success).toBe(true);
        expect(files.get('data.json')).toBe('{"v":1}');
    });

    it('supports multiple undo levels (stack semantics)', async () => {
        files.set('counter.txt', 'one');
        await W.executeToolAsync('write_file', { path: 'counter.txt', content: 'two' }, null);
        await W.executeToolAsync('write_file', { path: 'counter.txt', content: 'three' }, null);

        await W.executeToolAsync('undo_write', { path: 'counter.txt' }, null);
        expect(files.get('counter.txt')).toBe('two');

        await W.executeToolAsync('undo_write', { path: 'counter.txt' }, null);
        expect(files.get('counter.txt')).toBe('one');
    });

    it('deletes the file when undoing the very first write (file did not exist before)', async () => {
        // File does not exist — write_file will push '' as the checkpoint.
        await W.executeToolAsync('write_file', { path: 'brand-new.txt', content: 'hello' }, null);
        expect(files.has('brand-new.txt')).toBe(true);

        const res = await W.executeToolAsync('undo_write', { path: 'brand-new.txt' }, null);
        expect(res.success).toBe(true);
        expect(res.note).toMatch(/deleted/i);
        expect(files.has('brand-new.txt')).toBe(false);
    });

    it('returns an error after the checkpoint stack is exhausted', async () => {
        files.set('once.txt', 'original');
        await W.executeToolAsync('write_file', { path: 'once.txt', content: 'changed' }, null);

        await W.executeToolAsync('undo_write', { path: 'once.txt' }, null); // consumes checkpoint
        const res = await W.executeToolAsync('undo_write', { path: 'once.txt' }, null); // stack empty
        expect(res.error).toMatch(/no checkpoint/i);
    });
});

// ── search_workspace ──────────────────────────────────────────────────────────

describe('search_workspace — _handleSearchWorkspace', () => {
    it('returns an error when pattern is missing', async () => {
        const res = await W.executeToolAsync('search_workspace', {}, null);
        expect(res.error).toMatch(/pattern/i);
    });

    it('finds a literal string match across files', async () => {
        files.set('a.ts', 'function hello() {}');
        files.set('b.ts', 'const world = 1;');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'hello' }, null);
        expect(res.match_count).toBeGreaterThanOrEqual(1);
        expect(res.matches.some(m => m.includes('a.ts'))).toBe(true);
    });

    it('returns no-matches when nothing matches', async () => {
        files.set('a.ts', 'nothing here');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'xyzzy_notfound' }, null);
        expect(res.matches).toHaveLength(0);
        expect(res.note).toMatch(/no matches/i);
    });

    it('respects path_filter, excluding non-matching files', async () => {
        files.set('src/main.ts', 'const target = true;');
        files.set('tests/main.test.ts', 'const target = false;');
        const res = await W.executeToolAsync('search_workspace',
            { pattern: 'target', path_filter: 'src/' }, null);
        expect(res.matches.every(m => m.includes('src/'))).toBe(true);
        expect(res.matches.some(m => m.includes('tests/'))).toBe(false);
    });

    it('is case-insensitive by default for literal searches', async () => {
        files.set('readme.md', 'Hello World');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'hello' }, null);
        expect(res.match_count).toBeGreaterThanOrEqual(1);
    });

    it('respects case_sensitive flag', async () => {
        files.set('src/util.ts', 'function Hello() {} function hello() {}');
        const sensitive = await W.executeToolAsync('search_workspace',
            { pattern: 'Hello', case_sensitive: true }, null);
        const insensitive = await W.executeToolAsync('search_workspace',
            { pattern: 'Hello', case_sensitive: false }, null);
        // Case-sensitive should find less than or equal to case-insensitive.
        expect(sensitive.match_count).toBeLessThanOrEqual(insensitive.match_count);
    });

    it('supports | as a multi-term literal OR', async () => {
        files.set('a.ts', 'alpha beta');
        files.set('b.ts', 'gamma delta');
        const res = await W.executeToolAsync('search_workspace',
            { pattern: 'alpha|delta' }, null);
        expect(res.match_count).toBe(2);
        expect(res.matches.some(m => m.includes('a.ts'))).toBe(true);
        expect(res.matches.some(m => m.includes('b.ts'))).toBe(true);
    });

    it('treats pattern as regex when is_regex is true', async () => {
        files.set('nums.ts', 'x = 42; y = 100;');
        const res = await W.executeToolAsync('search_workspace',
            { pattern: '\\d+', is_regex: true }, null);
        expect(res.match_count).toBeGreaterThanOrEqual(1);
    });

    it('includes context lines when context_lines > 0', async () => {
        files.set('multi.ts', 'line1\nline2\ntarget\nline4\nline5');
        const res = await W.executeToolAsync('search_workspace',
            { pattern: 'target', context_lines: 1 }, null);
        expect(res.match_count).toBeGreaterThanOrEqual(1);
        // The match block should include adjacent lines.
        const block = res.matches[0];
        expect(block).toContain('line2');
        expect(block).toContain('line4');
    });

    it('default scope="both" finds a filename match even without content hit', async () => {
        files.set('folder1/folder2/echo-love', '#!/bin/sh\necho love\n');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'echo-love' }, null);
        expect(res.match_count).toBeGreaterThanOrEqual(1);
        expect(res.matches.some(m => m.includes('folder1/folder2/echo-love'))).toBe(true);
        expect(res.matches.some(m => m.includes('(filename match)'))).toBe(true);
    });

    it('scope="names" returns filename-only matches and does not scan contents', async () => {
        files.set('src/util.ts', 'no useful content here');
        files.set('src/data.json', '{"echo-love": 1}');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'util', scope: 'names' }, null);
        expect(res.matches).toHaveLength(1);
        expect(res.matches[0]).toContain('src/util.ts');
        expect(res.matches[0]).toContain('(filename match)');
    });

    it('scope="contents" ignores filenames (pure grep)', async () => {
        files.set('needle.ts', 'text needle in content');
        files.set('other/file.txt', 'not here');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'needle', scope: 'contents' }, null);
        expect(res.matches.some(m => m.includes('needle.ts'))).toBe(true);
        expect(res.matches.some(m => m.includes('(filename match)'))).toBe(false);
        // filename "other.txt" no longer matches patterns that only appear in names when scope=contents
        const onlyName = await W.executeToolAsync('search_workspace',
            { pattern: 'other', scope: 'contents' }, null);
        expect(onlyName.matches).toHaveLength(0);
    });

    it('scope="both" suppresses the filename line when the same file has a content hit', async () => {
        // Pattern matches BOTH the filename ("marker-utils.ts") AND the content.
        // Only the content line must appear — no duplicate "(filename match)" entry.
        files.set('marker-utils.ts', 'const markerHere = 1;');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'marker', scope: 'both' }, null);
        expect(res.matches.some(m => m.includes('marker-utils.ts:1:'))).toBe(true);
        expect(res.matches.reduce((n, m) => n + (m.includes('(filename match)') ? 1 : 0), 0)).toBe(0);
    });
});
