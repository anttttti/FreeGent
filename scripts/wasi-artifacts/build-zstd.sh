#!/usr/bin/env bash
# Reproduce the shipped single-thread WASI CLI from pinned upstream source and SDK.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 2 -o "$work/sdk.tgz" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-linux.tar.gz
curl -fL --retry 2 -o "$work/source.tgz" https://github.com/facebook/zstd/archive/refs/tags/v1.4.8.tar.gz
printf '%s  %s\n' c6c38aab56e5de88adf6c1ebc9c3ae8da72f88ec2b656fb024eda8d4167a0bc5 "$work/sdk.tgz" f176f0626cb797022fbf257c3c644d71c1c747bb74c32201f9203654da35e9fa "$work/source.tgz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
tar -xf "$work/source.tgz" -C "$work"
# WASI has no ownership setter. Disable only that best-effort metadata copy;
# compression algorithms and CLI output are unchanged.
python3 - "$work/zstd-1.4.8/programs/util.c" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
source = path.read_text()
old = '#if !defined(_WIN32)\n    res += chown'
assert source.count(old) == 1
path.write_text(source.replace(old, '#if !defined(_WIN32) && !defined(__wasi__)\n    res += chown'))
PY
"$work/wasi-sdk-24.0-x86_64-linux/bin/clang" -O2 -c scripts/wasi-artifacts/sdk-cwd.c -o "$work/sdk-cwd24.o"
make -C "$work/zstd-1.4.8/programs" zstd \
  CC="$work/wasi-sdk-24.0-x86_64-linux/bin/clang" \
  HAVE_THREAD=0 HAVE_ZLIB=0 HAVE_LZMA=0 HAVE_LZ4=0 BACKTRACE=0 \
  CFLAGS='-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS' \
  LDFLAGS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -Wl,-z,stack-size=1048576 $work/sdk-cwd24.o"
printf '%s  %s\n' a969524aea789aa933186008c12f4ff3031e07292b3ca9dc500941c3fa837a9d "$work/zstd-1.4.8/programs/zstd" | sha256sum -c -
cp "$work/zstd-1.4.8/programs/zstd" public/shiro/wasm/zstd-1.4.8.wasm
cp "$work/zstd-1.4.8/LICENSE" public/shiro/wasm/ZSTD-LICENSE
cp "$work/zstd-1.4.8/COPYING" public/shiro/wasm/ZSTD-COPYING
