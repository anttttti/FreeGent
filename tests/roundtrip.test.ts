// Round trips between the tools: whatever one tool writes, every other tool reads back byte for
// byte. Writers and readers: the file tools (write_file / read_file / append_file), execute_code
// in bash, Python and JavaScript, and python3 and node started from bash. Payloads: UTF-8, CRLF,
// a BOM, Latin-1, all 256 byte values, an empty file and one without a final newline.
//
// On both backends (tests/tool-backends.ts): the browser (IndexedDB workspace, exec sandbox with
// the WASM shell and Pyodide) and headless (a workspace directory, real processes). Paths are
// written in each tool's own way — relative, ./, absolute under the workspace — so the absolute
// ones come from the backend's root.
import { BACKENDS, type Backend } from './tool-backends';

const W = globalThis as any;

const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const PAYLOADS: Record<string, number[]> = {
    utf8:   utf8('café 中文 😀\n'),
    crlf:   utf8('a\r\nb\r\n\r\n'),
    bom:    utf8('﻿name,value\nx,1\n'),
    latin1: [0x63, 0x61, 0x66, 0xe9, 0x0a],
    binary: [...Array(256).keys()],
    empty:  [],
    noeol:  utf8('last line'),
};
const hex = (b: number[] | Uint8Array) => Buffer.from(b).toString('hex');
const isText = (b: number[]) => !b.includes(0) && (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(b)); return true; } catch { return false; } })();
const names = Object.keys(PAYLOADS);

const exec = async (language: string, code: string) => {
    const r = await W.executeToolAsync('execute_code', { language, code });
    if (r?.error || r?.exit_code) throw new Error(`${language} failed: ${JSON.stringify(r).slice(0, 600)}`);
    return String(r.stdout ?? '');
};
const pyBytes = (b: number[]) => `bytes.fromhex("${hex(b)}")`;
const jsBytes = (b: number[]) => `Buffer.from("${hex(b)}", "hex")`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const printfBytes = (b: number[]) => `printf '${b.map(x => '\\x' + x.toString(16).padStart(2, '0')).join('')}'`;

/** Each writer puts every payload at <dir>/<name>.dat, using its own idea of a path. */
const writers = (be: Backend): Record<string, (dir: string) => Promise<void>> => ({
    'write_file': async dir => {
        for (const n of names) {
            const b = PAYLOADS[n];
            const args = isText(b) ? { path: `${dir}/${n}.dat`, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(b)) }
                                   : { path: `${be.root()}/${dir}/${n}.dat`, content: Buffer.from(b).toString('base64'), encoding: 'base64' };
            const r = await W.executeToolAsync('write_file', args);
            if (r?.error) throw new Error(`write_file ${n}: ${r.error}`);
        }
    },
    'bash': dir => exec('bash', [`mkdir -p "$PWD/${dir}"`,
        ...names.map(n => `${printfBytes(PAYLOADS[n])} > "$PWD/${dir}/${n}.dat"`)].join('\n')).then(() => {}),
    'execute_code python': dir => exec('python', [`import os`, `os.makedirs("./${dir}", exist_ok=True)`,
        ...names.map(n => `open("${dir}/${n}.dat", "wb").write(${pyBytes(PAYLOADS[n])})`)].join('\n')).then(() => {}),
    'execute_code javascript': dir => exec('javascript', [`const fs = require("fs"), path = require("path");`, `fs.mkdirSync("${dir}", { recursive: true });`,
        ...names.map(n => `fs.writeFileSync(path.join(process.cwd(), "${dir}/${n}.dat"), ${jsBytes(PAYLOADS[n])});`)].join('\n')).then(() => {}),
    'python3 from bash': dir => exec('bash', `python3 -c ${shq([`import os`, `os.makedirs("${dir}", exist_ok=True)`,
        ...names.map(n => `open(os.path.join(os.getcwd(), "${dir}", "${n}.dat"), "wb").write(${pyBytes(PAYLOADS[n])})`)].join('\n'))}`).then(() => {}),
    'node from bash': dir => exec('bash', `node -e ${shq([`const fs = require("fs");`, `fs.mkdirSync("${dir}", { recursive: true });`,
        ...names.map(n => `fs.writeFileSync("./${dir}/${n}.dat", ${jsBytes(PAYLOADS[n])});`)].join('\n'))}`).then(() => {}),
});

