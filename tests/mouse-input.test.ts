import { describe, it, expect } from 'vitest';
import { createMouseSplitter } from '../mouse-input.ts';

const click = (col: number, row: number) => Buffer.from([0x1b, 0x5b, 0x4d, 32, col + 33, row + 33]);
const wheel = (up: boolean, col: number, row: number) => Buffer.from([0x1b, 0x5b, 0x4d, up ? 96 : 97, col + 33, row + 33]);
function make() {
    const log: any[] = [];
    const m = createMouseSplitter((r, c) => log.push(['click', r, c]), (r, c, d) => log.push(['wheel', r, c, d]));
    return { m, log };
}

describe('mouse report splitter', () => {
    it('a whole report is consumed and typing around it is untouched', () => {
        const { m, log } = make();
        const out = m.write(Buffer.concat([Buffer.from('ab'), click(4, 2), Buffer.from('cd')]));
        expect(out.toString()).toBe('abcd');
        expect(log).toEqual([['click', 2, 4]]);
    });
    it('a report split across two reads never reaches the application (case 064)', () => {
        for (let cut = 1; cut < 6; cut++) {
            const { m, log } = make();
            const full = click(7, 3);
            const first = m.write(Buffer.concat([Buffer.from('draft'), full.subarray(0, cut)]));
            expect(first.toString(), `cut ${cut}`).toBe('draft');
            expect(m.pending()).toBe(true);
            const second = m.write(full.subarray(cut));
            expect(second.length).toBe(0);
            expect(log).toEqual([['click', 3, 7]]);
            expect(m.pending()).toBe(false);
        }
    });
    it('the wheel and several reports in one read', () => {
        const { m, log } = make();
        m.write(Buffer.concat([wheel(true, 1, 1), wheel(false, 2, 2), click(3, 3)]));
        expect(log).toEqual([['wheel', 1, 1, 1], ['wheel', 2, 2, -1], ['click', 3, 3]]);
    });
    it('a lone Escape is held, then released by flush; other escape sequences pass at once', () => {
        const { m } = make();
        expect(m.write(Buffer.from([0x1b])).length).toBe(0);
        expect(m.pending()).toBe(true);
        expect([...m.flush()]).toEqual([0x1b]);
        expect(m.pending()).toBe(false);
        const arrow = Buffer.from([0x1b, 0x5b, 0x41]);               // ESC [ A (up arrow)
        expect([...m.write(arrow)]).toEqual([...arrow]);
        const del = Buffer.from('\x1b[3~');
        expect(m.write(del).toString()).toBe('\x1b[3~');
        const alt = Buffer.from([0x1b, 0x70]);                       // Alt+P
        expect([...m.write(alt)]).toEqual([...alt]);
    });
    it('Escape followed by typing in the next read is delivered in order', () => {
        const { m } = make();
        expect(m.write(Buffer.from([0x1b])).length).toBe(0);
        expect([...m.write(Buffer.from('x'))]).toEqual([0x1b, 0x78]);
    });
});

describe('hold times', () => {
    it('a lone Escape is released quickly; a longer partial report is waited for', () => {
        const { m } = make();
        m.write(Buffer.from([0x1b]));
        expect(m.holdMs()).toBeLessThan(100);
        m.write(Buffer.from([0x5b]));            // "ESC [": nothing but a report or another escape sequence starts like this
        expect(m.holdMs()).toBeGreaterThan(200);
    });
});
