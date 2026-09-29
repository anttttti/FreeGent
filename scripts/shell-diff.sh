#!/usr/bin/env bash
# Runs each line of a cases file through real bash and through FreeGent's browser shell (shiro),
# and diffs stdout + exit status. Each case starts from a fresh copy of the fixtures. Reference
# output comes from the system's GNU tools (awk is whatever /usr/bin/awk is — mawk on Ubuntu).
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

# Real bash. Same filtering as the harness: skip blank lines and # comments.
n=0
while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
    n=$((n + 1))
    work=$(mktemp -d)
    cp -r "$fixtures"/. "$work"/
    # A clean environment: system GNU tools only (no aliases, no ~/.local or conda shadowing).
    ( cd "$work" && env -i PATH=/usr/bin:/bin HOME="$work" LC_ALL=C timeout 10 bash -c "$line" > "$out/bash.$n" 2>/dev/null; echo "exit=$?" >> "$out/bash.$n" )
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
