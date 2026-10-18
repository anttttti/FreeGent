# Code execution

The agent runs code through the `execute_code` tool. Where that code runs depends on the language and on **Settings → Code Execution**.

| Language | Where it runs | Needs |
|---|---|---|
| JavaScript | A sandboxed frame in the browser, inside a Worker (a tight loop cannot freeze the page; Stop and a 60 s timeout end it) | nothing, always on |
| Python | Pyodide (Python in WebAssembly) in the browser. Pure-Python packages install with `micropip`. | loads on first use or at startup |
| Bash | **WASM** (default): an x86-64 emulator in the browser running static `grep`, `sed`, `awk`, `find`, `sort`, `tr` and similar. **Local**: real bash on your machine through the dev server. **None**: bash disabled. | WASM binaries download on first use and are cached in IndexedDB |

With the **Local** provider, Python also runs on your machine (unless Pyodide is loaded) with full coreutils, `npm` and `pip`. JavaScript still runs in the browser sandbox.

In every case the workspace is mirrored: project files appear at their normal paths (`/workspace` for bash), and files the code writes sync back to the project, including files it deletes or renames. Very large files are not copied into a run (about 10 MB in the browser sandboxes, 1 MB for Local), so the code cannot see them. A run that writes a file it could not see is refused for that file, with a message, instead of replacing the original with its own output; use `append_file` or `replace_in_file` for those.

| Page | Covers |
|---|---|
| [Browser sandboxes](/code-execution/browser) | JavaScript, Python and WASM bash, their limits and network access |
| [Local execution](/code-execution/local) | Real bash on your machine, bubblewrap isolation, git, headless runs |
