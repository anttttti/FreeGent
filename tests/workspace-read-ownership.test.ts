// codex report 8, case 219: a workspace file read that fails after Clear belongs to the cleared composer, not the fresh chat.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
});
beforeEach(() => {
    document.body.innerHTML = '<div id="img-strip"></div>';
    W.clearImageAttachments(); W.activeChatId = 'A';
});
afterEach(() => { W.clearImageAttachments(); delete W.agentReadFileBytes; delete W.agentListFiles; });

function gated() {
    let fail!: (e: Error) => void, ok!: (b: Uint8Array) => void;
    W.agentReadFileBytes = () => new Promise((res, rej) => { ok = res; fail = rej; });
    return { fail: (m: string) => fail(new Error(m)), ok: (t: string) => ok(new TextEncoder().encode(t)) };
}
const tick = () => new Promise(r => setTimeout(r, 10));

describe('workspace read ownership (219)', () => {
    it('a Select-picker read that fails after Clear warns nobody and reaches no request', async () => {
        const g = gated();
        W.agentListFiles = async () => [{ name: 'data/a.txt', size: 3 }];
        const p = W.attachFromWorkspace();
        await tick();
        (document.querySelector('.ws-pick-row input') as HTMLInputElement).click();
        (document.querySelector('.ws-pick-footer button:last-child') as HTMLElement).click();
        await tick();
        W.clearImageAttachments();
        g.fail('canceled read failed');
        await p; await tick();
        expect(document.getElementById('img-strip')!.textContent).toBe('');
        expect(W.takeAttachmentFailures?.() ?? []).toEqual([]);
    });
    it('a read that succeeds after Clear attaches nothing', async () => {
        const g = gated();
        const p = W.addWorkspaceAttachment('data/a.txt');
        W.clearImageAttachments();
        g.ok('hello');
        await p; await tick();
        expect(W.getPendingAttachments().files).toEqual([]);
    });
    it('a read that fails in the open chat still warns once', async () => {
        const g = gated();
        const p = W.addWorkspaceAttachment('data/a.txt').catch(() => {});
        g.fail('disk error');
        await p; await tick();
        expect(document.querySelectorAll('.media-warn-chip').length).toBe(1);
        expect(W.takeAttachmentFailures().length).toBe(1);
    });
    it('a read that fails after switching chats is kept for its own chat', async () => {
        const g = gated();
        const p = W.addWorkspaceAttachment('data/a.txt').catch(() => {});
        W.parkPendingAttachments('A'); W.clearImageAttachments(); W.activeChatId = 'B';
        g.fail('late');
        await p; await tick();
        expect(document.querySelectorAll('.media-warn-chip').length).toBe(0);
        W.activeChatId = 'A'; W.restoreParkedAttachments('A');
        expect(document.querySelectorAll('.media-warn-chip').length).toBe(1);
    });
});

describe('a parked chat\'s second-stage read (391/393)', () => {
    it('does not hold another chat\'s Send, and is shown again when the reader returns', async () => {
        const g = gated();
        let finishExtract!: (t: string) => void;
        W.extractDocumentText = () => new Promise<string>(r => { finishExtract = r; });
        const p = W.addWorkspaceAttachment('docs/a.pdf').catch(() => {});
        W.parkPendingAttachments('A'); W.clearImageAttachments(); W.activeChatId = 'B';
        g.ok('%PDF-1.4 fake');                       // stage 1 finishes while B is open; stage 2 (extraction) starts
        await vi.waitFor(() => expect(typeof finishExtract).toBe('function'));
        expect(W.hasPendingAttachments()).toBe(false);   // B can send
        finishExtract('extracted text'); await p; await tick(30);
        W.activeChatId = 'A'; W.restoreParkedAttachments('A');
        expect(W.getPendingAttachments().files.map((f: any) => f.name)).toEqual(['a.pdf']);
        delete W.extractDocumentText;
    });
    it('an extraction failure after Clear is neither shown nor sent in the fresh chat', async () => {
        const g = gated();
        let failExtract!: (e: Error) => void;
        W.extractDocumentText = () => new Promise<string>((_r, rej) => { failExtract = rej; });
        W.agentListFiles = async () => [{ name: 'docs/a.pdf', size: 3 }];
        const p = W.attachFromWorkspace();
        await tick();
        (document.querySelector('.ws-pick-row input') as HTMLInputElement).click();
        (document.querySelector('.ws-pick-footer button:last-child') as HTMLElement).click();
        await tick();
        g.ok('%PDF-1.4 fake');
        await vi.waitFor(() => expect(typeof failExtract).toBe('function'));
        W.clearImageAttachments();                    // Clear
        failExtract(new Error('library failed'));
        await p; await tick(30);
        expect(document.getElementById('img-strip')!.textContent).toBe('');
        expect(W.takeAttachmentFailures()).toEqual([]);
        delete W.extractDocumentText; delete W.agentListFiles;
    });
});
