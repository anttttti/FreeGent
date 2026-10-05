#!/usr/bin/env bash
# Build the BSD calendar used by the pinned native reference, without a terminal.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 2 -o "$work/sdk.tgz" https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz
curl -fL --retry 2 -o "$work/source.tar.xz" https://archive.ubuntu.com/ubuntu/pool/universe/b/bsdmainutils/bsdmainutils_12.1.7+nmu3ubuntu2.tar.xz
printf '%s  %s\n' b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2 "$work/sdk.tgz" 10d090d8dbefbc48ee3053ac0b12f6242b33af360b34545acb83f3915f93f366 "$work/source.tar.xz" | sha256sum -c -
tar -xf "$work/sdk.tgz" -C "$work"
mkdir "$work/source"
tar -xf "$work/source.tar.xz" -C "$work/source" --strip-components=1
python3 - "$work/source" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1]) / 'usr.bin/ncal'
for path in root.glob('*.c'):
    path.write_text(path.read_text().replace('#include <sys/cdefs.h>', ''))
path = root / 'ncal.c'
source = path.read_text().replace('#include <term.h>', '')
start = source.index('\t\t/* On how to highlight on this type of terminal (if any). */')
end = source.index('\n\n\t\tfirst = 0;', start)
source = source[:start] + '\t\t/* WASI stdio has no terminal; there is no termcap database. */' + source[end:]
source = source.replace("d_first = (*nl_langinfo(D_MD_ORDER) == 'd');", "d_first = (*nl_langinfo(D_FMT) == '%' && nl_langinfo(D_FMT)[1] == 'd');")
path.write_text(source)
PY
src="$work/source/usr.bin/ncal"
"$work/wasi-sdk-27.0-x86_64-linux/bin/clang" -O2 -D_GNU_SOURCE \
  -include "$work/source/freebsd.h" -I "$src" \
  "$src/ncal.c" "$src/calendar.c" "$src/easter.c" \
  "$repo/scripts/wasi-artifacts/sdk-cwd.c" "$repo/scripts/wasi-artifacts/bsd-errors.c" \
  -Wl,-z,stack-size=1048576 -o "$work/cal.wasm"
printf '%s  %s\n' 36bb2a5e5fc4c3a4e7c59ced38a30799e32d57d6440faeb311880fce791507c0 "$work/cal.wasm" | sha256sum -c -
cp "$work/cal.wasm" public/shiro/wasm/cal-12.1.7.wasm
python3 - "$src" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
Path('public/shiro/wasm/CAL-LICENSE').write_text('\n\n'.join(p.name + '\n' + p.read_text().split('*/', 1)[0] + '*/' for p in sorted(root.glob('*.c'))))
PY
