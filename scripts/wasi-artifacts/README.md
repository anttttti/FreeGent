# Pinned WASI artifacts

`generate.mjs` downloads the exact URLs in `shiro/wasi-packages.ts` and reads their
named atoms, filesystem mappings, package annotations and resource files with
upstream `webc` 10.0.1. `Cargo.lock` pins the inspector's dependencies. Rust is a
development tool for this audit; no Rust or WebC decoder ships in the browser.

Run from the repository root with a stable Rust toolchain:

```bash
npx tsx scripts/wasi-artifacts/generate.mjs /tmp/reviewed-pins.ts
diff -u shiro/wasi-artifact-pins.ts /tmp/reviewed-pins.ts
```

Review the atom names, aliases, resources, imports and licenses before adopting
an updated pin file. Runtime offsets are trusted only after both the complete
container length and SHA-256 match. Individual atoms are also hashed and
validated before compilation. Cache keys include package version and container
hash; aliases share a compiled entry only when they select the same atom.

Name-only legacy caches contain guessed atoms without provenance or resource
volumes. They are not reused or advertised as current installations. Removal
discards those records as well as all current compiled entries for the artifact.

`upstream` records the package's own license/source annotations, without guessing
missing information. Packages with missing or vague license annotations still
need a source/license audit before new distribution or migration acceptance.

## Raw uutils artifact

The explicit coreutils package uses the raw multicall artifact published at
`https://uutils.org/wasm/uutils.wasm`. Its URL is mutable, so the manifest version
is the audited source commit `a6d1eb3835c0f808fa9678e4551df7377bcab8d3` and the
runtime rejects any different binary. The recorded artifact is 12,964,555 bytes,
SHA-256 `c53b61ad7d6f3b1231b8c38d8d9566ec649b0ba0b8da9d7952d1825886efc927`.
The pin records the MIT source/license, `wasm32-wasip1` target and `feat_wasm`
build feature from the upstream publication metadata. This is an audited
download, not a claim that FreeGent has reproduced that build locally.

`generate.mjs` verifies raw downloads against their existing reviewed pins;
WebC inspection applies only to containers. Review updated upstream source,
publication metadata, imports, applet coverage and distribution requirements
before adopting a new raw pin. Changes to the URL alone never update the
accepted hash. Explicit applet argv mappings live in the package manifest;
passing those alternatives does not activate normal command family migrations.

## Reproducible CLI builds and executable loader integrity

`build-jq.sh`, `build-zstd.sh`, `build-lua.sh`, `build-bc.sh`, `build-cal.sh`
and `build-cowsay.sh` check pinned source/toolchain downloads and their resulting
artifact hashes before replacing public assets. Their compiler/platform notes,
source hashes and limitations are recorded in `ARTIFACT_PINS`. License notices
are shipped beside raw artifacts. The recipes require native development tools;
those tools are not browser command dependencies.

jq selects 1.8.2 after auditing the upstream 1.6 security issues. Compiler names
in its embedded build-configuration string are stable, with the verified SDK
first on PATH throughout configure and make. GNU feature declarations select
real WASI secure entropy rather than a time/PID fallback. The native fixture
binary is independently pinned by `bench/dev-tests/log-replay/native-tools.json`;
prepare it with `python3 bench/dev-tests/log-replay/native-tools.py --prepare`.
References bind that binary read-only at `/usr/bin/jq` inside bubblewrap;
the host installation is untouched. Prior 1.6 measurements are retained.

`SEVENZIP_ASSET_PINS` also records both Emscripten JS loaders and WASM for
7z-wasm 1.2.0. The browser verifies JS and WASM before importing a Blob module
inside the opaque frame. Node parity helpers verify the corresponding UMD
loader before loading it. No executable loader is imported before integrity
validation. Source/dependency audits, licensing provenance, full cancellation
and resource limits are separate gates; hashing is not a security proof.

## util-linux rev and hexdump

`build-util-linux.sh` builds the upstream 2.37.2 sources with the same GNU getopt
semantics as the native reference, using the pinned GNU sed 4.8 source and SDK 27.
Two independent builds and a third finalized recipe reproduce the rev and hexdump
hashes. Shared libc adapters handle descriptors and C-locale diagnostics; algorithms
remain upstream. Both active command routes use generic catalog package adapters.
The permanent corpus includes Unicode, invalid encoding, binary input, offsets,
formats, multiple files and failures, comparing raw bytes against two native runs.

The source archive and license notices are served alongside the WASM files;
[UTIL-LINUX-SOURCE.md](../../public/shiro/wasm/UTIL-LINUX-SOURCE.md) records build
changes, dependencies and distribution information. No complete security audit
or resource-quota acceptance is claimed.
