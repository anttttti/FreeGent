#!/usr/bin/env bash
# Prerequisites: curl, make and Python 3. Lua uses the existing WASI Worker.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 2 -o "$work/sdk.tgz" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz
curl -fL --retry 2 -o "$work/source.tgz" https://www.lua.org/ftp/lua-5.3.6.tar.gz
printf '%s  %s\n' b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2 "$work/sdk.tgz" fc5fd69bb8736323f026672b1b7235da613d7177e72558893a0bdcd320466d60 "$work/source.tgz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
tar -xf "$work/source.tgz" -C "$work"
python3 - "$work/lua-5.3.6/src/loslib.c" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
source = path.read_text()
old = '#if defined(LUA_USE_POSIX)\t/* { */\n\n#include <unistd.h>\n\n#define LUA_TMPNAMBUFSIZE'
new = '''#if defined(__wasi__)
#define LUA_TMPNAMBUFSIZE 32
extern int shiro_lua_tmpname(char *name);
#define lua_tmpnam(b,e) { int fd = shiro_lua_tmpname(b); e = (fd < 0); if (fd >= 0) close(fd); }
#include <unistd.h>
#elif defined(LUA_USE_POSIX)\t/* { */

#include <unistd.h>

#define LUA_TMPNAMBUFSIZE'''
assert source.count(old) == 1
path.write_text(source.replace(old, new))
path = path.parent / 'lua.c'
source = path.read_text()
old = '#if defined(LUA_USE_POSIX)\t/* { */'
assert source.count(old) == 1
path.write_text(source.replace(old, '#if defined(LUA_USE_POSIX) || defined(__wasi__)\t/* { */'))
PY
sdk="$work/wasi-sdk-27.0-x86_64-linux"
"$sdk/bin/clang" -O2 -c "$repo/scripts/wasi-artifacts/lua-wasi.c" -o "$work/lua-5.3.6/src/lua-wasi.o"
"$sdk/bin/clang" -O2 -c "$repo/scripts/wasi-artifacts/wasi-process.c" -o "$work/lua-5.3.6/src/wasi-process.o"
"$sdk/bin/clang" -O2 -c "$repo/scripts/wasi-artifacts/sdk-cwd.c" -o "$work/lua-5.3.6/src/sdk-cwd.o"
make -C "$work/lua-5.3.6/src" generic \
  CC="$sdk/bin/clang" AR="$sdk/bin/llvm-ar rcu" RANLIB="$sdk/bin/llvm-ranlib" \
  MYCFLAGS='-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false' \
  MYLDFLAGS='-lwasi-emulated-signal -lwasi-emulated-process-clocks -lsetjmp -Wl,-z,stack-size=1048576' MYLIBS='lua-wasi.o wasi-process.o sdk-cwd.o'
printf '%s  %s\n' 0c4b3ce2fd473db00ec01dd08eef759c2fee91ee564c8c6a229280d08be7ffb1 "$work/lua-5.3.6/src/lua" | sha256sum -c -
cp "$work/lua-5.3.6/src/lua" public/shiro/wasm/lua-5.3.6.wasm
python3 - "$work/lua-5.3.6/src/lua.h" public/shiro/wasm/LUA-LICENSE <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.rindex('* Copyright (C) 1994-2020')
end = source.index('******************************************************************************/', start)
lines = source[start:end].splitlines()
pathlib.Path(sys.argv[2]).write_text('\n'.join(line[2:] if line.startswith('* ') else line[1:] if line.startswith('*') else line for line in lines) + '\n')
PY
