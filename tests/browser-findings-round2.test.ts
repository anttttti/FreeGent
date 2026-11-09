import { describe, it, expect, beforeAll } from 'vitest';

const W = window as any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../config.ts');
    await import('../workspace.ts');
    await import('../tools.ts');
    await import('../profiles.ts');
});

describe('project import validation', () => {
    it('rejects structures that would fail halfway', async () => {
        const { validateProjectData } = await import('../workspace.ts');
        expect(() => validateProjectData({ fg_project: 1, workspace: {} })).toThrow();
        expect(() => validateProjectData({ fg_project: 1, workspace: [{ name: 'a', content: 'x' }, null] })).toThrow();
        expect(() => validateProjectData({ fg_project: 1, workspace: [{ name: 'a', content: 5 }] })).toThrow();
        expect(() => validateProjectData({ fg_project: 1, workspace: [], chatData: [] })).toThrow();
        expect(() => validateProjectData({ fg_project: 1, workspace: [{ name: 'a', content: 'x' }], chatData: {} })).not.toThrow();
        // a chat list or history that is not text must not read as "no chats" and wipe the current ones (codex R538, R539)
        expect(() => validateProjectData({ fg_project: 1, workspace: [], chatData: { fg_chat_list: { id: 'a' } } })).toThrow(/chat list is not text/);
        expect(() => validateProjectData({ fg_project: 1, workspace: [], chatData: { fg_chat_list: '[]', fg_chat_c1_oh: 5 } })).toThrow(/history of chat "c1" is not text/);
    });
});

describe('profile credentials', () => {
    it('stripModelKeys drops key and apiKey from every model', async () => {
        const { stripModelKeys } = await import('../profiles.ts');
        const out = JSON.parse(stripModelKeys(JSON.stringify([{ model: 'a', key: 'S1' }, { model: 'b', apiKey: 'S2', url: 'u' }])) as string);
        expect(JSON.stringify(out)).not.toMatch(/S1|S2/);
        expect(out[1].url).toBe('u');
    });
});


describe('workspace paths', () => {
    it('a drive path or backslashes stay inside the workspace', async () => {
        const { workspaceName } = await import('../workspace.ts');
        expect(workspaceName('C:\\win.txt')).toBe('win.txt');
        expect(workspaceName('a\\b\\c.txt')).toBe('a/b/c.txt');
        expect(workspaceName('a:b.txt')).toBe('a:b.txt');
        expect(() => workspaceName('..\\x')).toThrow();
    });
});

describe('approvals and disabled tools', () => {
    it('cancelPendingApprovals denies the queued and the shown approval, and refuses the next ask of the same batch until a new turn', async () => {
        if (!document.getElementById('tool-approval-toast'))
            document.body.insertAdjacentHTML('beforeend', '<div id="tool-approval-toast"><span id="tool-approval-label"></span><input type="checkbox" id="tool-approval-session"><span id="tool-approval-session-name"></span></div>');
        const { requestToolApproval, cancelPendingApprovals, reopenApprovals } = await import('../tools.ts');
        expect(typeof requestToolApproval).toBe('function');   // exported: a missing function must fail, not skip
        const a = requestToolApproval('write_file', { path: 'x' }), b = requestToolApproval('write_file', { path: 'y' });
        cancelPendingApprovals();
        expect(await a).toBe(false);
        expect(await b).toBe(false);
        // the batch's next call asks after the cancel: refused at once, no toast
        expect(await requestToolApproval('write_file', { path: 'z' })).toBe(false);
        expect(document.getElementById('tool-approval-toast')!.style.display).toBe('none');
        reopenApprovals();
        const c = requestToolApproval('write_file', { path: 'later' });
        await Promise.resolve();
        expect(document.getElementById('tool-approval-toast')!.style.display).not.toBe('none');
        cancelPendingApprovals(); await c; reopenApprovals();
    });
    it('isToolOffByUser follows the Settings toggle', async () => {
        const { isToolOffByUser } = await import('../tools.ts');
        const { enabledTools } = await import('../config.ts');
        enabledTools.delete('write_file');
        expect(isToolOffByUser('write_file')).toBe(true);
        enabledTools.add('write_file');
        expect(isToolOffByUser('write_file')).toBe(false);
        enabledTools.delete('write_file');
    });
});

describe('own-endpoint 503', () => {
    it('is a server error to retry soon, not a rate limit, on a custom endpoint', async () => {
        const { _isRateLimit } = await import('../model-router.ts');
        expect(_isRateLimit('HTTP 503: busy', { provider: 'custom', model: 'm' })).toBe(false);
        expect(_isRateLimit('HTTP 503: busy', { provider: 'groq', model: 'm' })).toBe(true);
        expect(_isRateLimit('HTTP 429: x', { provider: 'custom', model: 'm' })).toBe(true);
    });
});

// codex R314: a browser action's approval names the page, the element and what goes into it.
describe('browser action approvals', () => {
    it('say where and what', async () => {
        const { approvalSummary } = await import('../tools.ts');
        expect(approvalSummary('browser_navigate', { url: 'http://localhost:3000/checkout' })).toBe('browser_navigate: http://localhost:3000/checkout');
        expect(approvalSummary('browser_type', { ref: 'e12', text: 'ada@example.com', submit: true })).toBe('browser_type element e12: types "ada@example.com" and presses Enter');
        expect(approvalSummary('browser_select', { ref: 'e3', values: ['NZ'] })).toBe('browser_select element e3: chooses "NZ"');
    });
    it('an MCP call shows what it is sent (codex R708)', async () => {
        const { approvalSummary } = await import('../tools.ts');
        expect(approvalSummary('mcp__crm__delete_contact', { id: 42, hard: true })).toBe('mcp__crm__delete_contact: {"id":42,"hard":true}');
        expect(approvalSummary('mcp__crm__list', {})).toBe('mcp__crm__list');
    });
});
