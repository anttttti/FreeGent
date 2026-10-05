#!/usr/bin/env bash
# Reproducible upstream rev/hexdump CLIs; one shared WASI runtime, no multicall fork.
# Optional verified local archives avoid repeated downloads. Argument: output directory.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
out=${1:-public/shiro/wasm}
mkdir -p "$out"
out=$(realpath "$out")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive() {
  local cached=$1 url=$2 dest=$3
  if [ -n "$cached" ]; then cp "$cached" "$dest"; else curl -fL --retry 2 -o "$dest" "$url"; fi
}
archive "${FG_WASI_SDK_ARCHIVE:-}" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz "$work/sdk.tgz"
archive "${FG_UTIL_LINUX_SOURCE:-}" https://www.kernel.org/pub/linux/utils/util-linux/v2.37/util-linux-2.37.2.tar.xz "$work/util-linux.tar.xz"
archive "${FG_SED_SOURCE:-}" https://ftp.gnu.org/gnu/sed/sed-4.8.tar.xz "$work/sed.tar.xz"
printf '%s  %s\n' b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2 "$work/sdk.tgz" 6a0764c1aae7fb607ef8a6dd2c0f6c47d5e5fd27aa08820abaad9ec14e28e9d9 "$work/util-linux.tar.xz" f79b0cfea71b37a8eeec8490db6c5f7ae7719c35587f21edb0617f370eeff633 "$work/sed.tar.xz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
tar -xf "$work/util-linux.tar.xz" -C "$work"
tar -xf "$work/sed.tar.xz" -C "$work"
sdk="$work/wasi-sdk-27.0-x86_64-linux"
src="$work/util-linux-2.37.2"
mkdir "$work/port" "$work/getopt"
cp scripts/wasi-artifacts/{sdk-cwd.c,bsd-errors.c,gnu-errors.c,util-linux-stdio.c,util-linux-stdio.h} "$work/port/"
cp "$work/sed-4.8/lib/"{getopt.c,getopt1.c,getopt_int.h,gettext.h} "$work/getopt/"
python3 - "$src" "$work/getopt" <<'PY'
from pathlib import Path
import sys
root, getopt = map(Path, sys.argv[1:])
p = root / 'config/config.sub'
s = p.read_text(); assert '| midnightbsd*)' in s
p.write_text(s.replace('| midnightbsd*)', '| midnightbsd* | wasi*)'))
p = root / 'include/c.h'; s = p.read_text().replace('#include <grp.h>', '#ifndef __wasi__\n#include <grp.h>\n#endif')
a = s.index('static inline size_t get_hostname_max('); b = s.index('/*\n * The usleep function', a)
p.write_text(s[:a] + '#ifndef __wasi__\n' + s[a:b] + '#endif\n\n' + s[b:])
p = root / 'include/xalloc.h'; s = p.read_text(); a = s.index('static inline\n__attribute__((warn_unused_result))\nchar *xgethostname('); b = s.index('\n#endif', a)
p.write_text(s[:a] + '#ifndef __wasi__\n' + s[a:b] + '\n#endif\n' + s[b:])
# WASI capabilities have no setuid/setgid executables; skip this debug-only UID check.
p = root / 'include/debug.h'; p.write_text(p.read_text().replace('getuid() != geteuid() || getgid() != getegid()', '0 /* WASI has no setuid/setgid executables */'))
for name in ['rev.c', 'hexdump.c']:
    p = root / 'text-utils' / name; s = p.read_text(); a = s.index('int main('); b = s.index('{', a) + 1
    s = s[:b] + '''
\t/* wasi-libc exposes these names but does not initialize them from argv. */
\tprogram_invocation_name = argv[0];
\tprogram_invocation_short_name = strrchr(argv[0], '/');
\tprogram_invocation_short_name = program_invocation_short_name ? program_invocation_short_name + 1 : argv[0];
''' + s[b:]
    if name == 'rev.c':
        # musl reports EILSEQ without the glibc stream error indicator.
        s = s.replace('\t\tline = 0;', '\t\tline = 0;\n\t\terrno = 0;', 1).replace('if (ferror(fp)) {', 'if (ferror(fp) || errno == EILSEQ) {', 1)
    p.write_text(s)
