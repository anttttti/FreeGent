// sheet-table.ts — FreeGent: an HTML table for a worksheet, built from cell values with DOM calls.
//
// SheetJS's sheet_to_html does not escape cell values inside its data-v attribute (xlsx 0.18.5), so a
// cell containing `"><img src=x onerror=...>` became live markup once the string went into innerHTML.
// Here every cell is set with textContent: no cell value is ever parsed as HTML.

export const SHEET_PREVIEW_MAX_ROWS = 5000;

/** rows: the sheet as an array of rows (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })). */
export function buildSheetTable(doc: Document, rows: unknown[][]): HTMLTableElement {
    const table = doc.createElement('table');
    table.className = 'fg-xl-tbl';
    const shown = rows.slice(0, SHEET_PREVIEW_MAX_ROWS);
    const body = doc.createElement('tbody');
    for (const row of shown) {
        const tr = doc.createElement('tr');
        for (const cell of Array.isArray(row) ? row : []) {
            const td = doc.createElement('td');
            td.textContent = cell == null ? '' : String(cell);
            tr.appendChild(td);
        }
        body.appendChild(tr);
    }
    table.appendChild(body);
    if (rows.length > shown.length) {
        const tr = doc.createElement('tr');
        const td = doc.createElement('td');
        td.textContent = `… ${rows.length - shown.length} more rows not shown`;
        tr.appendChild(td);
        body.appendChild(tr);
    }
    return table;
}

export const SHEET_TABLE_CSS =
    '.fg-xl-tbl { border-collapse:collapse; font-size:12px; font-family:inherit; }' +
    '.fg-xl-tbl td { border:1px solid var(--border); padding:3px 8px; white-space:nowrap; }' +
    '.fg-xl-tbl tr:first-child td { background:var(--sidebar-bg); font-weight:600; }';
