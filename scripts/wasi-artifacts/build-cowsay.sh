#!/usr/bin/env bash
# Build the existing upstream Rust port with its default tongue-width bug fixed.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
compiler=$(rustc +stable --version)
test "$compiler" = 'rustc 1.99.0 (b940084d7 2026-09-28)' || {
  echo 'This pin requires the recorded Rust 1.99.0 toolchain; review a different compiler before updating artifact bytes.' >&2
  exit 1
}
rustup +stable target add wasm32-wasip1
curl -fL --retry 2 -o "$work/source.tgz" https://github.com/wapm-packages/cowsay/archive/907f67128f3ed332c69d5f1c181d72df41823c05.tar.gz
printf '%s  %s\n' 5e841c532277cd5a6d850d234b21c1841438b32c38b80791a67391e7c22d6126 "$work/source.tgz" | sha256sum -c -
mkdir "$work/source"
tar -xf "$work/source.tgz" -C "$work/source" --strip-components=1
cp scripts/wasi-artifacts/cowsay.lock "$work/source/Cargo.lock"
python3 - "$work/source" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
path = root / 'src/main.rs'
source = path.read_text()
old = 'value_of("tongue").unwrap_or(" ")'
assert source.count(old) == 1
path.write_text(source.replace(old, 'value_of("tongue").unwrap_or("  ")'))
# These files are excluded from Debian's upstream cow distribution because
# their artwork has no known license. Keep the same distribution boundary.
for name in ['kitty', 'meow', 'satanic', 'small', 'sodomized', 'supermilker', 'surgery', 'telebears', 'udder']:
    (root / ('src/cows/' + name + '.cow')).unlink()
PY
crate_cache=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="--remap-path-prefix=$work/source=/src --remap-path-prefix=$crate_cache=/cargo" \
  cargo +stable build --locked --release --target wasm32-wasip1 --manifest-path "$work/source/Cargo.toml"
# The expected hash is reviewed alongside the source/compiler/dependency pins.
printf '%s  %s\n' a2e3295a5dd39bdc39e23c6e9f88187af25e518cc8dbfb1a8fffeda7a2f2d12f "$work/source/target/wasm32-wasip1/release/cowsay.wasm" | sha256sum -c -
cp "$work/source/target/wasm32-wasip1/release/cowsay.wasm" public/shiro/wasm/cowsay-0.3.0-fg1.wasm
cp "$work/source/LICENSE" public/shiro/wasm/COWSAY-LICENSE
