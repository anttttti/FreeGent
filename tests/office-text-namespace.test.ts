// The same OOXML document can bind its namespaces to other prefixes; the extractors must read it the same way.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { zipFiles } from '../workspace-zip.js';
import { pptxSlides, docxText } from '../office-text.js';

// jsdom's Blob has no stream(); zipFiles needs the real one to deflate.
beforeAll(() => { vi.stubGlobal('Blob', NodeBlob); });
afterAll(() => { vi.unstubAllGlobals(); });

const enc = (s: string) => new TextEncoder().encode(s);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = (prefix: string) => zipFiles([{ name: 'word/document.xml', data: enc(
    `<${prefix}:document xmlns:${prefix}="${W}"><${prefix}:body><${prefix}:p><${prefix}:r><${prefix}:t>Line one</${prefix}:t><${prefix}:br/><${prefix}:t>Line two</${prefix}:t></${prefix}:r></${prefix}:p></${prefix}:body></${prefix}:document>`) }]);

describe('Word text', () => {
    it('keeps soft breaks whichever prefix the WordprocessingML namespace is bound to', async () => {
        expect(docxText(await docx('w'))).toBe('Line one\nLine two');
        expect(docxText(await docx('wp1'))).toBe('Line one\nLine two');
    });
});

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pptx = (p: string, r: string, a: string) => zipFiles([
    { name: 'ppt/presentation.xml', data: enc(`<${p}:presentation xmlns:${p}="${P}" xmlns:${r}="${R}"><${p}:sldIdLst><${p}:sldId id="256" ${r}:id="rId2"/><${p}:sldId id="257" ${r}:id="rId1"/></${p}:sldIdLst></${p}:presentation>`) },
    { name: 'ppt/_rels/presentation.xml.rels', data: enc('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>') },
    ...[1, 2].map(n => ({ name: `ppt/slides/slide${n}.xml`, data: enc(`<x xmlns:${a}="${A}"><${a}:p><${a}:r><${a}:t>Slide ${n}</${a}:t></${a}:r></${a}:p></x>`) })),
]);

describe('PowerPoint slide order', () => {
    it('follows the declared order whichever prefixes the namespaces use', async () => {
        expect(pptxSlides(await pptx('p', 'r', 'a'))).toEqual(['Slide 2', 'Slide 1']);
        expect(pptxSlides(await pptx('pres', 'rel', 'dml'))).toEqual(['Slide 2', 'Slide 1']);
    });
});
