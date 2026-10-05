#!/usr/bin/env bash
# Prerequisites: curl, make, a native C compiler and ed (upstream bytecode generator).
# bc and dc share upstream source and one build recipe, with ordinary separate CLIs.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 2 -o "$work/sdk.tgz" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz
curl -fL --retry 2 -o "$work/source.tgz" https://ftp.gnu.org/gnu/bc/bc-1.07.1.tar.gz
printf '%s  %s\n' b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2 "$work/sdk.tgz" 62adfca89b0a1c0164c2cdca59ca210c1d44c3ffc46daf9931cf4942664cb02a "$work/source.tgz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
tar -xf "$work/source.tgz" -C "$work"
mkdir "$work/native"
tar -xf "$work/source.tgz" -C "$work/native" --strip-components=1
# Cross-compiling upstream must not attempt to execute a target fbc. Generate
# the math-library bytecode with the same upstream compiler on the build host.
(cd "$work/native" && ./configure --disable-nls --without-readline CC=cc CFLAGS=-O2 && make -j4 SUBDIRS='lib bc dc')
sdk="$work/wasi-sdk-27.0-x86_64-linux"
"$sdk/bin/clang" -O2 -c "$repo/scripts/wasi-artifacts/sdk-cwd.c" -o "$work/sdk-cwd.o"
"$sdk/bin/clang" -O2 -c "$repo/scripts/wasi-artifacts/wasi-process.c" -o "$work/wasi-process.o"
(cd "$work/bc-1.07.1" && ./configure --host=wasm32-wasi --disable-nls --without-readline \
  CC="$sdk/bin/clang" AR="$sdk/bin/llvm-ar" RANLIB="$sdk/bin/llvm-ranlib" \
  CFLAGS='-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false' \
  LDFLAGS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lsetjmp -Wl,-z,stack-size=1048576 $work/sdk-cwd.o $work/wasi-process.o")
# Build the objects that upstream declares as dependencies of libmath.h, then
# install the build-host-generated header so its target generator is not run.
make -C "$work/bc-1.07.1/lib" -j4
make -C "$work/bc-1.07.1/bc" -j4 main.o bc.o scan.o execute.o load.o storage.o util.o warranty.o
cp "$work/native/bc/libmath.h" "$work/bc-1.07.1/bc/libmath.h"
make -C "$work/bc-1.07.1" -j4 SUBDIRS='lib bc dc'
printf '%s  %s\n' f2da8c5f7a05fbb76a90f745835abf343f88c908873f99953972ba855960d8ca "$work/bc-1.07.1/bc/bc" 29d781630c8f34cb8d9ead76d9e9a275c0979c622350d565a357f517bf2d2b14 "$work/bc-1.07.1/dc/dc" | sha256sum -c -
cp "$work/bc-1.07.1/bc/bc" public/shiro/wasm/bc-1.07.1.wasm
cp "$work/bc-1.07.1/dc/dc" public/shiro/wasm/dc-1.07.1.wasm
cp "$work/bc-1.07.1/COPYING" public/shiro/wasm/BC-COPYING
