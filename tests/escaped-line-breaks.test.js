// A whole file written as one line of literal \n sequences. Autopilot exploration 2026-10-27 (AE-05): src/enemies.js became
// `// Enemies module\nexport function spawnEnemy…` (13 literal \n). JavaScript reads that as one comment, so the parse check
// passed, every export was gone, the page drew nothing and the task was marked done; write_file said only {success: true}.
import { escapedLineBreaks, unescapeOnce } from '../detectors.ts';
const W = globalThis;

let files, saved;
beforeEach(() => {
    files = new Map();
    W.mainAgentRole = null;
    saved = { r: W.agentReadFile, w: W.agentWriteFile, l: W.agentListFiles };
    W.agentReadFile = async p => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p, c) => { files.set(p, c); };
    W.agentListFiles = async () => [...files.keys()].map(name => ({ name }));
});
afterEach(() => { W.agentReadFile = saved.r; W.agentWriteFile = saved.w; W.agentListFiles = saved.l; });

const ENEMIES = '// Enemies module\\nexport function spawnEnemy(w) {\\n  return { x: Math.random() * w, y: -20, label: "a\\\\b" };\\n}\\nexport function hits(a, b) {\\n  return a.x === b.x;\\n}\\n';

describe('escapedLineBreaks', () => {
    it('counts literal \\n in a one-line source file, not escaped backslashes or real lines', () => {
        expect(escapedLineBreaks('src/enemies.js', ENEMIES)).toBe(7);
        expect(escapedLineBreaks('src/a.js', 'const a = 1;\nconst s = "x\\ny\\nz\\nw";\n')).toBe(0);   // a real file with escapes in a string
        expect(escapedLineBreaks('src/a.js', 'print("\\\\n\\\\n\\\\n")')).toBe(0);                    // \\n is an escaped backslash
        expect(escapedLineBreaks('img.png', 'a\\nb\\nc\\nd')).toBe(0);
        expect(unescapeOnce('a\\nb\\t\\"c\\" \\\\d')).toBe('a\nb\t"c" \\d');
    });
});

describe('write_file', () => {
    it('a JS file whose line breaks arrived escaped is unescaped when the result parses, and the result says so', async () => {
        const r = await W.executeToolAsync('write_file', { path: 'src/enemies.js', content: ENEMIES }, null);
        expect(r.success).toBe(true);
        expect(r.escape_fixed).toMatch(/one line holding 7 escaped line breaks.*written as 8 lines/);
        expect(files.get('src/enemies.js')).toBe('// Enemies module\nexport function spawnEnemy(w) {\n  return { x: Math.random() * w, y: -20, label: "a\\b" };\n}\nexport function hits(a, b) {\n  return a.x === b.x;\n}\n');
    });
    it('a one-line script whose \\n sit inside strings is left as written', async () => {
        const src = 'console.log("a\\nb\\nc\\nd");';
        const r = await W.executeToolAsync('write_file', { path: 'say.js', content: src }, null);
        expect(files.get('say.js')).toBe(src);
        expect(r.escape_fixed).toBeUndefined();
    });
    it('a type that cannot be parsed here is written as sent, with a warning', async () => {
        const py = '# word counter\\nimport re\\ndef words(t):\\n    return re.findall(r"\\w+", t)\\n';
        const r = await W.executeToolAsync('write_file', { path: 'wordcount.py', content: py }, null);
        expect(files.get('wordcount.py')).toBe(py);
        expect(r.escape_warning).toMatch(/ONE line holding 4 literal \\n sequences.*leading comment swallows the whole file/);
    });
    it('an ordinary file gets neither', async () => {
        const r = await W.executeToolAsync('write_file', { path: 'src/ok.js', content: 'export const a = 1;\nexport const b = 2;\n' }, null);
        expect(r.escape_fixed).toBeUndefined();
        expect(r.escape_warning).toBeUndefined();
    });
});
