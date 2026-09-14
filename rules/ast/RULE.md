---
name: ast
description: Query code structure with exact line numbers using ast_query. Find function definitions, call sites, references, imports, and classes without reading whole files. Auto-injected for coder role workers and triggered by structural navigation keywords.
trigger: symbol, definition, references, ast, where is, calls to, defined in, rename, function at, imports in, what calls
trigger_on_filetype: .py:msg, .js:msg, .ts:msg, .jsx:msg, .tsx:msg, .java:msg, .go:msg, .rs:msg, .cpp:msg, .c:msg
roles: coder, director
requires: fg_ast_enabled
---

## ast_query — Code Structure Navigation

Use `ast_query(path, query)` to locate symbols with exact line numbers. It is faster and more precise than grep for structural questions.

### Supported queries

| Query | Returns |
|---|---|
| `"functions"` | All function/method definitions with line numbers |
| `"classes"` | All class, interface, struct, type definitions |
| `"imports"` | All import/require/use/include statements |
| `"exports"` | Exported symbols (JS/TS) |
| `"symbols"` | All of the above — full file overview |
| `"calls:NAME"` | Every line that calls function `NAME` |
| `"references:NAME"` | Every line that mentions identifier `NAME` |
| `"symbol_at:LINE"` | Nearest enclosing function/class for line `LINE` |

### When to use

- **Finding a function**: `ast_query("tools.js", "functions")` — get line numbers for all functions, then `read_file("tools.js", start_line, end_line)` for just that function. Avoids reading the whole file.
- **Rename a symbol**: `ast_query("app.js", "references:oldName")` to find every line, then targeted `replace_in_file` for each.
- **Find callers**: `ast_query("utils.js", "calls:helperFn")` across multiple files (call for each file separately).
- **Understanding imports**: `ast_query("index.js", "imports")` to see all dependencies at a glance.
- **Locating context**: `ast_query("server.py", "symbol_at:142")` to know which function line 142 belongs to.

### Workflow pattern

```
1. ast_query(file, "functions")          ← get line numbers
2. read_file(file, start_line, end_line) ← read only that function
3. replace_in_file(...)                  ← targeted edit
```

This three-step pattern is more reliable than reading entire large files.

### Parallelism

Run `ast_query` calls in parallel when scanning multiple files:
```
Run these in parallel:
- ast_query("src/auth.js", "functions")
- ast_query("src/users.js", "functions")
- ast_query("src/api.js", "calls:authenticate")
```

### Limitations

- Uses pattern-based analysis (not a full parser) — may miss dynamically-defined symbols or complex metaprogramming
- `calls:NAME` finds syntactic call patterns; it does not track aliased or dynamically-dispatched calls
- Supported languages: JavaScript, TypeScript, Python, Go, Rust, Java, C#, Ruby, Swift, Kotlin, C/C++
