// ast.js — Code structure queries with line numbers for agent navigation
// Provides ast_query(path, query) used by coder agents to locate symbols precisely.
// Pure functions — no state.js deps.

function _astLineOf(content, idx) {
    return content.substring(0, idx).split('\n').length;
}

// Escape a string for use in a RegExp
function _astEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-language AST query visitors — each mutates ctx.results in-place.
// Called by _astQueryContent via _AST_LANG_DISPATCH; never called directly.
// ─────────────────────────────────────────────────────────────────────────────

type AstCtx = {
    content: string;
    lineOf: (idx: number) => number;
    results: Array<{ name: string; type: string; line: number }>;
    wantFn:  boolean;
    wantCls: boolean;
    wantImp: boolean;
    wantExp: boolean;
    callMatch: string | null;
    refMatch:  string | null;
};

function _astQueryJS({ content, lineOf, results, wantFn, wantCls, wantImp, wantExp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        // function declarations
        const fnDecl = /(?:^|[\s;{}(,])(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[\w<(]/gm;
        while ((m = fnDecl.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });

        // arrow and function-expression assignments
        const arrow = /(?:^|[\s;{}])(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$_]+)\s*=>/gm;
        while ((m = arrow.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });

        const fnExpr = /(?:^|[\s;{}])(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/gm;
        while ((m = fnExpr.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });

        // class methods
        const method = /^\s+(?:(?:static|async|get|set|#|private|public|protected|override)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/gm;
        while ((m = method.exec(content)) !== null) {
            if (!['if','while','for','switch','try','catch'].includes(m[1]))
                results.push({ name: m[1], type: 'method', line: lineOf(m.index) });
        }
    }

    if (wantCls) {
        const cls = /(?:^|[\s;{}])(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
        const iface = /(?:^|[\s;{}])(?:export\s+)?interface\s+(\w+)/gm;
        while ((m = iface.exec(content)) !== null) results.push({ name: m[1], type: 'interface', line: lineOf(m.index) });
        const typ = /(?:^|[\s;{}])(?:export\s+)?type\s+(\w+)\s*=/gm;
        while ((m = typ.exec(content)) !== null) results.push({ name: m[1], type: 'type', line: lineOf(m.index) });
    }

    if (wantImp) {
        const imp = /^import\s+.+\s+from\s+['"][^'"]+['"]/gm;
        while ((m = imp.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
        const req = /(?:const|let|var)\s+\{?(\w[\w\s,]*)\}?\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
        while ((m = req.exec(content)) !== null) results.push({ name: `${m[1].trim()} from "${m[2]}"`, type: 'require', line: lineOf(m.index) });
    }

    if (wantExp) {
        const expNamed = /^export\s*\{([^}]+)\}/gm;
        while ((m = expNamed.exec(content)) !== null) results.push({ name: m[1].trim(), type: 'export', line: lineOf(m.index) });
        const expDefault = /^export\s+default\s+(?:function|class)?\s*(\w+)/gm;
        while ((m = expDefault.exec(content)) !== null) results.push({ name: m[1] || '(default)', type: 'export', line: lineOf(m.index) });
        const expDecl = /^export\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm;
        while ((m = expDecl.exec(content)) !== null) results.push({ name: m[1], type: 'export', line: lineOf(m.index) });
        const expConst = /^export\s+(?:const|let|var)\s+(\w+)/gm;
        while ((m = expConst.exec(content)) !== null) results.push({ name: m[1], type: 'export', line: lineOf(m.index) });
    }

    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryPython({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const cls = /^class\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const imp1 = /^import\s+[\w,.\s]+/gm;
        while ((m = imp1.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
        const imp2 = /^from\s+\S+\s+import\s+.+/gm;
        while ((m = imp2.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryGo({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*[(<]/gm;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const typ = /^type\s+(\w+)\s+(?:struct|interface)/gm;
        while ((m = typ.exec(content)) !== null) results.push({ name: m[1], type: 'type', line: lineOf(m.index) });
    }
    if (wantImp) {
        const imp = /^import\s+(?:"[^"]+"|`[^`]+`|\([\s\S]*?\))/gm;
        while ((m = imp.exec(content)) !== null) results.push({ name: m[0].trim().split('\n')[0], type: 'import', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryRust({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /(?:^|\s)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/gm;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const typ = /(?:^|\s)(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/gm;
        while ((m = typ.exec(content)) !== null) results.push({ name: m[1], type: 'type', line: lineOf(m.index) });
    }
    if (wantImp) {
        const use_ = /^use\s+[^;]+;/gm;
        while ((m = use_.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'use', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*[(!<]`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryJava({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /(?:public|private|protected|static|final|synchronized|abstract|native|\s)+[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:throws[^{]+)?\{/g;
        while ((m = fn.exec(content)) !== null) {
            if (!['if','while','for','switch','try','catch','else'].includes(m[1]))
                results.push({ name: m[1], type: 'method', line: lineOf(m.index) });
        }
    }
    if (wantCls) {
        const cls = /(?:public|private|protected)?\s+(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const imp = /^import\s+[\w.*]+;/gm;
        while ((m = imp.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryCSharp({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /(?:public|private|protected|internal|static|virtual|override|abstract|async|\s)+[\w<>\[\]?]+\s+(\w+)\s*\([^)]*\)\s*(?:where[^{]+)?\{/g;
        while ((m = fn.exec(content)) !== null) {
            if (!['if','while','for','switch','using','lock','try','catch'].includes(m[1]))
                results.push({ name: m[1], type: 'method', line: lineOf(m.index) });
        }
    }
    if (wantCls) {
        const cls = /(?:public|private|protected|internal)?\s+(?:abstract\s+|sealed\s+|static\s+)?(?:class|interface|enum|struct)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const use_ = /^using\s+[\w.]+;/gm;
        while ((m = use_.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'using', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryRuby({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /^\s*def\s+(\w+[?!]?)/gm;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const cls = /^(?:class|module)\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const req = /^(?:require|require_relative|include|extend)\s+['"]?[\w/.]+['"]?/gm;
        while ((m = req.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'require', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*[\\(]?`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQuerySwift({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /(?:func|init)\s+(\w+)\s*[<(]/g;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const cls = /(?:class|struct|enum|protocol|extension)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'type', line: lineOf(m.index) });
    }
    if (wantImp) {
        const imp = /^import\s+\w+/gm;
        while ((m = imp.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryKotlin({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /(?:fun|suspend\s+fun)\s+(\w+)\s*[<(]/g;
        while ((m = fn.exec(content)) !== null) results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
    }
    if (wantCls) {
        const cls = /(?:class|object|interface|data\s+class|sealed\s+class)\s+(\w+)/g;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const imp = /^import\s+[\w.*]+/gm;
        while ((m = imp.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'import', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

function _astQueryCCpp({ content, lineOf, results, wantFn, wantCls, wantImp, callMatch, refMatch }: AstCtx): void {
    let m: RegExpExecArray | null;
    if (wantFn) {
        const fn = /^[\w:*&<>\s]+\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/gm;
        while ((m = fn.exec(content)) !== null) {
            if (!['if','while','for','switch','try','catch','else'].includes(m[1]))
                results.push({ name: m[1], type: 'function', line: lineOf(m.index) });
        }
    }
    if (wantCls) {
        const cls = /^(?:class|struct|enum)\s+(\w+)/gm;
        while ((m = cls.exec(content)) !== null) results.push({ name: m[1], type: 'class', line: lineOf(m.index) });
    }
    if (wantImp) {
        const inc = /^#include\s+[<"][^>"]+[>"]/gm;
        while ((m = inc.exec(content)) !== null) results.push({ name: m[0].trim(), type: 'include', line: lineOf(m.index) });
    }
    if (callMatch) {
        const re = new RegExp(`\\b${_astEscape(callMatch)}\\s*\\(`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: callMatch, type: 'call', line: lineOf(m.index) });
    }
    if (refMatch) {
        const re = new RegExp(`\\b${_astEscape(refMatch)}\\b`, 'g');
        while ((m = re.exec(content)) !== null) results.push({ name: refMatch, type: 'reference', line: lineOf(m.index) });
    }
}

// Dispatch table — maps language key to visitor function.
const _AST_LANG_DISPATCH: Record<string, (ctx: AstCtx) => void> = {
    javascript: _astQueryJS,
    typescript: _astQueryJS,
    python:     _astQueryPython,
    go:         _astQueryGo,
    rust:       _astQueryRust,
    java:       _astQueryJava,
    csharp:     _astQueryCSharp,
    ruby:       _astQueryRuby,
    swift:      _astQuerySwift,
    kotlin:     _astQueryKotlin,
    c:          _astQueryCCpp,
    cpp:        _astQueryCCpp,
};

// Returns array of { name, type, line } sorted by line.
// Supported queries: functions, classes, imports, exports, symbols, calls:NAME,
//                    references:NAME, symbol_at:LINE
function _astQueryContent(content, lang, query) {
    if (!content || !lang) return [];

    const lineOf = (idx: number) => _astLineOf(content, idx);
    const results: Array<{ name: string; type: string; line: number }> = [];

    const wantFn  = query === 'functions' || query === 'symbols';
    const wantCls = query === 'classes'   || query === 'symbols';
    const wantImp = query === 'imports'   || query === 'symbols';
    const wantExp = query === 'exports'   || query === 'symbols';

    const callMatch = query.startsWith('calls:')      ? query.slice(6)  : null;
    const refMatch  = query.startsWith('references:') ? query.slice(11) : null;
    const lineAt    = query.startsWith('symbol_at:')  ? parseInt(query.slice(10), 10) : null;

    // symbol_at: delegate to a symbols query then filter
    if (lineAt !== null) {
        const all = _astQueryContent(content, lang, 'symbols')
            .filter(s => s.type === 'function' || s.type === 'method' || s.type === 'class');
        let best: any = null;
        for (const s of all) {
            if (s.line <= lineAt && (!best || s.line > best.line)) best = s;
        }
        return best ? [best] : [];
    }

    const ctx: AstCtx = { content, lineOf, results, wantFn, wantCls, wantImp, wantExp, callMatch, refMatch };
    _AST_LANG_DISPATCH[lang]?.(ctx);
    return results.sort((a, b) => a.line - b.line);
}

// Format results as a concise readable string for tool output.
// references and calls get a compact line-number list; others get name:line pairs grouped by type.
function _astFormatResults(results, query, path) {
    if (!results.length) return `No ${query} found in ${path}.`;

    const isFlat = query.startsWith('calls:') || query.startsWith('references:');
    if (isFlat) {
        const lines = results.map(r => r.line).join(', ');
        return `${query} in ${path} — lines: ${lines} (${results.length} occurrences)`;
    }

    // Group by type for overview queries
    const byType = new Map();
    for (const r of results) {
        if (!byType.has(r.type)) byType.set(r.type, []);
        byType.get(r.type).push(r);
    }

    const parts = [];
    for (const [type, items] of byType) {
        const entries = items.map(r => {
            if (type === 'import' || type === 'require' || type === 'use' || type === 'include' || type === 'using') {
                return `  ${r.line}: ${r.name}`;
            }
            return `  ${r.line}: ${r.name}`;
        }).join('\n');
        parts.push(`${type}s:\n${entries}`);
    }
    return `${path}:\n${parts.join('\n')}`;
}

// Window bridge — tools.js (classic script) accesses these directly.
Object.assign(window, { _astQueryContent, _astFormatResults });
