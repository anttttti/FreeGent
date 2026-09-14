---
name: javascript
description: Run JavaScript/Node.js code via execute_code. Available in all environments. CLI/local: full Node.js with real filesystem and npm. Browser: virtual fs with fs.readFileSync/writeFileSync, no npm.
trigger: javascript, node, nodejs, node.js, js snippet, run js, console.log, require(, npm test, npm run, jest, mocha
trigger_on_filetype: .js, .mjs, .cjs, .jsx
requires_tools: execute_code
---

## execute_code — JavaScript

Use `execute_code(language="javascript", code="...")` to run JavaScript.

### CLI / headless (full Node.js)

Real Node.js runtime with real filesystem access. `require()`, `fs`, `path`, `process`, and npm packages all work normally.

```javascript
// Read and transform a file
const fs = require('fs');
const src = fs.readFileSync('src/utils.js', 'utf8');
console.log(src.slice(0, 200));
```

```javascript
// Run project tests via bash instead — more reliable for npm scripts:
// execute_code(language="bash", code="npm test")
// execute_code(language="bash", code="npx jest src/utils.test.js --no-coverage")
```

```javascript
// Quick logic check without a file
const result = [1,2,3].reduce((a, b) => a + b, 0);
console.log(result); // 6
```

### Browser static (virtual filesystem)

Only `fs` and `path` are available via `require()`. No npm packages, no `import`, no subprocess.

```javascript
// Read a workspace file
const fs = require('fs');
const content = fs.readFileSync('src/parser.js', 'utf8');
console.log(content.length, 'chars');
```

```javascript
// Patch a file in-place
const fs = require('fs');
let src = fs.readFileSync('src/config.js', 'utf8');
src = src.replace('OLD_VALUE', 'NEW_VALUE');
fs.writeFileSync('src/config.js', src);
console.log('patched');
```

```javascript
// List files in a directory
const fs = require('fs');
const entries = fs.readdirSync('src');
console.log(entries.join('\n'));
```

### Rules

- Prefer `bash` for running npm scripts, installing packages, or any shell command.
- Use `javascript` for logic validation, quick transformations, or reading/writing files programmatically.
- In browser sandbox: `require()` only accepts `'fs'` and `'path'` — anything else throws. Wrap in try/catch if unsure.
- `console.log` output appears in `stdout`; `console.error`/`console.warn` in `stderr`.
- Top-level `await` is supported in all environments.
- Written files sync back to workspace automatically — a subsequent `read_file` sees the updated content.
- **Comments**: add one only when the WHY is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific bug). Do not comment what the code does — well-named identifiers already say that.
