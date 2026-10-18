// office-text.ts — FreeGent: text of PowerPoint (.pptx) and OpenDocument (.odt / .odp) files.
// Pure (no DOM): a minimal ZIP reader over the central directory plus regex text extraction, shared by
// the file-tab preview and the chat attachment reader.

import { inflateRaw } from './inflate.js';

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Entries of a ZIP archive by name; each value inflates on demand. Throws on a non-ZIP input. */
export function readZip(bytes: Uint8Array): Map<string, () => Uint8Array> {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
        if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a ZIP-based document');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const out = new Map<string, () => Uint8Array>();
    for (let n = 0; n < count && u32(bytes, p) === 0x02014b50; n++) {
        const method = u16(bytes, p + 10), csize = u32(bytes, p + 20);
        const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
        const local = u32(bytes, p + 42);
        const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
        out.set(name, () => {
            const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
            const data = bytes.subarray(start, start + csize);
            if (method === 0) return data;
            if (method === 8) return inflateRaw(data);
            throw new Error(`Unsupported ZIP compression (${method}) for ${name}`);
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/** The package's declared order of slides: presentation.xml lists slide ids, its .rels map each id to a part. */
function slideOrder(zip: Map<string, () => Uint8Array>): string[] | null {
    const pres = zip.get('ppt/presentation.xml'), rels = zip.get('ppt/_rels/presentation.xml.rels');
    if (!pres || !rels) return null;
    const target = new Map<string, string>();
    for (const m of utf8(rels()).matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]*)"/.exec(m[0])?.[1], t = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
        if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : 'ppt/' + t.replace(/^\.\//, ''));
    }
    const ids = [...utf8(pres()).matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)].map(m => target.get(m[1]));
    const parts = ids.filter((t): t is string => !!t && zip.has(t));
    return parts.length ? parts : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
        if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch { return ''; }
    });
}
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** Text of each slide of a .pptx, one string per slide (paragraphs separated by newlines), in the order the
 *  presentation shows them (which is not the numbering of the slide files once slides were moved). */
export function pptxSlides(bytes: Uint8Array): string[] {
    const zip = readZip(bytes);
    const slides = slideOrder(zip) ?? [...zip.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));
    return slides.map(k => {
        const xml = utf8(zip.get(k)!());
        const paras = xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) || [];
        // A soft line break (<a:br/>, Shift+Enter) ends a line inside the paragraph.
        return paras.map(p => decodeXml([...p.replace(/<a:br\b[^>]*?(?:\/>|>[\s\S]*?<\/a:br>)/g, '<a:t>\n</a:t>').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => m[1]).join('')))
            .filter(t => t.trim()).join('\n');
    });
}

/** Text of a .docx read from word/document.xml: paragraphs separated by a blank line, soft line breaks (<w:br/>) kept
 *  as newlines and tabs as tabs. mammoth's extractRawText drops line breaks ("Line one" + "Line two" ran together). */
export function docxText(bytes: Uint8Array): string {
    const entry = readZip(bytes).get('word/document.xml');
    if (!entry) throw new Error('No word/document.xml in this Word file');
    const xml = utf8(entry());
    const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    return paras.map(p => {
        let out = '';
        for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b([^>]*)\/?>|<w:cr\s*\/?>|<w:tab\s*\/>/g)) {
            if (m[1] !== undefined) out += decodeXml(m[1]);
            else if (m[0].startsWith('<w:br')) { if (!/w:type="page"/.test(m[2] ?? '')) out += '\n'; }
            else if (m[0].startsWith('<w:cr')) out += '\n';
            else out += '\t';
        }
        return out;
    }).filter(t => t.trim()).join('\n\n');
}

/** Text of an OpenDocument file (.odt / .odp): headings, paragraphs and list items, one per line. */
export function odfText(bytes: Uint8Array): string {
    const entry = readZip(bytes).get('content.xml');
    if (!entry) throw new Error('No content.xml in this OpenDocument file');
    const xml = utf8(entry());
    return xml.replace(/<text:(?:tab)\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
        .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, c) => ' '.repeat(+c || 1))
        .replace(/<\/text:(?:p|h)>/g, '\n').replace(/<[^>]+>/g, '')
        .split('\n').map(decodeXml).map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A workbook whose XML writes characters above U+FFFF as numeric references (&#128578;, what openpyxl does) with those
 *  references written out as the characters themselves. SheetJS 0.18 turns &#128578; into U+F642, the low 16 bits.
 *  Returns the same bytes when there is nothing to change or the file cannot be rewritten. */
export async function fixXlsxCharRefs(bytes: Uint8Array): Promise<Uint8Array> {
    try {
        const zip = readZip(bytes);
        const astral = /&#(?:x([0-9a-fA-F]{5,6})|(\d{5,7}));/g;
        const changed: { name: string; data: Uint8Array }[] = [];
        const all: { name: string; data: Uint8Array }[] = [];
        for (const [name, get] of zip) {
            const data = get();
            if (/^xl\/(?:sharedStrings|worksheets\/[^/]+)\.xml$/.test(name) && !/\/$/.test(name)) {
                const xml = utf8(data);
                if (astral.test(xml)) {
                    astral.lastIndex = 0;
                    const fixed = xml.replace(astral, (m, hex, dec) => {
                        const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
                        return cp > 0xffff && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
                    });
                    const out = { name, data: new TextEncoder().encode(fixed) };
                    changed.push(out); all.push(out); continue;
                }
                astral.lastIndex = 0;
            }
            all.push({ name, data });
        }
        if (!changed.length) return bytes;
        const { zipFiles } = await import('./workspace-zip.js');
        return await zipFiles(all);
    } catch { return bytes; }
}
