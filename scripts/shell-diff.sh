#!/usr/bin/env bash
# Runs each line of a cases file through real bash and through FreeGent's browser shell (shiro),
# and diffs stdout, exit status and the files each case leaves behind. Each case starts from a
# fresh copy of the fixtures. Reference output comes from the system's GNU tools (awk is whatever
# /usr/bin/awk is — mawk on Ubuntu), python3 from /usr/bin and the node running this script.
#
#   scripts/shell-diff.sh [cases-file] [fixtures-dir]
#
# Defaults: scripts/shell-diff/cases.txt and scripts/shell-diff/fixtures. Exits 1 if any case
# differs. The combined outputs stay in the printed directory for a closer look.
set -uo pipefail
cd "$(dirname "$0")/.."
cases=$(realpath "${1:-scripts/shell-diff/cases.txt}")
fixtures=$(realpath "${2:-scripts/shell-diff/fixtures}")
out=$(mktemp -d)

# The node running this script, not /usr/bin/node (often far older than the Node the browser
# shell's console.log follows).
refbin="$out/bin"; mkdir -p "$refbin"
ln -s "$(realpath "$(command -v node)")" "$refbin/node"

# "file:<path>\t<sha256>" for every file, by path in byte order. A symlink counts as a file with
# its target's contents (the browser workspace has no links: ln -s makes a copy).
file_hashes() {
    ( cd "$1" && find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z | xargs -0r sha256sum ) |
        awk '{ printf "file:%s\t%s\n", substr($0, 67), substr($0, 1, 64) }'
}
# The workspace changes a case made: a hash line for each new or changed file, "deleted" for
# each removed one (tests/shell-diff.harness.test.ts prints the same).
file_changes() {
    file_hashes "$1" | awk -F'\t' -v base="$out/base.hashes" '
        BEGIN { while ((getline l < base) > 0) { split(l, f, "\t"); was[f[1]] = f[2] } }
        { seen[$1] = 1; if (was[$1] != $2) print }
        END { for (p in was) if (!(p in seen)) printf "%s\tdeleted\n", p }' | LC_ALL=C sort
}
file_hashes "$fixtures" > "$out/base.hashes"

# Real bash. Same filtering as the harness: skip blank lines and # comments.
n=0
while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
    n=$((n + 1))
    work=$(mktemp -d)
    cp -r "$fixtures"/. "$work"/
    # A clean environment: system GNU tools only (no aliases, no ~/.local or conda shadowing).
    ( cd "$work" && env -i PATH="$refbin:/usr/bin:/bin" HOME="$work" LC_ALL=C.UTF-8 timeout 10 bash -c "$line" > "$out/bash.$n" 2>/dev/null < /dev/null; echo "exit=$?" >> "$out/bash.$n" )
    file_changes "$work" >> "$out/bash.$n"
    rm -rf "$work"
done < "$cases"

# Browser shell
SHELL_DIFF_CASES="$cases" SHELL_DIFF_OUT="$out" SHELL_DIFF_FIXTURES="$fixtures" \
    npx vitest run tests/shell-diff.harness.test.ts > "$out/vitest.log" 2>&1 \
    || { echo "browser shell run failed — see $out/vitest.log"; exit 2; }

# Combine with a header per case, then diff.
i=0; failed=0
: > "$out/bash.txt"; : > "$out/shiro.txt"
while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
    i=$((i + 1))
    for side in bash shiro; do
        { echo "### $i: $line"; cat "$out/$side.$i" 2>/dev/null || echo "[missing]"; } >> "$out/$side.txt"
    done
    cmp -s "$out/bash.$i" "$out/shiro.$i" || failed=$((failed + 1))
done < "$cases"

diff -u --label bash --label shiro "$out/bash.txt" "$out/shiro.txt"
echo
echo "$((i - failed)) of $i cases identical; outputs in $out"
[ "$failed" -eq 0 ]
