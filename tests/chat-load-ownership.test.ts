// codex report 8, cases 276-285: a chat is active before its history, draft and parked attachments are restored.
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
    document.body.innerHTML = '<div id="img-strip"></div><div id="agent-input" contenteditable></div><div id="agent-messages"></div>';
    W.clearImageAttachments(); W.setAgentStreaming(false); W.setAiJob('');
    W.addVoiceButtons ??= () => {};
});
afterEach(() => { W.clearImageAttachments(); vi.restoreAllMocks(); });

const file = (name: string) => ({ name, mimeType: 'text/plain', contentType: 'text', content: name, size: name.length });

describe('parked attachments survive leaving a chat before it finished loading (280/284)', () => {
    it('parking with nothing pending keeps the unrestored selection', () => {
        W.restoreFileAttachment(file('a.txt'));
        W.parkPendingAttachments('B');           // leaving B: its selection is parked
        W.clearImageAttachments();
        W.parkPendingAttachments('B');           // leaving B again before it was restored (nothing pending)
        W.restoreParkedAttachments('B');
        expect(W.getPendingAttachments().files.map((f: any) => f.name)).toEqual(['a.txt']);
    });
    it('a file chosen meanwhile joins the parked one instead of replacing it', () => {
        W.restoreFileAttachment(file('old.txt'));
        W.parkPendingAttachments('B'); W.clearImageAttachments();
        W.restoreFileAttachment(file('new.txt'));
        W.parkPendingAttachments('B'); W.clearImageAttachments();
        W.restoreParkedAttachments('B');
        expect(W.getPendingAttachments().files.map((f: any) => f.name)).toEqual(['old.txt', 'new.txt']);
    });
});

describe('Send and New Chat while a chat loads (277/283/285)', () => {
    it('Send waits for the load, then goes out with the chat\'s context', async () => {
        const end = W.beginChatLoad('B');
        expect(W.isChatLoading()).toBe(true);
        W.activeChatId = 'B';
        let ran = false;
        const origStream = W.agentStreaming;
        const p = W.agentSend().then(() => { ran = true; });
        await new Promise(r => setTimeout(r, 20));
        expect(ran).toBe(false);                     // still waiting
        end();
        await p;
        expect(W.isChatLoading()).toBe(false);
        void origStream;
    });
    it('a Send is dropped when the reader moved to another chat while it waited', async () => {
        const end = W.beginChatLoad('B');
        W.activeChatId = 'B';
        const input = document.getElementById('agent-input')!;
        input.textContent = 'hello';
        const p = W.agentSend();
        W.activeChatId = 'C';
        end();
        await p;
        expect(input.textContent).toBe('hello');     // nothing was taken from the composer
    });
    it('overlapping loads: ready only when the last has finished, saves are held for the newest', async () => {
        const e1 = W.beginChatLoad('A'), e2 = W.beginChatLoad('B');
        let ready = false; W.whenChatReady().then(() => { ready = true; });
        e1(); await Promise.resolve();
        expect(ready).toBe(false); expect(W.isChatLoading()).toBe(true);
        e2(); await Promise.resolve();
        expect(ready).toBe(true); expect(W.isChatLoading()).toBe(false);
        e2();   // ending twice is harmless
        expect(W.isChatLoading()).toBe(false);
    });
});

describe('switching chats restores the draft at the start', () => {
    it('chat-state restores the destination draft before the load starts and not again after it', async () => {
        const src = (await import('fs')).readFileSync(`${process.cwd()}/chat-state.ts`, 'utf8');
        const body = src.slice(src.indexOf('async function switchToChat'), src.indexOf('async function deleteChat'));
        const first = body.indexOf('_restoreDraft?.(id)');
        expect(first).toBeGreaterThan(-1);
        expect(first).toBeLessThan(body.indexOf('loadChatHistory(id)'));
        expect(body.indexOf('_restoreDraft?.(id)', first + 1)).toBe(-1);
    });
});

describe('automatic title versus manual rename (288/297)', () => {
    it('a generated title never replaces a name the user set meanwhile', async () => {
        localStorage.setItem('fg_chat_list', JSON.stringify([{ id: 'c1', name: 'New Chat', createdAt: 1, lastAt: 1 }]));
        let release!: (t: string) => void;
        W.callLLMComplete = vi.fn(() => new Promise<string>(r => { release = r; }));
        W.isUtilityDisabled = () => false;
        const done = W.autoNameChat('c1', 'plan the quarterly budget review');
        await vi.waitFor(() => expect(W.callLLMComplete).toHaveBeenCalled());
        W.setChatName('c1', 'My own name');
        release('Budget Review');
        await done;
        expect(JSON.parse(localStorage.getItem('fg_chat_list')!)[0].name).toBe('My own name');
    });
    it('still replaces the draft name when nobody renamed the chat', async () => {
        localStorage.setItem('fg_chat_list', JSON.stringify([{ id: 'c2', name: 'New Chat', createdAt: 1, lastAt: 1 }]));
        W.callLLMComplete = vi.fn(async () => 'Budget Review');
        W.isUtilityDisabled = () => false;
        await W.autoNameChat('c2', 'plan the quarterly budget review');
        expect(JSON.parse(localStorage.getItem('fg_chat_list')!)[0].name).toBe('Budget Review');
    });
});

describe('reconstructed chats draw image-plus-text user turns (307/308)', () => {
    it('renders the caption and the thumbnail of an array-form user message', async () => {
        const { setChatHistory } = await import('../chat-history.ts');
        document.body.innerHTML = '<div id="agent-messages"></div>';
        W.addVoiceButtons ??= () => {};
        const png = 'data:image/png;base64,iVBORw0KGgo=';
        setChatHistory([
            { role: 'user', content: [{ type: 'image_url', image_url: { url: png } }, { type: 'text', text: '[Attached image: a.png, 8 B; original available at attachments/a.png]\n\nDescribe this picture.' }] },
            { role: 'assistant', content: 'A small image.' },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'javascript:alert(1)' } }, { type: 'text', text: 'second' }] },
        ]);
        W.renderHistoryFallback();
        const users = document.querySelectorAll('#agent-messages .msg-user, #agent-messages [class*="user"]');
        const html = document.getElementById('agent-messages')!.innerHTML;
        expect(users.length).toBeGreaterThan(0);
        expect(html).toContain('Describe this picture.');
        expect(html).toContain(`src="${png}"`);
        expect(html).not.toContain('Attached image:');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('second');
    });
});

describe('message search lifecycle (codex 269-272, 275) — source-level, the code lives in init()', () => {
    const src = () => require('fs').readFileSync(`${process.cwd()}/init.ts`, 'utf8') as string;
    it('open and close invalidate an in-flight search; a repeat open keeps the original opener; a prevented key is not reused', () => {
        const s = src();
        const open = s.slice(s.indexOf('function openMsgSearch'), s.indexOf('function closeMsgSearch'));
        const close = s.slice(s.indexOf('function closeMsgSearch'), s.indexOf('async function runMsgSearch'));
        expect(open).toContain("revokeLeases('msg-search')");
        expect(close).toContain("revokeLeases('msg-search')");
        expect(open.indexOf("modal.style.display === 'flex'")).toBeLessThan(open.indexOf('_msgSearchOpener ='));
        expect(s).toMatch(/e\.key\.toLowerCase\(\) === 'f' && !e\.defaultPrevented/);
    });
});
