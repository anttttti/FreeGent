// The message editor reads the files it adds into a list of its own (chat-attachments.ts readAttachmentsInto). Where a file goes is decided when its
// read starts: overlapping reads used to swap files (the first to finish reset the shared sink), and a composer read started meanwhile could land in the editor.
import { describe, it, expect } from 'vitest';
import './setup.js';
const W = globalThis as any;
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };
const file = (n: string) => new File([n], n, { type: 'text/plain' });
const sink = () => ({ images: [] as any[], files: [] as any[] });
const names = (s: { files: any[] }) => s.files.map(f => f.name);

describe('readAttachmentsInto', () => {
    it('keeps each call\'s files in its own list when two overlap, and the composer out of both', async () => {
        await import('../chat-attachments.ts');
        document.body.innerHTML = '<div id="agent-input"></div><div id="img-strip"></div>';
        const a = sink(), b = sink(), c = sink(), g = gate();
        const runA = W.readAttachmentsInto(a, () => W.addFileAttachment(file('a.txt')));                                  // finishes first
        const runB = W.readAttachmentsInto(b, async () => { await g.p; await W.addFileAttachment(file('b.txt')); });      // starts its read later, inside work
        const runC = W.readAttachmentsInto(c, () => W.addFileAttachment(file('c.txt')));                                   // a third, also overlapping
        await runA; g.open(); await Promise.all([runB, runC]);
        expect(names(a)).toEqual(['a.txt']);
        expect(names(c)).toEqual(['c.txt']);
        expect(names(b)).toEqual([]);   // b's work starts its read after an await, outside the call's synchronous part: a read like any other of the composer
    });
    it('a file chosen in the composer while the editor reads goes to the composer', async () => {
        await import('../chat-attachments.ts');
        document.body.innerHTML = '<div id="agent-input"></div><div id="img-strip"></div>';
        const edit = sink(), g = gate();
        const slow = W.readAttachmentsInto(edit, () => Promise.all([g.p.then(() => 0), W.addFileAttachment(file('edit.txt'))]));
        await W.addFileAttachment(file('composer.txt'));
        g.open(); await slow;
        expect(names(edit)).toEqual(['edit.txt']);
        expect(W.getPendingAttachments().files.map((f: any) => f.name)).toContain('composer.txt');
        expect(W.getPendingAttachments().files.map((f: any) => f.name)).not.toContain('edit.txt');
    });
});
