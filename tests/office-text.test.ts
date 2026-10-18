import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { zipFiles } from '../workspace-zip.js';
import { readZip, pptxSlides, odfText, docxText, fixXlsxCharRefs } from '../office-text.js';

// jsdom's Blob has no stream(); zipFiles needs the real one to deflate.
beforeAll(() => { vi.stubGlobal('Blob', NodeBlob); });
afterAll(() => { vi.unstubAllGlobals(); });

const enc = (s: string) => new TextEncoder().encode(s);
const slide = (...paras: string[]) => `<p:sld><p:txBody>${paras.map(p => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sld>`;

describe('office-text', () => {
    it('reads stored and deflated zip entries', async () => {
        const zip = await zipFiles([
            { name: 'a.txt', data: enc('hi') },
            { name: 'big.txt', data: enc('x'.repeat(5000)) },
        ]);
        const entries = readZip(zip);
        expect(new TextDecoder().decode(entries.get('a.txt')!())).toBe('hi');
        expect(entries.get('big.txt')!().length).toBe(5000);
    });
    it('rejects non-zip input', () => {
        expect(() => readZip(enc('plain text, not an archive at all'))).toThrow(/ZIP/);
    });
    it('extracts pptx slide text in slide order, with entities decoded', async () => {
        const zip = await zipFiles([
            { name: 'ppt/slides/slide10.xml', data: enc(slide('Last')) },
            { name: 'ppt/slides/slide2.xml', data: enc(slide('Second &amp; more', '')) },
            { name: 'ppt/slides/slide1.xml', data: enc(slide('Title', 'Body &lt;1&gt;')) },
            { name: 'ppt/slideLayouts/slideLayout1.xml', data: enc(slide('layout')) },
        ]);
        expect(pptxSlides(zip)).toEqual(['Title\nBody <1>', 'Second & more', 'Last']);
    });
    it('extracts odt text', async () => {
        const xml = '<office:text><text:h>Head</text:h><text:p>One<text:s text:c="2"/>two<text:tab/>t</text:p><text:p>A &amp; B</text:p></office:text>';
        const zip = await zipFiles([{ name: 'content.xml', data: enc(xml) }]);
        expect(odfText(zip)).toBe('Head\nOne  two\tt\nA & B');
    });

    it('follows the presentation\'s slide order, not the numbering of the slide files (codex campaign 7, case 008)', async () => {
        const zip = await zipFiles([
            { name: 'ppt/slides/slide1.xml', data: enc(slide('FIRST_FILE')) },
            { name: 'ppt/slides/slide2.xml', data: enc(slide('SECOND_FILE')) },
            { name: 'ppt/presentation.xml', data: enc('<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId8"/><p:sldId id="256" r:id="rId7"/></p:sldIdLst></p:presentation>') },
            { name: 'ppt/_rels/presentation.xml.rels', data: enc('<Relationships><Relationship Id="rId7" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId8" Type="x/slide" Target="slides/slide2.xml"/></Relationships>') },
        ]);
        expect(pptxSlides(zip)).toEqual(['SECOND_FILE', 'FIRST_FILE']);
    });
    it('falls back to file numbering when the presentation lists no usable slides', async () => {
        const zip = await zipFiles([
            { name: 'ppt/slides/slide2.xml', data: enc(slide('B')) }, { name: 'ppt/slides/slide1.xml', data: enc(slide('A')) },
            { name: 'ppt/presentation.xml', data: enc('<p:presentation/>') },
        ]);
        expect(pptxSlides(zip)).toEqual(['A', 'B']);
    });
    it('keeps a soft line break inside a slide paragraph (case 072)', async () => {
        const xml = '<p:sld><a:p><a:r><a:t>Morning briefing</a:t></a:r><a:br/><a:r><a:t>Afternoon review</a:t></a:r></a:p></p:sld>';
        const zip = await zipFiles([{ name: 'ppt/slides/slide1.xml', data: enc(xml) }]);
        expect(pptxSlides(zip)).toEqual(['Morning briefing\nAfternoon review']);
    });
    it('extracts docx text with soft breaks, tabs and paragraphs; a page break is not a line break (case 015)', async () => {
        const body = '<w:body><w:p><w:pPr/><w:r><w:t>Title</w:t></w:r></w:p>'
            + '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t xml:space="preserve">Line two</w:t></w:r></w:p>'
            + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B &amp; C</w:t><w:br w:type="page"/></w:r></w:p><w:p/></w:body>';
        const zip = await zipFiles([{ name: 'word/document.xml', data: enc(`<w:document>${body}</w:document>`) }]);
        expect(docxText(zip)).toBe('Title\n\nLine one\nLine two\n\nA\tB & C');
        expect(() => docxText(enc('not a zip, but long enough to look like an archive of some kind'))).toThrow();
    });
    it('writes astral numeric character references in a workbook as the characters (case 006)', async () => {
        const zip = await zipFiles([
            { name: 'xl/sharedStrings.xml', data: enc('<sst><si><t>caf&#233; &#128578; &#x1F642; &#9731;</t></si></sst>') },
            { name: 'xl/workbook.xml', data: enc('<workbook>&#128578;</workbook>') },
        ]);
        const fixed = readZip(await fixXlsxCharRefs(zip));
        expect(new TextDecoder().decode(fixed.get('xl/sharedStrings.xml')!())).toBe('<sst><si><t>caf&#233; 🙂 🙂 &#9731;</t></si></sst>');
        expect(new TextDecoder().decode(fixed.get('xl/workbook.xml')!())).toBe('<workbook>&#128578;</workbook>');
    });
    it('returns a workbook without such references, or one that is not a zip, unchanged', async () => {
        const zip = await zipFiles([{ name: 'xl/sharedStrings.xml', data: enc('<sst><si><t>plain</t></si></sst>') }]);
        expect(await fixXlsxCharRefs(zip)).toBe(zip);
        const junk = enc('not a zip file at all, really not an archive');
        expect(await fixXlsxCharRefs(junk)).toBe(junk);
    });
});
