#!/usr/bin/env bash
# Prerequisites: curl, make and Python 3. No jq parser/regex patches are carried.
# jq 1.8.2 includes the upstream security fixes through June 2026.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 2 -o "$work/sdk.tgz" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz
curl -fL --retry 2 -o "$work/source.tgz" https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-1.8.2.tar.gz
printf '%s  %s\n' b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2 "$work/sdk.tgz" 71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af "$work/source.tgz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
tar -xf "$work/source.tgz" -C "$work"
sdk="$work/wasi-sdk-27.0-x86_64-linux"
"$sdk/bin/clang" -O2 -c scripts/wasi-artifacts/sdk-cwd.c -o "$work/sdk-cwd27.o"
# Select single-thread libc's pthread primitives without -pthread/shared memory.
# GNU feature declarations enable the real secure arc4random/getentropy APIs;
# otherwise configure can miss them and select a predictable time/PID seed.
(cd "$work/jq-1.8.2" && export PATH="$sdk/bin:$PATH" && ./configure --host=wasm32-wasi --disable-shared --disable-docs --disable-maintainer-mode --with-oniguruma=builtin \
  CC=clang AR=llvm-ar RANLIB=llvm-ranlib PTHREAD_LIBS=-lpthread \
  CFLAGS='-O2 -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID' \
  LDFLAGS='-lwasi-emulated-signal -lwasi-emulated-getpid -Wl,-z,stack-size=1048576' && \
  make -j4 jq_LDFLAGS="-static-libtool-libs $work/sdk-cwd27.o")
printf '%s  %s\n' 162db948e4432c35849670c36ab09127880d2b808c63fd796207d0e25b11d552 "$work/jq-1.8.2/jq" | sha256sum -c -
cp "$work/jq-1.8.2/jq" public/shiro/wasm/jq-1.8.2.wasm
cp "$work/jq-1.8.2/COPYING" public/shiro/wasm/JQ-COPYING
cp "$work/jq-1.8.2/vendor/oniguruma/COPYING" public/shiro/wasm/ONIGURUMA-COPYING
