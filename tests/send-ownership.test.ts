// codex report 8, cases 319-322, 329 (Send waiting for a loading chat) and 352-355 (a dequeued message being prepared).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
    await import('../settings-ui.ts');
    await import('../agent-core.ts');
    await import('../chat-state.ts');
});
beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="img-strip"></div><div id="agent-input" contenteditable>hello</div><div id="agent-messages"></div>';
    W.clearImageAttachments(); W.setAgentStreaming(false); W.setAiJob(''); W.msgQueue?.clear?.();
    W.addVoiceButtons ??= () => {};
    W.activeChatId = 'B';
    const inp = document.getElementById('agent-input')!;   // jsdom has no innerText
    Object.defineProperty(inp, 'innerText', { get() { return inp.textContent; }, set(v) { inp.textContent = v; }, configurable: true });
});
afterEach(() => { W.setAgentStreaming(false); W.setAiJob(''); vi.restoreAllMocks(); });

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

describe('Send waiting for a loading chat', () => {
    it('a second click while the first waits starts nothing (319)', async () => {
        const end = W.beginChatLoad('B');
        const p1 = W.agentSend();
        expect(W.turnsInFlight()).toBe(1);
        const p2 = W.agentSend(); const p3 = W.agentSend();
        await Promise.all([p2, p3]);
        expect(W.turnsInFlight()).toBe(1);          // still the one waiting send
        W.cancelSendPreparation(); end(); await p1;
        expect(W.turnsInFlight()).toBe(0);
    });
    it('Escape cancels the wait and the draft stays in the box (329)', async () => {
        const end = W.beginChatLoad('B');
        const p = W.agentSend();
        await tick();
        expect(W.cancelSendPreparation()).toBe(true);
        await p;
        end();
        expect(document.getElementById('agent-input')!.textContent).toBe('hello');
        expect(W.turnsInFlight()).toBe(0);
        expect(W.aiBusy()).toBe(false);
    });
    it('leaving the chat and coming back before the load ends drops the old Send (322)', async () => {
        const endB = W.beginChatLoad('B');
        const p = W.agentSend();
        // the reader opens A, returns to B and types something else
        W.activeChatId = 'A'; const endA = W.beginChatLoad('A'); endA();
        W.activeChatId = 'B'; const endB2 = W.beginChatLoad('B'); endB2();
        document.getElementById('agent-input')!.textContent = 'a different draft';
        endB();
        await p;
        expect(document.getElementById('agent-input')!.textContent).toBe('a different draft');   // not taken, not sent
        expect(W.turnsInFlight()).toBe(0);
    });
});

describe('a dequeued message is a preparation (352/354/355)', () => {
    it('the chat reads busy while it is prepared, a manual Send queues, and Escape cancels it', async () => {
        let release!: (v: boolean | null) => void;
        W.collectWorkspacePaths = async () => [];
        W.isTaskCompletionRequest = () => new Promise(r => { release = r; });
        const turn = W.runAgentTurn('queued question', null);
        await tick();
        expect(W.aiBusy()).toBe(true);                            // New chat and the Send button see a busy chat
        expect(W.agentStreaming).toBe(false);
        await W.agentSend();                                      // manual Send while preparing: queued, not a second main reply
        expect(W.msgQueue.size()).toBe(1);
        expect(W.cancelSendPreparation()).toBe(true);             // Escape
        W.msgQueue.clear();
        release(false);
        const r = await turn;
        expect(r.finishSignal).toBe('stopped');
        expect(W.aiBusy()).toBe(false);
        expect(W.getChatHistory().length).toBe(0);                // nothing was written for the cancelled turn
        delete W.collectWorkspacePaths; delete W.isTaskCompletionRequest;
    });
    it('the Send button and Enter (userSend) queue the draft too, they do not drop it (465/466)', async () => {
        let release!: (v: boolean | null) => void;
        W.collectWorkspacePaths = async () => [];
        W.isTaskCompletionRequest = () => new Promise(r => { release = r; });
        const turn = W.runAgentTurn('queued question', null);
        await tick();
        W.userSend();
        await tick();
        expect(W.msgQueue.size()).toBe(1);
        expect(document.getElementById('agent-input')!.textContent).toBe('');
        W.cancelSendPreparation(); W.msgQueue.clear(); release(false); await turn;
        delete W.collectWorkspacePaths; delete W.isTaskCompletionRequest;
    });
    it('abandoned by leaving the chat', async () => {
        let release!: (v: boolean | null) => void;
        W.collectWorkspacePaths = async () => [];
        W.isTaskCompletionRequest = () => new Promise(r => { release = r; });
        const turn = W.runAgentTurn('queued question', null);
        await tick();
        W.activeChatId = 'C';
        release(false);
        expect((await turn).finishSignal).toBe('stopped');
        expect(W.aiBusy()).toBe(false);
        delete W.collectWorkspacePaths; delete W.isTaskCompletionRequest;
    });
});
