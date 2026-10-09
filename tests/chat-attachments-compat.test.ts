import '../chat-attachments.ts';
import * as postTurn from '../post-turn.ts';
import { setMainAgentRole as setRoleObject } from '../state.ts';
import { setChatHistory } from '../chat-history.ts';
import { buildRequestMessages } from '../payload-builder.ts';
const W: any = window;
beforeAll(async()=>{W.matchMedia ??= ()=>({matches:false,addEventListener(){},removeEventListener(){}});await import('../settings-ui.ts');await import('../agent-core.ts');});

beforeEach(() => {
    document.body.innerHTML = '<div id="img-strip"></div><div id="agent-input" contenteditable></div><div id="agent-messages"></div>';
    W.clearImageAttachments(); W.setAgentStreaming(false); W.setAiJob('');
    W._resetModelWarmup = () => {}; W.clearSuggestion = () => {};
});
afterEach(() => { W.clearImageAttachments(); vi.restoreAllMocks(); localStorage.clear(); });

describe('attachment delivery', () => {
    it('reads text with FileReader when File.text is unavailable', async () => {
        const file = new File(['hello from iPad'], 'notes.txt', {type:'text/plain'});
        Object.defineProperty(file,'text',{value:undefined});
        await W.addFileAttachment(file);
        expect(W.getPendingAttachments().files[0].content).toBe('hello from iPad');
    });
    it('bounds large text reads without rejecting existing large text attachments',async()=>{
        const file=new File(['a'.repeat(250_000)],'large.txt',{type:'text/plain'});
        const slice=vi.spyOn(file,'slice');
        await W.addFileAttachment(file);
        expect(slice).toHaveBeenCalledWith(0,200_000,'text/plain');
        expect(W.getPendingAttachments().files[0].content).toContain('[truncated');
        expect(W.getPendingAttachments().files[0].content.length).toBeLessThan(51_000);
    });
    it('infers images whose picker reports no MIME type or generic MIME', async () => {
        for (const type of ['', 'application/octet-stream']) await W.addFileAttachment(new File(['image'], 'photo.JPG',{type}));
        expect(W.getPendingAttachments().images).toHaveLength(2);
        expect(W.getPendingAttachments().images[0].mimeType).toBe('image/jpeg');
    });
    it('waits for document extraction and persists the original in the workspace', async () => {
        let complete: (s:string)=>void;
        const extract = vi.spyOn(W,'extractDocumentText').mockImplementation(() => new Promise(resolve=>{complete=resolve;}));
        const write = vi.spyOn(W,'agentWriteFile').mockResolvedValue(undefined);
        const pending = W.addFileAttachment(new File(['pdf bytes'],'report.pdf',{type:'application/pdf'}));
        await vi.waitFor(()=>expect(extract).toHaveBeenCalled());
        expect(W.getPendingAttachments().files).toHaveLength(0);
        let waited=false; const wait=W.waitForAttachments().then(()=>{waited=true;});
        await Promise.resolve(); expect(waited).toBe(false);
        complete!('Quarterly revenue: 42'); await pending; await wait;
        const file=W.getPendingAttachments().files[0];
        expect(file.contentType).toBe('text'); expect(file.content).toContain('revenue: 42');
        expect(file.workspacePath).toMatch(/^attachments\//);
        expect(write).toHaveBeenCalledWith(file.workspacePath,expect.any(String),'base64');
    });
    it('recognizes document MIME types even when the picker omits the extension',async()=>{
        const reader=vi.spyOn(W,'extractDocumentText').mockResolvedValue('Document text');
        vi.spyOn(W,'agentWriteFile').mockResolvedValue(undefined);
        await W.addFileAttachment(new File(['pdf'],'Report',{type:'application/pdf'}));
        expect(reader).toHaveBeenCalledWith('Report.pdf',expect.any(String));
        expect(W.getPendingAttachments().files[0].content).toBe('Document text');
    });
    it('delivers SVG source as text instead of sending an unsupported image MIME to the model',async()=>{
        await W.addFileAttachment(new File(['<svg></svg>'],'drawing.svg',{type:'image/svg+xml'}));
        const snapshot=W.getPendingAttachments();expect(snapshot.images).toEqual([]);
        expect(snapshot.files[0].content).toBe('<svg></svg>');expect(snapshot.files[0].contentType).toBe('text');
    });
    it('does not resurrect an attachment after the composer was cleared', async () => {
        let complete:(s:string)=>void;
        vi.spyOn(W,'extractDocumentText').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
        const pending=W.addFileAttachment(new File(['pdf'],'old.pdf'));
        await vi.waitFor(()=>expect(complete!).toBeTypeOf('function'));
        W.clearImageAttachments();complete!('old text');await pending;
        expect(W.getPendingAttachments().files).toEqual([]);
        expect(document.querySelectorAll('.file-chip')).toHaveLength(0);
    });
    it('shows extraction failures and does not add a misleading filename-only attachment', async () => {
        vi.spyOn(W,'extractDocumentText').mockRejectedValue(new Error('Reader unavailable'));
        await expect(W.addFileAttachment(new File(['pdf'],'report.pdf'))).rejects.toThrow('Reader unavailable');
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Reader unavailable');
        expect(W.getPendingAttachments().files).toEqual([]);
    });
    it('sends the extracted document text in the real user history and resolves the role object',async()=>{
        vi.spyOn(W,'extractDocumentText').mockResolvedValue('The confidential answer is forty two.');
        vi.spyOn(W,'agentWriteFile').mockResolvedValue(undefined);
        vi.spyOn(W,'isTaskCompletionRequest').mockResolvedValue(false);
        vi.spyOn(W,'collectWorkspacePaths').mockResolvedValue([]);
        vi.spyOn(W,'applyTurnTriggers').mockImplementation(()=>{});
        vi.spyOn(W,'buildTurnPrelude').mockResolvedValue('');
        vi.spyOn(postTurn,'repairLedgerIfBroken').mockResolvedValue(undefined);
        vi.spyOn(postTurn,'runPostTurnAgents').mockResolvedValue(undefined);
        W.addVoiceButtons=()=>{};W.saveHistory=()=>{};W.updateChatMetaLastAt=()=>{};
        W._updateLogBadge=()=>{};W.generateAndShowSuggestion=()=>{};
        setRoleObject(null);setChatHistory([]);
        localStorage.setItem('fg_main_models',JSON.stringify(['kilo|dots-studio/dots-3-note-preview:free']));
        let captured:any;
        W.runTurn=vi.fn(async()=>{captured={messages:buildRequestMessages(W.getChatHistory(),'kilo'),role:W.mainAgentRole};return 'Summary delivered.';});
        await W.addFileAttachment(new File(['pdf'],'report.pdf',{type:'application/pdf'}));
        document.getElementById('agent-input')!.innerHTML='Summarize this document';
        await W.agentSend();
        expect(W.runTurn).toHaveBeenCalledOnce();
        expect(captured.messages.find((m:any)=>m.role==='user').content).toContain('The confidential answer is forty two.');
        expect(captured.role.name).toBe('director');expect(captured.role.tools).toBeInstanceOf(Set);
    });
    it('treats filenames as text rather than HTML', async () => {
        await W.addFileAttachment(new File(['ok'],'<img src=x onerror=x>.txt',{type:'text/plain'}));
        expect(document.querySelector('.file-chip img')).toBeNull();
        expect(document.querySelector('.file-chip-name')?.textContent).toContain('<img');
    });
    it('preserves the full draft instead of queuing text without its attachment while busy',async()=>{
        await W.addFileAttachment(new File(['attached content'],'notes.txt',{type:'text/plain'}));
        const input=document.getElementById('agent-input')!;input.innerHTML='Read this file';
        W.setAgentStreaming(true);
        await W.agentSend();
        expect(input.innerHTML).toBe('Read this file');
        expect(W.getPendingAttachments().files[0].content).toBe('attached content');
        expect(W.msgQueue.size()).toBe(0);
        expect(document.querySelector('[data-attachment-send-status]')?.textContent).toContain('draft and files are kept');
        W.setAgentStreaming(false);
    });
    it('reserves the AI job and delays sends until all attachment reads settle', async () => {
        let complete:()=>void;
        vi.spyOn(W,'waitForAttachments').mockImplementation(()=>new Promise<void>(resolve=>{complete=resolve;}));
        localStorage.setItem('fg_main_models',JSON.stringify(['nvidia|nvidia/nemotron-3-ultra-550b-a55b']));
        const show=vi.spyOn(W,'showSettings').mockImplementation(()=>{});
        const send=W.agentSend();
        expect(W.aiBusy()).toBe(true);expect(W.aiJob).toBe('send-preparing');
        await W.agentSend();expect(show).not.toHaveBeenCalled();
        complete!();await send;
        expect(show).toHaveBeenCalledTimes(1); expect(W.aiJob).toBe('');
    });
});

describe('document readers', () => {
    it('waits for an asynchronously loaded reader before extracting', async () => {
        const saved=W.mammoth;delete W.mammoth;
        const script=document.createElement('script');script.src='https://cdn.test/mammoth@1/browser.js';document.body.appendChild(script);
        try {
            const result=W.extractDocumentText('report.docx',btoa('fake office bytes'));
            W.mammoth={extractRawText:vi.fn(async()=>({value:'Visible document content'}))};
            script.dispatchEvent(new Event('load'));
            expect(await result).toBe('Visible document content');
        } finally { if(saved===undefined)delete W.mammoth;else W.mammoth=saved; }
    });
    it('releases PDF pages and the document after extracting text', async () => {
        const saved=W.pdfjsLib;
        const cleanup=vi.fn(),destroy=vi.fn();
        W.pdfjsLib={GlobalWorkerOptions:{},getDocument:vi.fn(()=>({promise:Promise.resolve({numPages:2,getPage:async()=>({getTextContent:async()=>({items:[{str:'Page text'}]}),cleanup}),destroy})}))};
        try {expect(await W.extractDocumentText('a.pdf',btoa('pdf'))).toBe('Page text\n\nPage text');expect(cleanup).toHaveBeenCalledTimes(2);expect(destroy).toHaveBeenCalledOnce();expect(W.pdfjsLib.getDocument.mock.calls[0][0].isEvalSupported).toBe(false);}
        finally {if(saved===undefined)delete W.pdfjsLib;else W.pdfjsLib=saved;}
    });
});
