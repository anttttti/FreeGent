import { describe, it, expect } from 'vitest';
import { globToRegex } from '../shiro/utils/glob-regex.js';
import { parseSize, toLines } from '../shiro/commands/flags.js';
import { fmtG, fmtExp } from '../shiro/utils/format.js';
import { fsError } from '../shiro/utils/errors.js';
import { strftime } from '../shiro/commands/date.js';

describe('globToRegex (find, du, tar, zip)', () => {
    it('matches whole names with * ? and bracket classes', () => {
        expect(globToRegex('*.ts').test('a.ts')).toBe(true);
        expect(globToRegex('*.ts').test('a.tsx')).toBe(false);
        expect(globToRegex('file?.txt').test('file1.txt')).toBe(true);
        expect(globToRegex('[ab]*').test('banana')).toBe(true);
        expect(globToRegex('[!ab]*').test('banana')).toBe(false);
        expect(globToRegex('a.b').test('axb')).toBe(false);          // . is literal
        expect(globToRegex('a\\*b').test('a*b')).toBe(true);         // backslash escapes
        expect(globToRegex('a\\*b').test('aXb')).toBe(false);
    });
    it('icase (find -iname) and slashSpecial (zip)', () => {
        expect(globToRegex('*.TXT', { icase: true }).test('a.txt')).toBe(true);
        expect(globToRegex('*.txt').test('d/a.txt')).toBe(true);     // * crosses / by default (tar/du --exclude)
        expect(globToRegex('*.txt', { slashSpecial: true }).test('d/a.txt')).toBe(false);
    });
    it('treats an unterminated [ literally', () => {
        expect(globToRegex('a[b').test('a[b')).toBe(true);
    });
});

describe('parseSize (dd, split)', () => {
    it('parses GNU suffixes and rejects garbage', () => {
        expect(parseSize('10')).toBe(10);
        expect(parseSize('2b')).toBe(1024);
        expect(parseSize('1k')).toBe(1024);
        expect(parseSize('1K')).toBe(1024);
        expect(parseSize('1M')).toBe(1024 ** 2);
        expect(parseSize('1kB')).toBe(1000);
        expect(parseSize('1G')).toBe(1024 ** 3);
        expect(parseSize('x')).toBeNull();
        expect(parseSize('5q')).toBeNull();
    });
});

describe('toLines (grep, patch, flags)', () => {
    it('drops the empty element after a final newline and reports it', () => {
        expect(toLines('')).toEqual({ lines: [], lastNl: true });
        expect(toLines('a\nb\n')).toEqual({ lines: ['a', 'b'], lastNl: true });
        expect(toLines('a\nb')).toEqual({ lines: ['a', 'b'], lastNl: false });
    });
});

describe('fmtG / fmtExp (awk, od)', () => {
    it('matches C %g', () => {
        expect(fmtG(0.5, 6)).toBe('0.5');
        expect(fmtG(100000, 6)).toBe('100000');
        expect(fmtG(1000000, 6)).toBe('1e+06');
        expect(fmtG(0.0001, 6)).toBe('0.0001');
        expect(fmtG(0.00001, 6)).toBe('1e-05');
        expect(fmtG(1234567, 6)).toBe('1.23457e+06');
        expect(fmtG(1.5, 6, true)).toBe('1.50000');
        expect(fmtG(1e10, 6, false, true)).toBe('1E+10');
        expect(fmtG(0, 6)).toBe('0');
        expect(fmtG(-0, 6)).toBe('-0');
        expect(fmtG(NaN, 6)).toBe('nan');
        expect(fmtG(-Infinity, 6)).toBe('-inf');
        expect(fmtExp(12345, 2)).toBe('1.23e+04');
    });
});

describe('fsError', () => {
    it('carries code, errno, syscall and path', () => {
        const e: any = fsError('ENOENT', 'no such file', 'open', '/x');
        expect(e).toMatchObject({ code: 'ENOENT', errno: -2, syscall: 'open', path: '/x', message: 'no such file' });
        expect((fsError('EACCES', 'm') as any).errno).toBe(-13);
        expect((fsError('EWHATEVER', 'm') as any).errno).toBe(-1);
    });
});

describe('strftime (date, pr)', () => {
    it('formats local time for the codes pr uses', () => {
        const d = new Date(2026, 9, 7, 8, 5, 3);
        expect(strftime('%Y-%m-%d %H:%M', d, false)).toBe('2026-10-07 08:05');
        expect(strftime('%b %e %H:%M %%', d, false)).toBe('Oct  7 08:05 %');
        expect(strftime('%Q', d, false)).toBe('%Q');
    });
});
