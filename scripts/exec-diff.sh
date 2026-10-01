#!/usr/bin/env bash
# Runs each execute_code case through the real interpreter and through FreeGent's browser runner,
# and diffs stdout, exit status and the files each case leaves behind (by SHA-256). Each case
# starts from a fresh copy of the fixtures, at /workspace on both sides.
#   *.sh — `bash -c` vs a fresh browser shell (exec-sandbox/bash-run.ts), as execute_code bash
#   *.py — `python3 -c` (/usr/bin) vs the Pyodide worker's run (pyodide-run.ts, real Pyodide)
#   *.js — `node` running the code as the body of an async function vs the exec sandbox's
#          runner (exec-sandbox/js-run.ts)
# The real side runs under bubblewrap: read-only system, private /tmp, no network — cases may be
# commands models wrote (bench/dev-tests/log-replay/cases, picked from benchmark logs).
#
#   scripts/exec-diff.sh [cases-dir] [fixtures-dir]
#
# Defaults: scripts/exec-diff/cases and scripts/shell-diff/fixtures. Exits 1 if any case
# differs. The combined outputs stay in the printed directory for a closer look.
set -uo pipefail
cd "$(dirname "$0")/.."
cases=$(realpath "${1:-scripts/exec-diff/cases}")
fixtures=$(realpath "${2:-scripts/shell-diff/fixtures}")
out=$(mktemp -d)

# The node running this script, not /usr/bin/node (often far older).
nodedir=$(dirname "$(realpath "$(command -v node)")")
# The real side's sandbox: its own root with the system read-only (and the node installation,
# not the rest of $HOME), a private /tmp, no network; the case's workspace is bound at /workspace.
sandbox=(bwrap --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind-try /lib64 /lib64
    --ro-bind-try /lib32 /lib32 --ro-bind /etc /etc --ro-bind "$(dirname "$nodedir")" "$(dirname "$nodedir")"
    --tmpfs /tmp --dev /dev --proc /proc --unshare-all --die-with-parent --clearenv
    --setenv PATH "$nodedir:/usr/bin:/bin" --setenv HOME /workspace --setenv LC_ALL C.UTF-8
    --setenv PYTHONDONTWRITEBYTECODE 1)

# Same as scripts/shell-diff.sh: "file:<path>\t<sha256>" per file, and the changes a case made.
file_hashes() {
    ( cd "$1" && find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z | xargs -0r sha256sum ) |
        awk '{ printf "file:%s\t%s\n", substr($0, 67), substr($0, 1, 64) }'
}
file_changes() {
    file_hashes "$1" | awk -F'\t' -v base="$out/base.hashes" '
        BEGIN { while ((getline l < base) > 0) { split(l, f, "\t"); was[f[1]] = f[2] } }
        { seen[$1] = 1; if (was[$1] != $2) print }
        END { for (p in was) if (!(p in seen)) printf "%s\tdeleted\n", p }' | LC_ALL=C sort
}
file_hashes "$fixtures" > "$out/base.hashes"

mapfile -t names < <(cd "$cases" && ls | grep -E '\.(sh|py|js)$' | LC_ALL=C sort)
for name in "${names[@]}"; do
    work=$(mktemp -d)
    cp -r "$fixtures"/. "$work"/
    code=$(cat "$cases/$name"; echo x); code=${code%x}
    if [[ $name == *.sh ]]; then
        cmd=(bash -c "$code")
    elif [[ $name == *.py ]]; then
        cmd=(python3 -c "$code")
    else
        cmd=(node -e "(async () => { $code
})().catch(e => { console.error(e); process.exitCode = 1; })")
    fi
    "${sandbox[@]}" --bind "$work" /workspace --chdir /workspace \
        timeout 20 "${cmd[@]}" > "$out/real.$name" 2>/dev/null < /dev/null
    echo "exit=$?" >> "$out/real.$name"
    file_changes "$work" >> "$out/real.$name"
    rm -rf "$work"
done

# Browser runners
EXEC_DIFF_CASES="$cases" EXEC_DIFF_OUT="$out" EXEC_DIFF_FIXTURES="$fixtures" \
    npx vitest run tests/exec-diff.harness.test.ts > "$out/vitest.log" 2>&1 \
    || { echo "browser run failed — see $out/vitest.log"; exit 2; }

# Combine with a header per case, then diff. Cases listed in the cases directory's
# known-differences.txt ("name  reason") differ by design (e.g. CPython 3.10 here, 3.12 in
# Pyodide): they are reported, not failed.
known=""
[ -f "$cases/known-differences.txt" ] && known=$(grep -v '^\s*#' "$cases/known-differences.txt" | awk '{print $1}')
failed=0; knownfail=0
: > "$out/real.txt"; : > "$out/browser.txt"
for name in "${names[@]}"; do
    cmp -s "$out/real.$name" "$out/browser.$name" && continue
    if grep -qxF "$name" <<< "$known"; then knownfail=$((knownfail + 1)); continue; fi
    failed=$((failed + 1))
    for side in real browser; do
        { echo "### $name"; cat "$out/$side.$name" 2>/dev/null || echo "[missing]"; } >> "$out/$side.txt"
    done
done

diff -u --label real --label browser "$out/real.txt" "$out/browser.txt"
echo
msg="$((${#names[@]} - failed - knownfail)) of ${#names[@]} cases identical"; [ "$knownfail" -gt 0 ] && msg="$msg, $knownfail known differences"
echo "$msg; outputs in $out"
[ "$failed" -eq 0 ]
