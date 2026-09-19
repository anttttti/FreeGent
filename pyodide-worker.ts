// pyodide-worker.js — runs Python in a Web Worker via Pyodide
importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js');

let pyodide: any = null;

function syncfs(populate) {
    return new Promise<void>((resolve, reject) => {
        pyodide.FS.syncfs(populate, err => err ? reject(err) : resolve());
    });
}

async function init() {
    try {
        pyodide = await loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'
        });
        await pyodide.loadPackage("micropip");

        pyodide.FS.mkdirTree('/workspace');
        pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, '/workspace');
        await syncfs(true); // populate from any existing IDBFS data

        self.postMessage({ type: 'ready' });
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message });
    }
}

function purgeStale(dir, prefix, validFiles) {
    let entries: string[];
    try { entries = pyodide.FS.readdir(dir); } catch { return; }
    for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;
        const fullPath = `${dir}/${entry}`;
        const relPath  = prefix ? `${prefix}/${entry}` : entry;
        let isDir: boolean = false;
        try { pyodide.FS.readdir(fullPath); isDir = true; } catch {}
        if (isDir) {
            purgeStale(fullPath, relPath, validFiles);
            try {
                const left = pyodide.FS.readdir(fullPath).filter(e => e !== '.' && e !== '..');
                if (!left.length) pyodide.FS.rmdir(fullPath);
            } catch {}
        } else if (!(relPath in validFiles)) {
            try { pyodide.FS.unlink(fullPath); } catch {}
        }
    }
}

const _IMAGE_MIMES = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
                       gif:'image/gif', webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml' };
function _guessMime(filename) {
    return _IMAGE_MIMES[(filename.split('.').pop() || '').toLowerCase()] || '';
}

function snapshotDir(dir, prefix) {
    const snap = {};
    let entries: string[];
    try { entries = pyodide.FS.readdir(dir); } catch { return snap; }
    for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;
        const fullPath = `${dir}/${entry}`;
        const relPath  = prefix ? `${prefix}/${entry}` : entry;
        let isDir = false;
        try { pyodide.FS.readdir(fullPath); isDir = true; } catch {}
        if (isDir) Object.assign(snap, snapshotDir(fullPath, relPath));
        else {
            const mime = _guessMime(entry);
            if (mime) {
                // Known image extension — always read as binary so pyodide.FS.readFile
                // with { encoding:'utf8' } can't silently corrupt the bytes.
                // (Emscripten's UTF8ToString stops at the first 0x00 byte and returns a
                // short, truncated string instead of throwing, so the catch below would
                // never fire for image files without this early-exit path.)
                try {
                    const bytes = pyodide.FS.readFile(fullPath);
                    let b64 = '';
                    for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
                    b64 = btoa(b64);
                    snap[relPath] = `\x00IMG\x00${mime}\x00${b64}`;
                } catch {}
            } else {
                try {
                    snap[relPath] = pyodide.FS.readFile(fullPath, { encoding: 'utf8' });
                } catch {
                    // Binary file — encode as base64. Non-image binaries get \x00BIN\x00 so
                    // they are written back to the IDB workspace with base64 encoding.
                    try {
                        const bytes = pyodide.FS.readFile(fullPath);
                        // Encode without chunking: chunked btoa inserts '=' mid-string when
                        // chunk size is not a multiple of 3; browser atob() stops at the
                        // first interior '=', silently truncating files > chunk size bytes.
                        let b64 = '';
                        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
                        b64 = btoa(b64);
                        snap[relPath] = `\x00BIN\x00${b64}`;
                    } catch {}
                }
            }
        }
    }
    return snap;
}

