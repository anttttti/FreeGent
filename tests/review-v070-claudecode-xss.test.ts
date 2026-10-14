// Review of 2026-10-14: the spreadsheet preview must not parse cell values as HTML, and the
// passphrase header goes only to the Worker's own origin.
import { describe, it, expect } from 'vitest';
import { buildSheetTable, SHEET_PREVIEW_MAX_ROWS } from '../sheet-table.js';
import { isDefaultWorkerUrl } from '../proxy.js';

describe('buildSheetTable', () => {
    it('keeps a markup-looking cell as text', () => {
        const t = buildSheetTable(document, [['"><img src=x onerror=alert(1)>', 'b'], [1, null]]);
        expect(t.querySelector('img')).toBeNull();
        expect(t.querySelectorAll('td')[0].textContent).toBe('"><img src=x onerror=alert(1)>');
        expect(t.querySelectorAll('tr')).toHaveLength(2);
        expect(t.querySelectorAll('td')[3].textContent).toBe('');
    });
    it('caps the rows and says so', () => {
        const rows = Array.from({ length: SHEET_PREVIEW_MAX_ROWS + 3 }, (_, i) => [i]);
        const t = buildSheetTable(document, rows);
        expect(t.querySelectorAll('tr')).toHaveLength(SHEET_PREVIEW_MAX_ROWS + 1);
        expect(t.lastElementChild!.textContent).toContain('3 more rows');
    });
});

describe('isDefaultWorkerUrl', () => {
    it('matches the worker origin only', () => {
        expect(isDefaultWorkerUrl('https://proxy.freegent.ai/?url=x')).toBe(true);
        expect(isDefaultWorkerUrl('https://proxy.freegent.ai')).toBe(true);
        expect(isDefaultWorkerUrl('https://proxy.freegent.ai.evil.example/')).toBe(false);
        expect(isDefaultWorkerUrl('https://evil.example/https://proxy.freegent.ai')).toBe(false);
        expect(isDefaultWorkerUrl('/api/proxy')).toBe(false);
        expect(isDefaultWorkerUrl('')).toBe(false);
    });
});
