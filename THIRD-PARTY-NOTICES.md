# Third-party notices

FreeGent's own code is MIT licensed (see [LICENSE](LICENSE)). It builds on, loads or distributes the software below. Each project keeps its own license; the full texts are in the linked files, in the upstream projects, and in `node_modules` after `npm install`.

## Shiro

The in-browser bash-compatible shell (`shiro/`) is based on [Shiro](https://github.com/williamsharkey/shiro) by William Sharkey, which declares an MIT license in its README. FreeGent extends it with WebAssembly package support and with argument handling and output checked byte for byte against real bash (see [Code execution](docs/code-execution/index.md)).

## Libraries the web app loads from a CDN

Loaded at pinned versions from jsDelivr or esm.sh. The scripts and styles in `index.html` carry Subresource Integrity hashes.

| Library | Version | License |
|---|---|---|
| [Bootstrap](https://getbootstrap.com/) | 5.3.0 | MIT |
| [marked](https://github.com/markedjs/marked) | 4.3.0 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 2.5.7 | Apache-2.0 or MPL-2.0 |
| [highlight.js](https://highlightjs.org/) | 10.7.3 and 11.9.0 (styles) | BSD-3-Clause |
| [KaTeX](https://katex.org/) | 0.16.47 | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.12.3 | BSD-2-Clause |
| [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | 2.16.105 | Apache-2.0 |
| [Turndown](https://github.com/mixmark-io/turndown) | 7.2.4 | MIT |
| [SheetJS Community Edition](https://sheetjs.com/) (`xlsx`) | 0.18.5 | Apache-2.0 |
| [CodeMirror 6](https://codemirror.net/) (basic-setup and language packs, via esm.sh) | see `editor.ts` | MIT |
| [diff](https://www.npmjs.com/package/diff) (jsdiff, via esm.sh) | 7 | BSD-3-Clause |
| [7-Zip](https://www.7-zip.org/) through [7z-wasm](https://www.npmjs.com/package/7z-wasm) | 1.2.0 | LGPL-2.1-or-later, with the unRAR restriction described in 7-Zip's license |
| [Pyodide](https://pyodide.org/) (CPython for WebAssembly) | 0.28.3 | MPL-2.0. CPython is under the PSF license; Python packages loaded with `micropip` keep their own licenses. |

## Packages for the terminal and CLI

The TUI, CLI and dev server (`npm install`) use these runtime dependencies and their own dependencies.

| Package | License |
|---|---|
| [diff](https://www.npmjs.com/package/diff) | BSD-3-Clause |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | Apache-2.0 |
| [ink](https://github.com/vadimdemedes/ink) | MIT |
| [jsdom](https://github.com/jsdom/jsdom) | MIT |
| [node-inspect-extracted](https://github.com/hildjj/node-inspect-extracted) | MIT |
| [React](https://react.dev/) | MIT |
| [tsx](https://github.com/privatenumber/tsx) | MIT |

Build and test tools (Vite, TypeScript, Vitest, VitePress, Playwright and others) are used during development and are not part of what FreeGent distributes.

## WebAssembly programs served with the app

These are built from the upstream sources by the scripts in `scripts/wasi-artifacts/` and served from `public/shiro/wasm/`, together with their license texts. Their hashes are pinned in `shiro/wasi-artifact-pins.ts`.

| Program | Version | License | Source |
|---|---|---|---|
| jq (with Oniguruma) | 1.8.2 | MIT (Oniguruma: BSD-2-Clause) | <https://github.com/jqlang/jq>; `JQ-COPYING`, `ONIGURUMA-COPYING` |
| Lua | 5.3.6 | MIT | <https://www.lua.org/>; `LUA-LICENSE` |
| Zstandard | 1.4.8 | BSD-3-Clause or GPL-2.0-only | <https://github.com/facebook/zstd>; `ZSTD-LICENSE`, `ZSTD-COPYING` |
| bc and dc | 1.07.1 | GPL-3.0-or-later | <https://ftp.gnu.org/gnu/bc/bc-1.07.1.tar.gz>; build recipe `scripts/wasi-artifacts/build-bc.sh`; `BC-COPYING` |
| hexdump and rev (util-linux) | 2.37.2 | GPL-3.0-or-later, with BSD and LGPL-2.1-or-later components | Source archive `util-linux-2.37.2-fg1-source.tar.xz` served beside the binaries; `UTIL-LINUX-SOURCE.md`, `UTIL-LINUX-NOTICES` |
| cal | 12.1.7 | BSD-2-Clause | `CAL-LICENSE` |
| cowsay | 0.3.0 | MIT (cow artwork: Artistic or GPL, see `COW-ASSETS-LICENSE`) | <https://github.com/wapm-packages/cowsay>; `COWSAY-LICENSE`, `COW-ARTISTIC` |

All of them are linked with [wasi-libc](https://github.com/WebAssembly/wasi-libc) (Apache-2.0 with LLVM exception, Apache-2.0, MIT, and BSD-style components); see the `WASI-LIBC-*` files in the same directory.

## WebAssembly packages downloaded on first use

Other programs behind the in-browser shell are not distributed by FreeGent. Your browser downloads them from `cdn.wasmer.io` (and `uutils.org` for the coreutils build) the first time a command needs one, checks them against pinned hashes, and caches them in IndexedDB. They are the work of their own authors and carry their own licenses: uutils coreutils (MIT), GNU grep and sed (GPL-3.0-or-later), GNU bash (GPL-3.0-or-later), dash, QuickJS, SQLite, ruby.wasm (MIT), PHP, OpenSSL, brotli, uuid (MIT), qr2text (MIT), viu, optipng, wabt, fortune, lolcat and figlet. The license annotations recorded in each container are kept in `shiro/wasi-artifact-pins.ts`; where a container records none, the upstream project's license applies (see `scripts/wasi-artifacts/README.md`).

## Services

FreeGent calls the model providers and search services you configure. Their terms apply to your use of them; none of their software is included.