self.onmessage = async ({ data }) => {
    if (data.type === 'install_packages') {
        const { id, packages } = data;
        try {
            await pyodide.runPythonAsync(`
                import micropip
                await micropip.install(${JSON.stringify(packages)})
            `);
            self.postMessage({ type: 'result', id, stdout: '', stderr: '', exit_code: 0, changedFiles: {} });
        } catch (e) {
            self.postMessage({ type: 'result', id, stdout: '', stderr: e.message, exit_code: 1, changedFiles: {} });
        }
        return;
    }

    if (data.type !== 'run') return;
    const { id, code, files } = data;

    // Libraries that require a display/screen and cannot run in a Web Worker.
    const _DISPLAY_LIBS = /^\s*(?:import|from)\s+(pygame|pygame_ce|turtle|tkinter|wx|gi\.repository|PyQt[456]|PySide[26])\b/m;
    if (_DISPLAY_LIBS.test(code)) {
        const lib = code.match(_DISPLAY_LIBS)?.[1] ?? 'a display library';
        self.postMessage({ type: 'result', id, stdout: '',
            stderr: `${lib} requires a display and cannot run in Pyodide's Web Worker context (no screen access).\nTry running the logic without the GUI, or use a server-side Python environment.`,
            exit_code: 1, changedFiles: {} });
        return;
    }

    try {
        // Refresh IDBFS from its backing store, then migrate any files from the main
        // thread that are missing or outdated (first-run migration + incremental sync).
        await syncfs(true);
        for (const [name, content] of Object.entries(files || {})) {
            const path = `/workspace/${name}`;
            const dir  = path.slice(0, path.lastIndexOf('/'));
            if (dir && dir !== '/workspace') pyodide.FS.mkdirTree(dir);
            if (typeof content === 'string' && content.startsWith('\x00BIN\x00')) {
                // Base64-encoded binary (e.g. xlsx, pdf) — decode to Uint8Array before writing.
                // Strip any interior '=' (from legacy chunked encoding) before calling atob;
                // atob stops at the first interior '=', which would truncate the file.
                const s   = (content as string).slice(5).replace(/=/g, ''); // strip '\x00BIN\x00' + interior padding
                const pad = (4 - s.length % 4) % 4;
                const raw = atob(s + '='.repeat(pad));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                try { pyodide.FS.unlink(path); } catch {}
                pyodide.FS.writeFile(path, bytes);
            } else {
                let existing: string | null = null;
                try { existing = pyodide.FS.readFile(path, { encoding: 'utf8' }); } catch {}
                if (existing !== (content ?? '')) pyodide.FS.writeFile(path, content ?? '');
            }
        }

        // Remove IDBFS files not in the loaded files dict so stale data from prior
        // sessions doesn't bleed into the workspace or mask Python writes.
        purgeStale('/workspace', '', files);

        const before = snapshotDir('/workspace', '');

        // Determine the file's own directory so sibling modules are importable.
        const fileDir = data.filepath
            ? '/workspace/' + data.filepath.replace(/[^/]+$/, '').replace(/\/$/, '')
            : '/workspace';
        const workDir = fileDir || '/workspace';

        // Build the full set of sys.path entries needed:
        // • /workspace and workDir (already existed)
        // • every /workspace sub-directory that directly contains a .py file
        //   so that `import browser_display` works when the file lives at
        //   /workspace/stock_market_app/browser_display.py.
        const _sysPaths = new Set<string>(['/workspace', workDir]);
        for (const name of Object.keys(files || {})) {
            if (!name.endsWith('.py')) continue;
            const slash = name.lastIndexOf('/');
            if (slash > 0) _sysPaths.add('/workspace/' + name.slice(0, slash));
        }

        // Invalidate sys.modules entries for every workspace .py file so that
        // edits between execute_code calls aren't silently served from cache.
        // Both bare-name ("browser_display") and package-style ("app.utils")
        // forms are cleared so either import style gets a fresh load.
        const _wsModuleNames: string[] = [];
        for (const name of Object.keys(files || {})) {
            if (!name.endsWith('.py')) continue;
            const stem  = name.replace(/\.py$/, '');
            const parts = stem.split('/');
            _wsModuleNames.push(parts[parts.length - 1]);          // bare: browser_display
            if (parts.length > 1) _wsModuleNames.push(parts.join('.')); // pkg: stock_market_app.browser_display
        }

        await pyodide.runPythonAsync(`
import sys
for _p in ${JSON.stringify([..._sysPaths])}:
    if _p not in sys.path:
        sys.path.insert(0, _p)
# Clear cached workspace modules so edits take effect on re-import.
for _m in ${JSON.stringify(_wsModuleNames)}:
    for _k in [_k for _k in list(sys.modules.keys()) if _k == _m or _k.startswith(_m + '.')]:
        del sys.modules[_k]
`);

        let stdout: string = '';
        let stderr: string = '';
        pyodide.setStdout({ batched: s => { stdout += s + '\n'; } });
        pyodide.setStderr({ batched: s => { stderr += s + '\n'; } });

        try {
            await pyodide.loadPackagesFromImports(code);
        } catch (e) {
            stderr += `Warning: Could not load some built-in packages: ${e.message}\n`;
        }

        // Try micropip only for top-level imports that aren't already importable
        // AND don't correspond to a local .py file or package in the workspace.
        const imports = Array.from(new Set(
            code.match(/^(?:import|from)\s+(\w+)/gm)?.map(m => m.replace(/^(?:import|from)\s+/, '').split(/\s/)[0]) || []
        ));
        if (imports.length > 0) {
            const missing = await pyodide.runPythonAsync(`
import sys, importlib.util, os
def _is_local(name):
    for base in ['/workspace', ${JSON.stringify(workDir)}]:
        if os.path.exists(f'{base}/{name}.py') or os.path.isdir(f'{base}/{name}'):
            return True
    return False
[m for m in ${JSON.stringify(imports)} if importlib.util.find_spec(m) is None and not _is_local(m)]
`);
            const toInstall = missing?.toJs ? missing.toJs() : [];
            if (toInstall.length > 0) {
                try {
                    await pyodide.runPythonAsync(`
import micropip
await micropip.install(${JSON.stringify(toInstall)})
`);
                } catch (e) {
                    stderr += `Warning: Could not install ${toInstall.join(', ')}: ${e.message}\n`;
                }
            }
        }

        let exit_code: number = 0;
        try {
            // Force Agg backend before pyplot loads — wasm_backend requires `document` which
            // doesn't exist in a web worker, causing an ImportError at plt.subplots() time.
            let runCode: string = code;
            if (/\bimport\s+matplotlib\b|from\s+matplotlib\b/.test(code))
                runCode = 'import matplotlib\nmatplotlib.use("Agg")\n' + code;
            await pyodide.runPythonAsync(`import os\nos.chdir(${JSON.stringify(workDir)})\n` + runCode);
        } catch (e) {
            stderr += e.message + '\n';
            exit_code = 1;
        }

        const after = snapshotDir('/workspace', '');

        // Persist IDBFS changes (including deletions) back to IndexedDB.
        await syncfs(false);

        const changedFiles = {};
        for (const [name, content] of Object.entries(after)) {
            if (content !== before[name]) changedFiles[name] = content;
        }
        for (const name of Object.keys(before)) {
            if (!(name in after)) changedFiles[name] = null; // deleted
        }

        self.postMessage({
            type: 'result', id,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exit_code,
            changedFiles
        });
    } catch (e) {
        self.postMessage({ type: 'result', id, stdout: '', stderr: e.message, exit_code: 1, changedFiles: {} });
    }
};

init();
