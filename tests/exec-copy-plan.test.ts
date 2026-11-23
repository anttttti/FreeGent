// planWorkspaceCopy (exec-limits.ts): which workspace files one JavaScript run gets.
import { planWorkspaceCopy } from '../exec-limits.ts';

const rec = (name: string, len: number, encoding: string | null = 'base64') => ({ name, content: 'x'.repeat(len), encoding });

describe('planWorkspaceCopy', () => {
    it('sends a workspace within the limit whole', () => {
        const r = planWorkspaceCopy([rec('a.png', 100), rec('b.md', 10, null)], 'console.log(1)', 1000, 1000);
        expect(r.send.map(x => x.name).sort()).toEqual(['a.png', 'b.md']);
        expect(r.omitted.size).toBe(0);
    });
    it('leaves out what does not fit, smallest files first in, with their decoded sizes', () => {
        const r = planWorkspaceCopy([rec('big1.png', 600), rec('small.png', 100), rec('big2.png', 500), rec('note.md', 40, null)], 'run()', 1000, 700);
        expect(r.send.map(x => x.name)).toEqual(['note.md', 'small.png', 'big2.png']);
        expect([...r.omitted.entries()]).toEqual([['big1.png', 450]]);
    });
    it('always sends a file the code names, by path or by file name, even past the limit', () => {
        const recs = [rec('attachments/1795-ab/IMG_2249.jpeg', 900), rec('assets/other.png', 50), rec('assets/third.png', 60)];
        const r = planWorkspaceCopy(recs, 'fs.readFileSync("attachments/1795-ab/IMG_2249.jpeg")', 1000, 950);
        expect(r.send.map(x => x.name)).toEqual(['attachments/1795-ab/IMG_2249.jpeg', 'assets/other.png']);   // the named one is over nothing; the others take what is left
        expect([...r.omitted.keys()]).toEqual(['assets/third.png']);
        const named = planWorkspaceCopy(recs, 'fs.readFileSync("attachments/1795-ab/IMG_2249.jpeg")', 1000, 100);
        expect(named.send.map(x => x.name)).toEqual(['attachments/1795-ab/IMG_2249.jpeg']);   // past the limit all the same
        const byName = planWorkspaceCopy(recs, 'const f = "IMG_2249.jpeg"', 1000, 100);
        expect(byName.send[0].name).toBe('attachments/1795-ab/IMG_2249.jpeg');
    });
    it('never sends a file over the single-file limit, named or not', () => {
        const r = planWorkspaceCopy([rec('huge.bin', 2000)], 'huge.bin', 1000, 10_000);
        expect(r.send).toEqual([]);
        expect(r.omitted.get('huge.bin')).toBe(1500);
        expect([...r.large]).toEqual(['huge.bin']);
        expect(planWorkspaceCopy([rec('late.png', 800)], '', 1000, 100).large.size).toBe(0);   // left out for the total, not the size: naming it helps
    });
    it('a file name shared by several files is a priority, not a way past the budget (explorations W002)', () => {
        const recs = [0, 1, 2, 3, 4].map(i => rec(`pictures/${i}/shared.bin`, 800, null));
        const r = planWorkspaceCopy(recs, 'fs.readFileSync("pictures/0/shared.bin")', 1000, 1700);
        expect(r.send.map(x => x.name)).toEqual(['pictures/0/shared.bin', 'pictures/1/shared.bin']);   // the one named by path, then what the budget allows of the same-name rest
        const alone = planWorkspaceCopy([rec('a/only.bin', 900, null), rec('b/small.bin', 100, null)], 'const f = "only.bin"', 1000, 150);
        expect(alone.send.map(x => x.name)).toContain('a/only.bin');   // a name that is one file's alone still reaches it
    });
    it('reports a left-out file by its bytes, as a sent one is sized (explorations W003)', () => {
        const r = planWorkspaceCopy([rec('a.txt', 0, null), { name: 'u.txt', content: 'é€😀', encoding: null }, { name: 'b.bin', content: 'YQ==', encoding: 'base64' }, { name: 'c.bin', content: 'YWJj', encoding: 'base64' }], '', 1000, 0);
        expect([...r.omitted]).toEqual([['u.txt', 9], ['b.bin', 1], ['c.bin', 3]]);   // 2 + 3 + 4 UTF-8 bytes; one byte of padded base64; three bytes
    });
});