/** Each reader returns, per payload, the hex of the bytes it read from <dir>/<name>.dat. */
const readers = (be: Backend): Record<string, (dir: string) => Promise<Record<string, string>>> => ({
    // read_file gives text: compared on the text payloads only (binary files are refused).
    'read_file': async dir => {
        const out: Record<string, string> = {};
        for (const n of names) {
            if (!isText(PAYLOADS[n])) continue;
            const r = await W.executeToolAsync('read_file', { path: `${be.root()}/${dir}/${n}.dat` });
            out[n] = r?.error ? `error: ${r.error}` : Buffer.from(String(r.content ?? ''), 'utf8').toString('hex');
        }
        return out;
    },
    'bash': async dir => lines(await exec('bash',
        names.map(n => `printf '%s ' ${n}; od -An -tx1 -v ${dir}/${n}.dat | tr -d ' \\n'; echo`).join('\n'))),
    'execute_code python': async dir => lines(await exec('python', ['import os',
        ...names.map(n => `print("${n}", open(os.path.join(os.getcwd(), "${dir}/${n}.dat"), "rb").read().hex())`)].join('\n'))),
    'execute_code javascript': async dir => lines(await exec('javascript', [`const fs = require("fs");`,
        ...names.map(n => `console.log("${n}", fs.readFileSync("./${dir}/${n}.dat").toString("hex"));`)].join('\n'))),
    'python3 from bash': async dir => lines(await exec('bash', `cd ${dir} && python3 -c ${shq(
        names.map(n => `print("${n}", open("${n}.dat", "rb").read().hex())`).join('\n'))}`)),
    'node from bash': async dir => lines(await exec('bash', `node -e ${shq([`const fs = require("fs"), path = require("path");`,
        ...names.map(n => `console.log("${n}", fs.readFileSync(path.resolve("${dir}/${n}.dat")).toString("hex"));`)].join('\n'))}`)),
});
function lines(stdout: string): Record<string, string> {
    return Object.fromEntries(stdout.split('\n').filter(Boolean).map(l => { const [n, h = ''] = l.trim().split(' '); return [n, h]; }));
}

describe.each(BACKENDS)('$name', be => {
    beforeAll(be.setup, 120_000);
    afterAll(() => be.teardown());

    describe.each(Object.keys(writers(be)))('written by %s', writer => {
        const dir = `rt/${writer.replace(/\W+/g, '-')}`;
        beforeAll(async () => { await writers(be)[writer](dir); }, 120_000);

        it('stores exactly the bytes written', async () => {
            for (const n of names) expect((await be.stored(`${dir}/${n}.dat`))?.toString('hex'), n).toBe(hex(PAYLOADS[n]));
        });

        it.each(Object.keys(readers(be)))('is read back exactly by %s', async reader => {
            const want = Object.fromEntries(names.filter(n => reader !== 'read_file' || isText(PAYLOADS[n])).map(n => [n, hex(PAYLOADS[n])]));
            expect(await readers(be)[reader](dir)).toEqual(want);
        }, 120_000);
    });

    describe('a file passed along every tool', () => {
        it('gets one line from each and reads the same everywhere', async () => {
            await W.executeToolAsync('write_file', { path: 'chain/log.txt', content: 'file tool ä\r\n' });
            await exec('python', 'open("chain/log.txt", "a", newline="").write("python 😀\\r\\n")');
            await exec('javascript', 'require("fs").appendFileSync(require("path").join(process.cwd(), "chain/log.txt"), "javascript é\\r\\n");');
            await exec('bash', `printf 'bash \\xe2\\x82\\xac\\r\\n' >> ./chain/log.txt`);
            await exec('bash', `python3 -c ${shq('open("chain/log.txt", "a", newline="").write("python3 ß\\r\\n")')}`);
            await exec('bash', `cd chain && node -e ${shq('require("fs").appendFileSync("log.txt", "node ñ\\r\\n")')}`);
            await W.executeToolAsync('append_file', { path: 'chain/log.txt', content: 'append_file ø\r\n' });
            const want = 'file tool ä\r\npython 😀\r\njavascript é\r\nbash €\r\npython3 ß\r\nnode ñ\r\nappend_file ø\r\n';
            const wantHex = Buffer.from(want).toString('hex');
            expect((await W.executeToolAsync('read_file', { path: 'chain/log.txt' })).content).toBe(want);
            expect(await exec('python', 'print(open("chain/log.txt", "rb").read().hex())')).toBe(wantHex + '\n');
            expect(await exec('javascript', 'console.log(require("fs").readFileSync("chain/log.txt").toString("hex"))')).toBe(wantHex + '\n');
            expect(await exec('bash', 'od -An -tx1 -v chain/log.txt | tr -d " \\n"')).toBe(wantHex);
            expect(await exec('bash', `python3 -c ${shq('print(open("chain/log.txt", "rb").read().hex())')}`)).toBe(wantHex + '\n');
            expect(await exec('bash', `node -e ${shq('console.log(require("fs").readFileSync("chain/log.txt").toString("hex"))')}`)).toBe(wantHex + '\n');
        }, 120_000);

        it('sees deletions and renames from any tool in every other', async () => {
            await exec('python', 'import os\nos.makedirs("mv", exist_ok=True)\nopen("mv/a.txt", "w").write("A")\nopen("mv/b.txt", "w").write("B")');
            await exec('javascript', 'const fs = require("fs"); fs.renameSync("mv/a.txt", "mv/a2.txt");');
            await exec('bash', 'rm mv/b.txt && mv mv/a2.txt mv/a3.txt');
            expect(await exec('python', 'import os\nprint(sorted(os.listdir("mv")))')).toBe("['a3.txt']\n");
            expect(await exec('javascript', 'console.log(require("fs").readdirSync("mv").join(","))')).toBe('a3.txt\n');
            expect(await exec('bash', 'python3 -c "import os; print(os.listdir(\'mv\'))"; node -e "console.log(require(\'fs\').existsSync(\'mv/b.txt\'))"')).toBe("['a3.txt']\nfalse\n");
            expect((await W.executeToolAsync('list_files', { path: 'mv' })).files.map((f: any) => f.name)).toEqual(['mv/a3.txt']);
        }, 120_000);
    });
});