# Use gnulib's existing single-thread stdio branch; WASI has no flockfile here.
p = getopt / 'getopt.c'; s = p.read_text().replace('|| (defined _WIN32 && ! defined __CYGWIN__))', '|| (defined _WIN32 && ! defined __CYGWIN__) \\\n      || (defined __wasi__ && ! defined _REENTRANT))'); p.write_text(s)
PY
(export PATH="$sdk/bin:$PATH"; cd "$src"; ./configure --host=wasm32-unknown-wasi --disable-all-programs \
  --without-ncurses --without-tinfo --without-readline --disable-nls \
  --disable-libblkid --disable-libmount --disable-libuuid --without-udev \
  CC=clang AR=llvm-ar RANLIB=llvm-ranlib \
  CFLAGS='-O2 -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID' \
  LDFLAGS='-lwasi-emulated-signal -lwasi-emulated-getpid -Wl,-z,stack-size=1048576')
common=(-O2 -D_GNU_SOURCE -DWASI_BSD_EXTENDED -D_GL_UNUSED='__attribute__((__unused__))' -D__getopt_argv_const=const
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -DHAVE_CONFIG_H
  -include "$src/config.h" -include "$work/port/util-linux-stdio.h" -I "$src/include" -I "$src"
  "-ffile-prefix-map=$src=." "-ffile-prefix-map=$work/getopt=gnu-getopt")
glue=("$work/port/sdk-cwd.c" "$work/port/bsd-errors.c" "$work/port/gnu-errors.c" "$work/port/util-linux-stdio.c"
  "$work/getopt/getopt.c" "$work/getopt/getopt1.c")
link=(-lwasi-emulated-signal -lwasi-emulated-getpid -Wl,-z,stack-size=1048576 -Wl,--wrap=fileno -Wl,--wrap=strerror)
"$sdk/bin/clang" "${common[@]}" "$src/text-utils/rev.c" "${glue[@]}" "${link[@]}" -o "$work/rev.wasm"
"$sdk/bin/clang" "${common[@]}" "$src/text-utils/"{hexdump.c,hexdump-conv.c,hexdump-display.c,hexdump-parse.c} \
  "$src/lib/"{strutils.c,colors.c,color-names.c,strv.c} "${glue[@]}" "${link[@]}" -o "$work/hexdump.wasm"
printf '%s  %s\n' f16932cc2f3946a997e6d725042dd8a4bf1da4a7c915632d1c9156f8dfbb4bf5 "$work/rev.wasm" c1d430c483e6b256adf55398ae5bbe24dc920f5a3f87660ed76733f325453381 "$work/hexdump.wasm" | sha256sum -c -
cp "$work/rev.wasm" "$out/rev-2.37.2.wasm"
cp "$work/hexdump.wasm" "$out/hexdump-2.37.2.wasm"
cp "$work/sed-4.8/COPYING" "$out/UTIL-LINUX-GETOPT-GPL3-COPYING"
for license in BSD-3-Clause BSD-4-Clause-UC LGPL-2.1-or-later; do
  cp "$src/Documentation/licenses/COPYING.$license" "$out/UTIL-LINUX-COPYING.$license"
done
python3 - "$src" "$work/getopt" "$out" <<'PY'
from pathlib import Path
import sys
src, getopt, out = map(Path, sys.argv[1:])
files = [*sorted((src/'include').glob('*.h')), *sorted((src/'text-utils').glob('hexdump*.[ch]')), src/'text-utils/rev.c', *[src/'lib'/name for name in ['strutils.c','colors.c','color-names.c','strv.c']], *sorted(getopt.glob('*.[ch]'))]
notices = []
for path in files:
    text = path.read_text()
    if text.lstrip().startswith('/*'): notices.append(str(path.relative_to(src) if str(path).startswith(str(src)+'/') else 'gnu-getopt/'+path.name)+'\n'+text.split('*/',1)[0]+'*/')
(out/'UTIL-LINUX-NOTICES').write_text('\n\n'.join(notices)+'\n')
PY
python3 - "$repo" "$out" <<'PYLICENSE'
from pathlib import Path
import hashlib, json, shutil, subprocess, sys
repo, out = map(Path, sys.argv[1:])
record = json.loads((repo/'scripts/wasi-artifacts/sdk27-licenses.json').read_text())
for relative, info in record['licenses'].items():
    path = repo/relative
    if not path.exists(): subprocess.check_call(['curl','-fLsS','--retry','2',info['url'],'-o',str(path)])
    if hashlib.sha256(path.read_bytes()).hexdigest() != info['sha256']: raise SystemExit('SDK license hash changed: '+relative)
    if path.resolve() != (out/path.name).resolve(): shutil.copyfile(path,out/path.name)
PYLICENSE
sha256sum "$out/rev-2.37.2.wasm" "$out/hexdump-2.37.2.wasm"
