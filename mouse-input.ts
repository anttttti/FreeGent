// mouse-input.ts — takes X10 mouse reports (ESC [ M b x y, six bytes) out of the terminal's byte stream, wherever the stream is cut.
//
// A report can arrive in two reads (a slow link, a busy terminal). The TUI's filter looked at one read at a time, so the first half was
// passed on as typing and the message box gained "[M ++" (TUI report case 064). Here an incomplete report is held until the rest comes;
// a held prefix that stays alone (a bare Escape key) is released by `flush()`, which the caller schedules after a short wait.

export const MOUSE_HOLD_MS = 40;         // a lone Escape: it is the Escape key unless something follows at once
export const MOUSE_PARTIAL_HOLD_MS = 400; // "ESC [" or more: no key sends that alone, so the rest of the report is on its way
const MOUSE_PREFIX = [0x1b, 0x5b, 0x4d];

export interface MouseSplitter {
    /** Bytes for the application from this read; reports are dispatched to the handlers. */
    write(chunk: Buffer): Buffer;
    /** Held bytes that never became a report; call after MOUSE_HOLD_MS without more input. Empty buffer when none. */
    flush(): Buffer;
    /** Something is held back. */
    pending(): boolean;
    /** How long to wait for more before releasing what is held (longer once it can only be part of a mouse report). */
    holdMs(): number;
}

export function createMouseSplitter(onClick: (row: number, col: number) => void, onScroll: (row: number, col: number, dir: 1 | -1) => void): MouseSplitter {
    let held: Buffer = Buffer.alloc(0);
    const isPrefix = (b: Buffer): boolean => b.length < 3 && b.every((x, i) => x === MOUSE_PREFIX[i]);
    return {
        write(chunk: Buffer): Buffer {
            const buf = held.length ? Buffer.concat([held, chunk]) : chunk;
            held = Buffer.alloc(0);
            const out: Buffer[] = [];
            let i = 0;
            while (i < buf.length) {
                const esc = buf.indexOf(0x1b, i);
                if (esc < 0) { out.push(buf.subarray(i)); break; }
                if (esc > i) out.push(buf.subarray(i, esc));
                const rest = buf.subarray(esc);
                if (rest.length >= 3 && rest[1] === 0x5b && rest[2] === 0x4d) {
                    if (rest.length < 6) { held = Buffer.from(rest); break; }   // the report is cut: wait for its end
                    const button = rest[3], col = rest[4] - 33, row = rest[5] - 33;   // 1-indexed → 0-indexed
                    if (button === 32) onClick(row, col);
                    else if (button === 96 || button === 97) onScroll(row, col, button === 96 ? 1 : -1);   // wheel: 96 up, 97 down
                    i = esc + 6;
                } else if (isPrefix(rest)) {
                    held = Buffer.from(rest); break;                            // "ESC" or "ESC [": might still become a report
                } else {
                    out.push(buf.subarray(esc, esc + 1)); i = esc + 1;          // some other escape sequence: not ours
                }
            }
            return out.length ? Buffer.concat(out) : Buffer.alloc(0);
        },
        flush(): Buffer { const b = held; held = Buffer.alloc(0); return b; },
        pending(): boolean { return held.length > 0; },
        holdMs(): number { return held.length >= 2 ? MOUSE_PARTIAL_HOLD_MS : MOUSE_HOLD_MS; },
    };
}
