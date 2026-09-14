// editor.js — FreeGent: lazy-loaded CodeMirror 6 editor for file tabs
// Loaded dynamically on first file open, not at page startup.

let _cmPromise: Promise<{ basicSetup: any; EditorView: any; EditorState: any; langJS: any; langPY: any; langHTML: any; langCSS: any; langMD: any; langJSON: any }> | null = null;

// Load CodeMirror 6 and language packs once, cache the promise.
function _loadCM() {
    if (_cmPromise) return _cmPromise;
    _cmPromise = (async () => {
        // ?deps= pins all lang packs to the same @codemirror/* versions as basic-setup,
        // ensuring one module instance per package (avoids duplicate-extension errors).
        const BASE = 'https://esm.sh';
        // basic-setup is versioned as 0.x, not @6; pin @lezer/highlight@1 to avoid mismatches.
        const DEPS = '?deps=@codemirror/state@6,@codemirror/view@6,@codemirror/language@6,@lezer/highlight@1';
        const [view, state, setup, js, py, htm, cssMod, md, json] = await Promise.all([
            import(/* @vite-ignore */ `${BASE}/@codemirror/view@6`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/state@6`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/basic-setup@0.7${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-javascript@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-python@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-html@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-css@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-markdown@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-json@6${DEPS}`),
        ]);
        return {
            basicSetup: setup.basicSetup,
            EditorView:  view.EditorView,
            EditorState: state.EditorState,
            langJS:   js.javascript,
            langPY:   py.python,
            langHTML: htm.html,
            langCSS:  cssMod.css,
            langMD:   md.markdown,
            langJSON: json.json,
        };
    })().catch(err => { _cmPromise = null; throw err; }); // reset on failure so next open retries
    return _cmPromise;
}

function _pickLanguage(filename, mods) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (['js','mjs','cjs'].includes(ext))       return mods.langJS();
    if (['ts','tsx'].includes(ext))              return mods.langJS({ typescript: true });
    if (['jsx'].includes(ext))                   return mods.langJS({ jsx: true });
    if (ext === 'py')                            return mods.langPY();
    if (['html','htm'].includes(ext))            return mods.langHTML();
    if (ext === 'css')                           return mods.langCSS();
    if (ext === 'md')                            return mods.langMD();
    if (ext === 'json')                          return mods.langJSON();
    return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

// Returns the EditorView, or null if CM fails to load (falls back to plain <pre>).
// Options: onSave(content), onChange(content), readOnly (bool)
async function createEditor(container, filename, content, { onSave, onChange, readOnly = false }: { onSave?: (content: string) => void; onChange?: (content: string) => void; readOnly?: boolean } = {}) {
    let mods: Awaited<ReturnType<typeof _loadCM>>;
    try {
        mods = await _loadCM();
    } catch (err) {
        const pre = document.createElement('pre');
        pre.className = 'file-panel-pre';
        pre.textContent = content;
        container.appendChild(pre);
        console.warn('[editor] CodeMirror failed to load, using plain viewer:', err.message);
        return null;
    }

    const { EditorView, EditorState, basicSetup } = mods;
    if (!EditorView) throw new Error('EditorView not loaded — check CDN/network');
    const lang = _pickLanguage(filename, mods);

    const extensions = [
        basicSetup,
        EditorView.lineWrapping,
        ...(lang ? [lang] : []),
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
    ];

    if (onSave) {
        extensions.push(EditorView.domEventHandlers({
            keydown(event, view) {
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                    event.preventDefault();
                    onSave(view.state.doc.toString());
                    return true;
                }
            }
        }));
    }

    if (onChange) {
        extensions.push(EditorView.updateListener.of(update => {
            if (update.docChanged) onChange(update.view.state.doc.toString());
        }));
    }

    const view = new EditorView({
        state: EditorState.create({ doc: content, extensions }),
        parent: container,
    });

    return view;
}

function setEditorContent(view, content) {
    if (!view) return;
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content }
    });
}

Object.assign(window, { createEditor, setEditorContent });

