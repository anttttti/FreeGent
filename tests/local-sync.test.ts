import { describe, it, expect } from 'vitest';
import { planSync, keepBothName, nextBase, changedSinceImport, hashContent } from '../local-sync';

const kinds = (items: any[]) => Object.fromEntries(items.map(i => [i.path, i.kind + ':' + i.action]));

describe('planSync', () => {
    it('first sync: files on one side are new, differing files conflict, nothing is removed', () => {
        const r = planSync({ a: '1', b: '2', c: '3' }, { b: '2', c: 'x', d: '4' });
        expect(kinds(r)).toEqual({ a: 'new-in-workspace:to-local', c: 'conflict:keep-both', d: 'new-in-local:to-workspace' });
    });
    it('uses the base to tell which side changed', () => {
        const base = { f: '1', g: '1' };
        const r = planSync({ f: '1', g: '2' }, { f: '2', g: '1' }, base);
        expect(kinds(r)).toEqual({ f: 'changed-in-local:to-workspace', g: 'changed-in-workspace:to-local' });
    });
    it('both changed since the base is a conflict', () => {
        expect(kinds(planSync({ f: '2' }, { f: '3' }, { f: '1' }))).toEqual({ f: 'conflict:keep-both' });
    });
    it('a removal is answered by restoring the file, never by deleting', () => {
        const r = planSync({ a: '1' }, { b: '1' }, { a: '1', b: '1' });
        expect(kinds(r)).toEqual({ a: 'removed-from-local:to-local', b: 'removed-from-workspace:to-workspace' });
        for (const i of r) expect(i.action).not.toMatch(/delete/);
        expect(r[0].choices).toContain('delete-workspace');
        expect(r[1].choices).toContain('delete-local');
    });
    it('identical sides produce no items', () => {
        expect(planSync({ a: '1' }, { a: '1' }, {})).toEqual([]);
    });
});

describe('keepBothName', () => {
    it('inserts (local) before the extension and avoids taken names', () => {
        expect(keepBothName('d/x.txt', () => false)).toBe('d/x (local).txt');
        expect(keepBothName('x', () => false)).toBe('x (local)');
        expect(keepBothName('.env', () => false)).toBe('.env (local)');
        const taken = new Set(['x (local).md']);
        expect(keepBothName('x.md', n => taken.has(n))).toBe('x (local 2).md');
    });
});

describe('nextBase / changedSinceImport / hashContent', () => {
    it('keeps the old base for unresolved paths and records agreed ones', () => {
        expect(nextBase({ a: '1', b: '2' }, { a: '1', b: '3' }, { b: '0', z: '9' })).toEqual({ a: '1', b: '0' });
    });
    it('lists local files that are new or edited since the import', () => {
        expect(changedSinceImport({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x' })).toEqual(['b', 'c']);
    });
    it('hashes differ for different text and match for equal text', () => {
        expect(hashContent('abc')).toBe(hashContent('abc'));
        expect(hashContent('abc')).not.toBe(hashContent('abd'));
    });
});

describe('merge planning', () => {
    it('a clean three-way merge becomes the default for a file changed on both sides', () => {
        const items = planSync({ 'a.txt': 'w' }, { 'a.txt': 'l' }, { 'a.txt': 'b' }, { 'a.txt': { conflicts: false } });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'conflict', action: 'merge' });
        expect(items[0].choices).toContain('keep-both');
    });
    it('a merge with overlapping edits is offered but keep-both stays the default', () => {
        const [it] = planSync({ 'a.txt': 'w' }, { 'a.txt': 'l' }, { 'a.txt': 'b' }, { 'a.txt': { conflicts: true } });
        expect(it.action).toBe('keep-both');
        expect(it.choices[1]).toBe('merge');
    });
    it('without a merge result a conflict is unchanged, and keepBothName takes a tag', () => {
        const [it] = planSync({ 'a.txt': 'w' }, { 'a.txt': 'l' }, { 'a.txt': 'b' });
        expect(it.choices).not.toContain('merge');
        expect(keepBothName('d/a.txt', () => false, 'imported')).toBe('d/a (imported).txt');
    });
});
