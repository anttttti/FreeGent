# rev and hexdump 2.37.2 WASI builds

The two commands use upstream util-linux 2.37.2 sources, with GNU getopt from
GNU sed 4.8, wasi-sdk 27, and the existing FreeGent WASI Worker host. Their native
reference is util-linux 2.37.2. They do not introduce another execution engine.

`scripts/wasi-artifacts/build-util-linux.sh` verifies source/toolchain hashes and
both output pins. Two builds in independently extracted directories produced
identical binaries. The focused corpus compares raw stdout/stderr, exit codes
and file effects for Unicode, binary input, offsets, formats and errors.

## Port changes

- Initialize libc's program invocation names from the real argv.
- Exclude unused hostname/credential helpers whose headers are absent in WASI.
- Skip a debug-only setuid check: WASI processes have capabilities, not setuid.
- Use gnulib's single-thread stdio branch and its upstream option parser.
- Propagate the real EILSEQ result from musl's wide-character input API.
- Delegate dup to the existing WASIX fd_dup capability; validate fileno using
  WASI fd_fdstat_get after a failed freopen. No descriptor result is fabricated.
- Use a shared C-locale strerror adapter. Its differences were measured for every
  named wasi-libc errno against native glibc; byte streams are never rewritten.
- Initialize libc cwd from authoritative PWD with one root preopen.

The archive `util-linux-2.37.2-fg1-source.tar.xz`, served beside the binaries,
contains original util-linux/sed source archives, every port/build file, and this
record. To rebuild after extraction, use:

```sh
FG_UTIL_LINUX_SOURCE="$PWD/upstream/util-linux-2.37.2.tar.xz" \
FG_SED_SOURCE="$PWD/upstream/sed-4.8.tar.xz" \
scripts/wasi-artifacts/build-util-linux.sh ./output
```

The script downloads and verifies the pinned SDK. `FG_WASI_SDK_ARCHIVE` can select
an already downloaded archive; it is still hash checked. Runtime resource quotas,
full malformed-input auditing and whole-plan acceptance remain open.

## Licenses

Retained source notices are in `UTIL-LINUX-NOTICES`; full GNU GPL 3, LGPL 2.1 and
Berkeley license texts are supplied alongside the artifacts. GNU getopt is GPL
3 or later; util-linux helpers include LGPL code. The combined binaries are
redistributed under GPL 3 or later, with corresponding source and build changes.
Original Berkeley notices are retained. The 1999 Berkeley addendum removes the
advertising clause from affected Berkeley source, as recorded by the
[FreeBSD copyright archive](https://www.freebsd.org/copyright/license/).
This product includes software developed by the University of California,
Berkeley and its contributors.

wasi-libc/musl and compiler runtime license texts are also supplied. The SDK 27
wasi-libc source commit is `3f7eb4c7d6ede4dde3c4bffa6ed14e8d656fe93f`;
`sdk27-licenses.json` retains immutable URLs and hashes. See the
[wasi-sdk project](https://github.com/WebAssembly/wasi-sdk) and
[wasi-libc license](https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE).
The SDK distribution is a build dependency, not an application runtime loader.
