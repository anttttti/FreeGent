// Bash idioms agents write, run in the browser shell (shiro/shell.ts) against an in-memory
// workspace. Expected output is what real bash prints for the same script and files
// (generated with bash 5, LC_ALL=C). Each case gets a fresh shell and workspace.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell, resetShell } from '../shiro/shell-singleton';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

beforeEach(() => {
    files.clear();
    files.set('my file.txt',  { content: 'x\n', encoding: null });
    files.set('plain.txt',    { content: 'z\n', encoding: null });
    files.set('other doc.md', { content: 'y\n', encoding: null });
    files.set('data.csv',     { content: 'a,b\nc,d\n', encoding: null });
    resetShell();
});

// [name, script, bash's stdout]
const CASES: [string, string, string][] = [
    ["multi-line if", "if true; then\n  echo yes\nfi", "yes\n"],
    ["if/elif/else", "x=2\nif [ $x -eq 1 ]; then\n  echo one\nelif [ $x -eq 2 ]; then\n  echo two\nelse\n  echo other\nfi", "two\n"],
    ["multi-line for", "for i in 1 2 3; do\n  echo \"i=$i\"\ndone", "i=1\ni=2\ni=3\n"],
    ["multi-line while", "n=0\nwhile [ $n -lt 3 ]; do\n  n=$((n+1))\n  echo \"n=$n\"\ndone", "n=1\nn=2\nn=3\n"],
    ["multi-line case", "v=b\ncase $v in\n  a) echo A ;;\n  b|c)\n    echo BC\n    ;;\n  *) echo other ;;\nesac", "BC\n"],
    ["nested for/if", "for i in 1 2 3 4; do\n  if [ $((i % 2)) -eq 0 ]; then\n    echo \"even $i\"\n  else\n    echo \"odd $i\"\n  fi\ndone", "odd 1\neven 2\nodd 3\neven 4\n"],
    ["multi-line function", "greet() {\n  echo \"hello $1\"\n}\ngreet world", "hello world\n"],
    ["function keyword", "function add {\n  echo $(($1 + $2))\n}\nadd 2 3", "5\n"],
    ["function with if", "check() {\n  if [ \"$1\" = ok ]; then\n    echo pass\n  else\n    echo fail\n  fi\n}\ncheck ok\ncheck no", "pass\nfail\n"],
    ["brace group", "{ echo a; echo b; }", "a\nb\n"],
    ["brace group redirect", "{ echo a; echo b; } > out.txt\ncat out.txt", "a\nb\n"],
    ["brace group pipe", "{ echo a; echo b; } | wc -l", "2\n"],
    ["brace group and/or", "true && { echo and; }\nfalse || { echo or; }", "and\nor\n"],
    ["brace group multi-line", "{\n  echo one\n  echo two\n}", "one\ntwo\n"],
    ["brace group in subst", "x=$( { echo cap; } )\necho \"$x\"", "cap\n"],
    ["brace group keeps vars", "{ v=1; }\necho \"v=$v\"", "v=1\n"],
    ["quoted $@", "set -- \"a b\" c\necho $#\nfor a in \"$@\"; do echo \"[$a]\"; done", "2\n[a b]\n[c]\n"],
    ["quoted array", "arr=(\"a b\" c)\nfor e in \"${arr[@]}\"; do echo \"[$e]\"; done\necho ${#arr[@]}", "[a b]\n[c]\n2\n"],
    ["function \"$@\"", "f() { for a in \"$@\"; do echo \"[$a]\"; done; }\nf \"a b\" c", "[a b]\n[c]\n"],
    ["glob in for", "for f in *.txt; do echo \"[$f]\"; done", "[my file.txt]\n[plain.txt]\n"],
    ["glob echo", "echo *.txt", "my file.txt plain.txt\n"],
    ["glob quoted var", "for f in *.txt; do wc -l < \"$f\"; done", "1\n1\n"],
    ["read loop IFS", "ls | while IFS= read -r line; do echo \"<$line>\"; done", "<data.csv>\n<my file.txt>\n<other doc.md>\n<plain.txt>\n"],
    ["read loop file", "while IFS=, read -r x y; do echo \"$y-$x\"; done < data.csv", "b-a\nd-c\n"],
    ["read here-string", "IFS=, read -r a b <<< \"p q,r\"\necho \"[$a][$b]\"", "[p q][r]\n"],
    ["find read loop", "find . -name \"*.txt\" | sort | while read -r f; do echo \"<$f>\"; done", "<./my file.txt>\n<./plain.txt>\n"],
    ["printf reuse", "printf \"%s\\n\" \"one two\" three", "one two\nthree\n"],
    ["printf pairs", "printf \"%s=%s\\n\" a 1 b 2", "a=1\nb=2\n"],
    ["xargs -0", "printf 'a b\\0c\\0' | xargs -0 -n1 echo", "a b\nc\n"],
    ["mkdir empty", "mkdir -p newdir\n[ -d newdir ] && echo isdir\nls -d newdir", "isdir\nnewdir\n"],
    ["mkdir then file", "mkdir -p d2/sub\necho hi > d2/sub/f.txt\ncat d2/sub/f.txt", "hi\n"],
    ["heredoc in if", "if true; then\n  cat > gen.txt <<EOF\nline one\nline two\nEOF\nfi\ncat gen.txt", "line one\nline two\n"],
    ["heredoc expands in function", "mk() {\n  cat <<EOF\nname=$1\nsum=$((2 + 3))\nEOF\n}\nmk box", "name=box\nsum=5\n"],
    ["quoted heredoc in for", "for n in 1 2; do\n  cat <<'EOF'\nliteral $n \"q\"\nEOF\ndone", "literal $n \"q\"\nliteral $n \"q\"\n"],
    ["here-string then more lines", "read -r w <<< \"hello\"\necho \"$w\"\necho after", "hello\nafter\n"],
    ["prefix assignment scoped", "X=outer\nX=inner sh -c 'echo \"in:$X\"'\necho \"out:$X\"", "in:inner\nout:outer\n"],
    ["blank lines in read loop", "printf 'a\\n\\nb\\n' | while IFS= read -r l; do echo \"[$l]\"; done", "[a]\n[]\n[b]\n"],
    ["function in pipe", "up() { tr a-z A-Z; }\necho hi | up", "HI\n"],
    ["function redirect", "say() { echo \"said $1\"; }\nsay x > s.txt\ncat s.txt", "said x\n"],
    ["wc multiple files", "wc -l plain.txt data.csv", " 1 plain.txt\n 2 data.csv\n 3 total\n"],
    ["case with multi-line arms", "for f in a.py b.sh c.txt; do\n  case \"$f\" in\n    *.py)\n      echo \"python $f\"\n      ;;\n    *.sh) echo \"shell $f\" ;;\n    *)\n      echo \"other $f\"\n      ;;\n  esac\ndone", "python a.py\nshell b.sh\nother c.txt\n"],
    ["comments in blocks", "for i in 1 2; do  # loop\n  # a comment line\n  echo \"$i\"  # trailing\ndone", "1\n2\n"],
    ["until loop", "n=0\nuntil [ $n -ge 2 ]; do\n  n=$((n+1))\n  echo \"u$n\"\ndone", "u1\nu2\n"],
    ["nested functions and loops", "count() {\n  local c=0\n  for f in \"$@\"; do\n    c=$((c+1))\n  done\n  echo \"$c\"\n}\ncount \"a b\" c d", "3\n"],
];

describe('bash idioms in the browser shell', () => {
    it.each(CASES)('%s', async (_name, script, expected) => {
        const sh = await getShell();
        const r = await sh.exec(script);
        expect(lf(r.stdout)).toBe(expected);
    });
});

describe('state across calls', () => {
    it('keeps functions, variables, aliases and the working directory', async () => {
        const sh = await getShell();
        await sh.exec('greet() { echo "hi $1"; }\nexport FOO=bar\nBAZ=qux\nalias ll="echo aliased"\nmkdir -p sub && cd sub');
        expect(lf((await sh.exec('greet you')).stdout)).toBe('hi you\n');
        expect(lf((await sh.exec('echo "$FOO $BAZ"')).stdout)).toBe('bar qux\n');
        expect(lf((await sh.exec('ll')).stdout)).toBe('aliased\n');
        expect(lf((await sh.exec('pwd')).stdout)).toBe('/workspace/sub\n');
    });
});
