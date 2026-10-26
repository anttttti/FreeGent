#!/usr/bin/env node
// code-index.mjs — structure questions about FreeGent's own TypeScript, answered from the syntax tree instead of regexes.
//   node scripts/code-index.mjs functions [--top 15] [--dir .]        the longest functions (declarations, methods, functions/arrows assigned to a const)
//   node scripts/code-index.mjs exports   [--unused] [--dir .]        exported names with the number of other files that mention them
//   node scripts/code-index.mjs cycles    [--dir .]                   pairs of modules that import each other (static imports, root and subdirectories)
// Every command takes --root-only (only the files directly in --dir).
// Written after the self-analysis runs T03/T14 (hand-made brace matching ranked nested pseudo-functions above the real longest function and
// reported indexes into a comment-stripped line list) and T02 (a scanner that did not read .tsx files called a live function dead).
// Scope: *.ts, *.tsx, *.js, *.mjs under --dir, without node_modules, dist, notes, logs, tmp, the directories this checkout keeps out of git, tests (tests only count as users for `exports`).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { localIgnoredDirs } from './local-ignored-dirs.mjs';
const ts = createRequire(import.meta.url)('typescript');

const SKIP = new Set([...localIgnoredDirs(), 'node_modules', 'dist', 'notes', 'logs', 'tmp', 'out', '.git', 'results', 'public', 'coverage', 'test-results', 'research', 'docs', '.vitepress']);
const argv = process.argv.slice(2), cmd = argv[0];
const flag = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };
const dir = resolve(String(flag('--dir', '.')));

function walk(d, out = []) {
    for (const e of readdirSync(d)) {
        if (SKIP.has(e) || e.startsWith('code-review-artifacts')) continue;
        const p = join(d, e), st = statSync(p);
        if (st.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|mjs)$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
    }
    return out;
}
const parse = (f) => ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : f.endsWith('.js') || f.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function functions(files, top) {
    const rows = [];
    for (const f of files) {
        const sf = parse(f);
        const visit = (n) => {
            let name = null;
            if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) name = n.name?.getText(sf) ?? '(anonymous)';
            else if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) name = n.name.getText(sf);
            if (name) {
                const start = lineOf(sf, n.getStart(sf)), end = lineOf(sf, n.end);
                rows.push({ file: relative(dir, f), line: start, name, length: end - start + 1 });
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    rows.sort((a, b) => b.length - a.length);
    for (const r of rows.slice(0, top)) console.log(`${String(r.length).padStart(5)}  ${r.file}:${r.line}  ${r.name}`);
}

function exportsOf(sf) {
    const names = [];
    const isExported = (n) => (ts.getCombinedModifierFlags?.(n) & ts.ModifierFlags.Export) || n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st) && isExported(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push([d.name.text, lineOf(sf, d.getStart(sf))]);
        } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && isExported(st) && st.name) names.push([st.name.text, lineOf(sf, st.getStart(sf))]);
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) && !st.moduleSpecifier) for (const e of st.exportClause.elements) names.push([e.name.text, lineOf(sf, e.getStart(sf))]);
    }
    return names;
}

function exports_(files, unusedOnly) {
    const texts = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));
    const all = [...files, ...walkTests()];
    for (const f of all) if (!texts.has(f)) texts.set(f, readFileSync(f, 'utf8'));
    let total = 0, rows = [];
    for (const f of files) {
        for (const [name, line] of exportsOf(parse(f))) {
            total++;
            const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
            const users = [...texts].filter(([g, t]) => g !== f && re.test(t)).map(([g]) => relative(dir, g));
            const own = (texts.get(f).match(new RegExp(re.source, 'g')) ?? []).length - 1;
            rows.push({ file: relative(dir, f), line, name, users: users.length, own });
        }
    }
    const shown = unusedOnly ? rows.filter(r => r.users === 0) : rows;
    for (const r of shown) console.log(`${r.users === 0 ? (r.own > 0 ? 'self-only' : 'UNUSED   ') : String(r.users).padStart(9)}  ${r.file}:${r.line}  ${r.name}`);
    console.error(`${total} exports; ${rows.filter(r => r.users === 0 && r.own === 0).length} with no mention anywhere else (not even in their own file); ${rows.filter(r => r.users === 0 && r.own > 0).length} mentioned only in their own file`);
}
function walkTests() { try { return walk(join(dir, 'tests')); } catch { return []; } }

function cycles(files) {
    const byPath = new Map(files.map(f => [f.replace(/\.(ts|tsx|js|mjs)$/, ''), f]));
    const edges = new Map();
    for (const f of files) {
        const sf = parse(f), set = new Set();
        for (const st of sf.statements) {
            if (!(ts.isImportDeclaration(st) || (ts.isExportDeclaration(st) && st.moduleSpecifier))) continue;
            const spec = st.moduleSpecifier?.text;
            if (!spec?.startsWith('.')) continue;
            const target = byPath.get(resolve(dirname(f), spec).replace(/\.(js|ts|tsx|mjs)$/, ''));
            if (target) set.add(target);
        }
        edges.set(f, set);
    }
    const pairs = [];
    for (const [a, set] of edges) for (const b of set) if (a < b && edges.get(b)?.has(a)) pairs.push([relative(dir, a), relative(dir, b)]);
    for (const [a, b] of pairs.sort()) console.log(`${a} <-> ${b}`);
    console.error(`${pairs.length} two-module cycles among ${files.length} files`);
}

const files = walk(dir).filter(f => !f.startsWith(join(dir, 'tests') + '/') && (!flag('--root-only', false) || dirname(f) === dir));
if (cmd === 'functions') functions(files, Number(flag('--top', 15)));
else if (cmd === 'exports') exports_(files, !!flag('--unused', false));
else if (cmd === 'cycles') cycles(files);
else { console.error('usage: code-index.mjs functions [--top N] | exports [--unused] | cycles   [--dir path] [--root-only]'); process.exit(1); }
