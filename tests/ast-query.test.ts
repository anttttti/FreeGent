import { describe, it, expect } from 'vitest';
import '../ast.ts';

const q = (content: string, lang: string, query: string) => (window as any)._astQueryContent(content, lang, query);
const fmt = (r: any[], query: string) => (window as any)._astFormatResults(r, query, 'f');

describe('ast_query', () => {
    it('finds JS functions, classes, imports with line numbers, sorted', () => {
        const src = "import a from 'x';\nfunction foo() {}\nclass Bar {}\nconst baz = (x) => x;\n";
        const r = q(src, 'javascript', 'symbols');
        expect(r.map((s: any) => [s.name, s.line])).toEqual(expect.arrayContaining([['foo', 2], ['Bar', 3]]));
        expect(r.map((s: any) => s.line)).toEqual([...r.map((s: any) => s.line)].sort((a, b) => a - b));
    });
    it('finds Python defs and classes', () => {
        const r = q("import os\ndef f():\n    pass\nclass C:\n    def m(self): pass\n", 'python', 'functions');
        expect(r.map((s: any) => s.name)).toEqual(expect.arrayContaining(['f', 'm']));
    });
    it('calls: lists the lines of a call, symbol_at picks the enclosing function', () => {
        const src = "function a() {\n  b();\n}\nfunction c() {\n  b();\n  b();\n}\n";
        expect(fmt(q(src, 'javascript', 'calls:b'), 'calls:b')).toContain('lines: 2, 5, 6');
        expect(q(src, 'javascript', 'symbol_at:5')[0].name).toBe('c');
    });
    it('empty input, unknown language and an empty result are answered, not thrown', () => {
        expect(q('', 'javascript', 'functions')).toEqual([]);
        expect(q('x', 'cobol', 'functions')).toEqual([]);
        expect(fmt([], 'functions')).toBe('No functions found in f.');
    });
});

describe('ast_query on Python (review of 3dcee09)', () => {
    const src = "class A:\n    def m(self):\n        return 1\n    X = 5\n\ndef f():\n    s = '''\n    def fake():\n        pass\n    '''\n    return s\n";
    it('symbol_at on a class-level assignment after a method is the class, not the method', () => {
        expect(q(src, 'python', 'symbol_at:4').map((r: any) => r.name)).toEqual(['A']);
        expect(q(src, 'python', 'symbol_at:3').map((r: any) => r.name)).toEqual(['m']);
    });
    it('a def inside a triple-quoted string is not a function', () => {
        expect(q(src, 'python', 'functions').map((r: any) => r.name)).toEqual(['m', 'f']);
    });
});
