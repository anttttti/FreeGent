// frontmatter.ts is the one reader/writer of `---` blocks (tasks, skills, rules, QA status).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { splitFrontmatter, parseFrontmatter, parseFmLines, setFmLines, buildFrontmatter, setFrontmatterFields } from '../frontmatter.ts';

describe('splitFrontmatter / parseFrontmatter', () => {
    it('splits fences from body and keeps the body byte for byte', () => {
        const s = splitFrontmatter('---\nid: 1\ntitle: T\n---\n# T\r\nbody\n')!;
        expect(s.lines).toEqual(['id: 1', 'title: T']);
        expect(s.body).toBe('# T\r\nbody\n');
        expect(s.closing).toBe('\n');
        expect(splitFrontmatter('no block')).toBeNull();
        expect(splitFrontmatter('---\nstatus: x\n---')!.closing).toBe('');
    });
    it('reads CRLF files and unquotes values', () => {
        expect(parseFrontmatter('---\r\ntitle: "A: b"\r\nstatus: open\r\n---\r\nx')).toEqual({ title: 'A: b', status: 'open' });
        expect(parseFrontmatter('plain text')).toEqual({});
        expect(parseFmLines(['no colon', 'k: v', ': nokey'])).toEqual({ k: 'v' });
    });
});

describe('writing', () => {
    it('setFmLines rewrites the first line of a key, drops its duplicates, keeps unknown lines', () => {
        expect(setFmLines(['status: a', '# note', 'x: 1', 'status: b'], { status: 'done' })).toEqual(['status: done', '# note', 'x: 1']);
    });
    it('adds a missing key at the end, or at the top', () => {
        expect(setFmLines(['x: 1'], { y: 2 })).toEqual(['x: 1', 'y: 2']);
        expect(setFmLines(['x: 1'], { y: 2 }, { missing: 'top' })).toEqual(['y: 2', 'x: 1']);
    });
    it('buildFrontmatter skips empty values and quotes where needed', () => {
        expect(buildFrontmatter({ name: 'plan', description: '', trigger: 'a: b' })).toBe('---\nname: plan\ntrigger: "a: b"\n---\n');
    });
    it('setFrontmatterFields edits a block, keeps the body and a missing final newline, and prepends a block when there is none', () => {
        expect(setFrontmatterFields('---\nstatus: open\n---\n# T\n', { status: 'done' })).toBe('---\nstatus: done\n---\n# T\n');
        expect(setFrontmatterFields('---\nstatus: open\n---', { status: 'done' })).toBe('---\nstatus: done\n---');
        expect(setFrontmatterFields('# T\n', { status: 'open' })).toBe('---\nstatus: open\n---\n\n# T\n');
    });
});

describe('round trip', () => {
    const rnd = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const alphabet = ['N','o','y','n','a', 'B', ' ', ' ', ':', '#', '"', "'", '\\', '-', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`', '?', 'é', '日', '0', '.'];
    const titles = (() => { const r = rnd(7), out: string[] = []; for (let i = 0; i < 400; i++) { let t = ''; for (let n = 1 + Math.floor(r() * 12); n--;) t += alphabet[Math.floor(r() * alphabet.length)]; t = t.trim().replace(/\s+/g, ' '); if (t) out.push(t); } return out; })();

    it('FreeGent reads back exactly what it wrote, for random awkward titles', () => {
        for (const t of titles) expect(parseFrontmatter(buildFrontmatter({ title: t })).title, JSON.stringify(t)).toBe(t);
    });

    const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
    (py.status === 0 ? it : it.skip)('a strict YAML parser reads the same value (PyYAML as oracle)', () => {
        const docs = titles.map(t => buildFrontmatter({ title: t }).replace(/^---\n|\n---\n$/g, ''));
        const r = spawnSync('python3', ['-I', '-c', 'import sys,json,yaml\nd=json.load(sys.stdin)\nprint(json.dumps([yaml.safe_load(x)["title"] if True else None for x in d]))'], { input: JSON.stringify(docs), encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const got = JSON.parse(r.stdout);
        // YAML types plain scalars like 1.5 / 0 as numbers; compare their text form.
        titles.forEach((t, i) => expect(String(got[i]), JSON.stringify(t)).toBe(t));
    });
});
