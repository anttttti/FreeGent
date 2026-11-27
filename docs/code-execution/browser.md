# Browser sandboxes

On freegent.ai all code the agent writes runs inside your browser, never on a server. JavaScript, Python and the WASM shell run in a hidden `<iframe sandbox="allow-scripts">` with an opaque origin. Code there cannot read your API keys, chats, the page's DOM or the dev-server token. It sees project files only through a small set of file operations that the page carries out for it.

## What each language can do

- **JavaScript** runs in a Worker inside the frame, so a tight loop cannot freeze the page. There is no DOM or canvas and no npm packages (use bash with `npm` and `node` for those), but `await tool(name)` loads one of the [processing programs](#processing-programs). For anything visual the agent writes a self-contained HTML file and checks it with `check_page`.
- **Python** runs in Pyodide. Pure-Python packages install with `micropip`; packages with C extensions work only if Pyodide ships a build of them, as it does for NumPy, pandas, Matplotlib and many others.
- **Bash** runs in a bash-compatible shell written in TypeScript that runs in the browser. It implements 248 of the most common bash commands, builtins and keywords: `grep`, `sed`, `awk`, `find`, `sort`, `tr` and similar. About 40 of them (such as `jq`, `bc`, `lua`, `sqlite` and `ruby`) are WebAssembly packages that download on first use. It can install npm and pip packages into the project (`npm install`, `pip install`) and run them with `node` and `python3`; `python3` loads the packages Pyodide ships (NumPy, Pillow and others) for the imports of the program, as the Python tool does. There is no system package manager such as `apt`, and nothing outside the project to install into.

## Network

`fetch()`, `curl` and `wget` reach sites that allow cross-origin requests directly, and other sites as a plain GET through FreeGent's proxy. Python `requests` and `urllib` do not work in Pyodide; the agent uses the `fetch_url` tool instead.

## Processing programs

Heavier programs are fetched on first use from a pinned version on a public CDN, checked against a SHA-256 before anything runs, and kept by the browser's HTTP cache. They are the programs' own releases (ffmpeg and pandoc-class tools are GPL): FreeGent does not host them. Single-thread builds only: the frame has no cross-origin isolation.

| Where | What |
|---|---|
| Bash | `ffmpeg`, `ffprobe` (H.264, VP8, MPEG-4, Theora, GIF, PNG, WebP; mp3, aac, opus, vorbis, flac), `duckdb` (SQL on CSV, JSON and Parquet files), `tesseract` (OCR, English). Files are read and written by path. |
| JavaScript | `await tool("pdf-lib" \| "mammoth" \| "xlsx" \| "jszip" \| "sql.js" \| "duckdb" \| "tesseract" \| "ffmpeg")` returns the library or a small API. |
| Python | Pyodide's own packages (`pymupdf`, `opencv-python`, `soundfile`, `lxml`, `scipy`, `pandas` and others) and pure-Python wheels that install on import (`python-docx`, `openpyxl`, `pypdf`, `python-pptx`, `reportlab`). |

Not available: pandoc, LibreOffice, ImageMagick; DuckDB, polars and pyarrow in Python; VP9, HEVC and AV1 encoding. ffmpeg's JPEG encoder needs `-strict unofficial`. At the Local privacy level the frame may reach only these pinned directories, Pyodide and 7-Zip.
