// shell-writes.ts — FreeGent: what a bash command line writes to, read from the command text.
//
// Container task runs report no files_written, so the loop reads the command: verification.ts decides
// whether the change was edited, detectors.ts whether a supplied file was overwritten. Two regexes had
// grown for this and disagreed (`ls 2>&1` was an "edit", `x >= 1` inside python -c was an "edit",
// `a->b` named a file `b`, `git apply /tmp/x.patch` was dropped as scratch). One scanner reads the
// shell's own quoting, so text inside quotes or a heredoc body is never an operator.
//
// Not a shell parser: no variables, globs, functions or nested substitution. It errs toward fewer
// paths, never toward inventing one from quoted text.

interface ShellWrites {
    /** Files named as the target of a redirect, tee, sed -i or perl -i. */
    paths: string[];
    /** `patch` or `git apply` ran for real: the workspace changed whatever file the patch came from. */
    patched: boolean;
}

type Tok = { k: 'w'; v: string } | { k: 'op' } | { k: 'sep' };

function _stripHeredocs(code: string): string {
    const out: string[] = [];
    let term: string | null = null, dash = false;
    for (const line of code.split('\n')) {
        if (term !== null) {
            if ((dash ? line.replace(/^\t+/, '') : line) === term) term = null;
            continue;
        }
        out.push(line);
        const m = /(?:^|[^<])<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line);
        if (m) { term = m[3]; dash = m[1] === '-'; }
    }
    return out.join('\n');
}

function _tokens(src: string): Tok[] {
    const toks: Tok[] = [];
    let cur = '', inWord = false;
    const flush = () => { if (inWord) toks.push({ k: 'w', v: cur }); cur = ''; inWord = false; };
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === "'") {
            const j = src.indexOf("'", i + 1);
            cur += src.slice(i + 1, j === -1 ? src.length : j); inWord = true;
            i = j === -1 ? src.length : j;
        } else if (c === '"') {
            let j = i + 1;
            for (; j < src.length && src[j] !== '"'; j++) {
                if (src[j] === '\\' && j + 1 < src.length) j++;
                cur += src[j];
            }
            inWord = true; i = j;
        } else if (c === '\\') {
            if (src[i + 1] === '\n') { i++; continue; }
            cur += src[i + 1] ?? ''; inWord = true; i++;
        } else if (c === '#' && !inWord) {
            while (i < src.length && src[i] !== '\n') i++;
            i--;
        } else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') {
            flush(); toks.push({ k: 'sep' });
        } else if (c === ' ' || c === '\t' || c === '\r') {
            flush();
        } else if (c === '&') {
            if (src[i + 1] === '>') {                      // &> and &>>
                flush(); i += src[i + 2] === '>' ? 2 : 1; toks.push({ k: 'op' });
            } else { flush(); toks.push({ k: 'sep' }); }
        } else if (c === '<') {
            flush();                                        // input redirect or heredoc marker: not a write
            if (src[i + 1] === '<') i++;
            if (src[i + 1] === '<') i++;
        } else if (c === '>') {
            if (inWord && /^\d+$/.test(cur)) { cur = ''; inWord = false; }   // 2>file: the fd is not an argument
            else flush();
            if (src[i + 1] === '(') continue;               // process substitution
            if (src[i + 1] === '&') {
                // >&1, >&2, >&- duplicate a descriptor; >&file writes both streams to file
                const m = /^&(\d+|-)(?![\w./~$-])/.exec(src.slice(i + 1));
                if (m) { i += m[0].length; continue; }
                i++;
            } else if (src[i + 1] === '>' || src[i + 1] === '|') i++;
            toks.push({ k: 'op' });
        } else { cur += c; inWord = true; }
    }
    flush();
    return toks;
}

const _ENV_ASSIGN = /^[A-Za-z_]\w*=/;

export function shellWrites(code: string): ShellWrites {
    const out: ShellWrites = { paths: [], patched: false };
    const toks = _tokens(_stripHeredocs(String(code ?? '')));
    let cmd: string[] = [];
    const endCommand = () => {
        const words = cmd.filter(w => w !== '\u0000');
        cmd = [];
        let i = 0;
        while (i < words.length && (_ENV_ASSIGN.test(words[i]) || words[i] === 'sudo' || words[i] === 'env' || words[i] === 'command')) i++;
        const name = (words[i] ?? '').split('/').pop();
        const args = words.slice(i + 1);
        const opts = args.filter(a => a.startsWith('-') && a.length > 1);
        const plain = args.filter(a => !(a.startsWith('-') && a.length > 1));
        if (name === 'tee') out.paths.push(...plain);
        else if (name === 'sed' && opts.some(o => /^-[A-Za-z]*i/.test(o) || o.startsWith('--in-place'))) {
            // the script is the first plain argument unless -e/-f supplied it (and then it is that flag's value)
            let scripted = false;
            const files: string[] = [];
            for (let k = 0; k < args.length; k++) {
                const a = args[k];
                if (a === '--expression' || a === '--file' || /^-[A-Za-z]*[ef]$/.test(a)) { scripted = true; k++; continue; }
                if (a.startsWith('-') && a.length > 1) continue;
                files.push(a);
            }
            out.paths.push(...(scripted ? files : files.slice(1)));
        } else if (name === 'perl' && opts.some(o => /^-[A-Za-z]*i/.test(o))) {
            out.paths.push(...plain.slice(1));
        } else if (name === 'patch' && !opts.includes('--dry-run')) out.patched = true;
        else if (name === 'git' && args[0] === 'apply'
            && !args.some(a => a === '--check' || a === '--stat' || a === '--numstat' || a === '--summary')) out.patched = true;
    };
    let expectTarget = false;
    for (const t of toks) {
        if (t.k === 'sep') { expectTarget = false; endCommand(); continue; }
        if (t.k === 'op') { expectTarget = true; continue; }
        if (expectTarget) {
            expectTarget = false;
            const p = t.v.replace(/^\.\//, '');
            if (p && !p.startsWith('/dev/') && p !== '-') out.paths.push(p);
            continue;
        }
        cmd.push(t.v);
    }
    endCommand();
    out.paths = out.paths.map(p => p.replace(/^\.\//, '')).filter(p => p && !p.startsWith('/dev/') && p !== '-');
    return out;
}
