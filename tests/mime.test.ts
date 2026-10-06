import { describe, it, expect } from 'vitest';
import { extOf, mimeOfExt, mimeOfName, isBinaryExt, isDocExt, docKindOfExt, docKindOfMime, imageMimeOfName,
    UNREADABLE_BINARY_RE, DISPLAY_LIBS_RE } from '../mime.js';

describe('mime', () => {
    it('keeps every mapping the old workspace/chat-attachments/downloadFile tables had', () => {
        const old: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
            '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
            '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
            '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.wasm': 'application/wasm',
            '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.webm': 'video/webm', '.mov': 'video/quicktime',
            '.xls': 'application/vnd.ms-excel',
        };
        for (const [e, m] of Object.entries(old)) { expect(mimeOfExt(e)).toBe(m); expect(mimeOfExt(e.slice(1))).toBe(m); }
        expect(mimeOfName('Report.PPTX')).toContain('presentationml');
        expect(mimeOfName('x.unknown')).toBe('application/octet-stream');
    });
    it('classifies binary and document extensions like the old sets', () => {
        for (const n of ['a.pdf', 'a.docx', 'a.odp', 'a.png', 'a.wasm', 'a.bin', 'A.ZIP']) expect(isBinaryExt(n)).toBe(true);
        for (const n of ['a.txt', 'a.ts', 'a.svg', 'noext']) expect(isBinaryExt(n)).toBe(false);
        expect(isDocExt('a.xlsx')).toBe(true); expect(isDocExt('a.png')).toBe(false);
        expect(extOf('dir/file.Tar.GZ')).toBe('.gz');
    });
    it('maps documents to extraction kinds', () => {
        expect(docKindOfExt('pdf')).toBe('pdf'); expect(docKindOfExt('.docx')).toBe('docx'); expect(docKindOfExt('pptx')).toBeUndefined();
        expect(docKindOfMime('application/vnd.ms-excel')).toBe('xls'); expect(docKindOfMime('text/plain')).toBeUndefined();
    });
    it('imageMimeOfName only returns image types', () => {
        expect(imageMimeOfName('plot.PNG')).toBe('image/png'); expect(imageMimeOfName('a.pdf')).toBe(''); expect(imageMimeOfName('a')).toBe('');
    });
    it('exposes the read guard and display-library patterns', () => {
        expect(UNREADABLE_BINARY_RE.test('lib/x.so')).toBe(true); expect(UNREADABLE_BINARY_RE.test('x.ts')).toBe(false);
        expect(DISPLAY_LIBS_RE.test('import pygame\n')).toBe(true); expect(DISPLAY_LIBS_RE.test('import numpy')).toBe(false);
    });
});
