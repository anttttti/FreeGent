#!/usr/bin/env bash
# Runs each execute_code case through the real interpreter and through FreeGent's browser runner,
# and compares raw stdout/stderr bytes, exit status and file effects (by SHA-256). Each case
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
# differs or lacks a required reference. Frozen coverage oracles come from two isolated
# native runs. Raw streams and combined diffs stay in the printed output directory.
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

# Share selected native versions with the oracle recorder, without changing /usr.
python3 bench/dev-tests/log-replay/native-tools.py > "$out/native-programs.json"
[ "$?" -eq 0 ] || exit 2
mapfile -d '' -t native_mount_args < <(python3 - "$out/native-programs.json" <<'PY'
import json, os, sys
for program in json.load(open(sys.argv[1])):
    for value in [program['path'], program['mount_path']]:
        sys.stdout.buffer.write(os.fsencode(value) + b'\0')
PY
)
for ((index=0; index<${#native_mount_args[@]}; index+=2)); do
    sandbox+=(--ro-bind "${native_mount_args[index]}" "${native_mount_args[index+1]}")
done

# Same as scripts/shell-diff.sh: "file:<path>\t<sha256>" per file, and the changes a case made.
file_hashes() {
    ( cd "$1" && find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z | xargs -0r sha256sum ) |
        awk '{ printf "file:%s\t%s\n", substr($0, 67), substr($0, 1, 64) }'
}
file_changes() {
    file_hashes "$1" | awk -F'\t' -v base="${2:-$out/base.hashes}" '
        BEGIN { while ((getline l < base) > 0) { split(l, f, "\t"); was[f[1]] = f[2] } }
        { seen[$1] = 1; if (was[$1] != $2) print }
        END { for (p in was) if (!(p in seen)) printf "%s\tdeleted\n", p }' | LC_ALL=C sort
}
file_hashes "$fixtures" > "$out/base.hashes"

mapfile -t names < <(cd "$cases" && ls | grep -E '\.(sh|py|js)$' | LC_ALL=C sort)
# Permanent coverage inputs carry independently tested byte oracles. Check their provenance
# and expose missing fixtures as open failures; never compare two "command not found" results.
python3 - "$cases" "$fixtures" "$out" <<'PY'
import base64, hashlib, json, os, pathlib, sys
cases, fixtures, out = map(pathlib.Path, sys.argv[1:])
index_path = cases / 'coverage-index.json'
if index_path.exists():
    index = json.loads(index_path.read_text())
    data = json.loads((cases / 'coverage-expectations.json').read_text())
    before = {str(p.relative_to(fixtures)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in fixtures.rglob('*') if p.is_file()}
    if before != data['fixtures_sha256']: raise SystemExit('Coverage fixture bytes changed; native references must be re-recorded.')
    package_names = {c['name'] for c in index['commands'] if c['kind'] == 'package'}
    for case in index['cases']:
        name = case['id']; row = data['cases'].get(name, {})
        digest = hashlib.sha256((cases / name).read_bytes()).hexdigest()
        if digest != row.get('input_sha256'): raise SystemExit('Stale/missing coverage oracle: ' + name)
        if hashlib.sha256(case['reference_code'].encode()).hexdigest() != row.get('reference_sha256'):
            raise SystemExit('Stale coverage reference input: ' + name)
        if case.get('parity_scope') == 'integration-only':
            (out / ('integration-only.' + name)).write_text('This browser command is checked by integration tests, not Bash parity.\\n')
            continue
        if row['status'] != 'verified':
            (out / ('blocked.' + name)).write_text(row['status'] + ': ' + row.get('reason', '') + '\n')
            continue
        if any(c in package_names for c in case['commands']) and not os.environ.get('FG_NET_TESTS'):
            (out / ('blocked.' + name)).write_text('runtime-unavailable: package execution needs FG_NET_TESTS=1 and the pinned WASM artifact\n')
            continue
        expected = row['expected']; after = dict(expected['files'])
        changes = [f'file:./{p}\t{h}\n' for p,h in after.items() if before.get(p) != h]
        changes += [f'file:./{p}\tdeleted\n' for p in before if p not in after]
        stdout = base64.b64decode(expected['stdout_base64'], validate=True)
        stderr = base64.b64decode(expected['stderr_base64'], validate=True)
        (out / ('real.' + name)).write_bytes(stdout + f"exit={expected['exit_code']}\n".encode() + ''.join(sorted(changes, key=lambda s:s.encode())).encode())
        (out / ('real.stdout.' + name)).write_bytes(stdout)
        (out / ('real.stderr.' + name)).write_bytes(stderr)
        (out / ('real.exit.' + name)).write_text(str(expected['exit_code']) + '\n')
        (out / ('real.files.' + name)).write_text(''.join(sorted(changes, key=lambda s:s.encode())))
PY
[ "$?" -eq 0 ] || exit 2
if [ -n "${EXEC_DIFF_FILTER:-}" ]; then
    mapfile -t names < <(printf '%s\n' "${names[@]}" | grep -E "$EXEC_DIFF_FILTER")
fi
if [ "${#names[@]}" -eq 0 ]; then
    echo "No cases selected; check the case directory and EXEC_DIFF_FILTER" >&2
    exit 2
fi
: > "$out/case-names.txt"
printf '%s\n' "${names[@]}" > "$out/selected-names.txt"
python3 - "$cases" "$out" <<'PY'
import json, pathlib, sys
cases, out = map(pathlib.Path, sys.argv[1:])
index = cases / 'coverage-index.json'
if index.exists():
    metadata = {row['id']:row for row in json.loads(index.read_text()).get('cases',[])}
    for name in (out / 'selected-names.txt').read_text().splitlines():
        if metadata.get(name,{}).get('parity_scope') == 'capability-only':
            (out / ('capability-only.' + name)).write_text('Bash byte parity is outside this command\'s declared Shiro support scope.\n')
PY
for name in "${names[@]}"; do
    [ -f "$out/blocked.$name" ] || printf '%s\n' "$name" >> "$out/case-names.txt"
done
for name in "${names[@]}"; do
    [ -f "$out/blocked.$name" ] && continue
    [ -f "$out/integration-only.$name" ] && continue # Browser integration case; no Bash oracle contract.
    [ -f "$out/real.$name" ] && continue # verified frozen native oracle
    work=$(mktemp -d)
    cp -r "$fixtures"/. "$work"/
    python3 - "$cases" "$name" "$work" <<'PY'
import json, pathlib, sys
cases, name, work = sys.argv[1:]
manifest = pathlib.Path(cases) / 'case-fixtures.json'
if manifest.exists():
    profile = json.loads(manifest.read_text()).get(name, {})
    root = pathlib.Path(work).resolve()
    for filename, text in profile.get('files', {}).items():
        path = (root / filename).resolve()
        path.relative_to(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())
PY
    [ "$?" -eq 0 ] || exit 2
    file_hashes "$work" > "$out/base.$name.hashes"
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
        timeout 20 "${cmd[@]}" > "$out/real.$name" 2> "$out/real.stderr.$name" < /dev/null
    exec_status=$?
    cp "$out/real.$name" "$out/real.stdout.$name"
    printf '%s\n' "$exec_status" > "$out/real.exit.$name"
    echo "exit=$exec_status" >> "$out/real.$name"
    file_changes "$work" "$out/base.$name.hashes" > "$out/real.files.$name"
    cat "$out/real.files.$name" >> "$out/real.$name"
    rm -rf "$work"
done

# Browser runners
EXEC_DIFF_CASES="$cases" EXEC_DIFF_OUT="$out" EXEC_DIFF_FIXTURES="$fixtures" EXEC_DIFF_NAMES="$out/case-names.txt" \
    npx vitest run tests/exec-diff.harness.test.ts > "$out/vitest.log" 2>&1 \
    || { echo "browser run failed — see $out/vitest.log"; exit 2; }

# Combine with a header per case, then diff. Cases listed in the cases directory's
# known-differences.txt ("name  reason") can waive documented non-Bash differences
# (e.g. CPython vs Pyodide versions). Bash mismatches always fail.
known=""
[ -f "$cases/known-differences.txt" ] && known=$(grep -v '^\s*#' "$cases/known-differences.txt" | awk '{print $1}')
failed=0; knownfail=0; blocked=0; capabilityonly=0; integrationonly=0
: > "$out/real.txt"; : > "$out/browser.txt"
for name in "${names[@]}"; do
    if [ -f "$out/blocked.$name" ]; then
        blocked=$((blocked + 1)); echo "BLOCKED $name: $(cat "$out/blocked.$name")"; continue
    fi
    if [ -f "$out/capability-only.$name" ]; then
        capabilityonly=$((capabilityonly + 1)); continue
    fi
    if [ -f "$out/integration-only.$name" ]; then
        integrationonly=$((integrationonly + 1)); continue
    fi
    if cmp -s "$out/real.$name" "$out/browser.$name" &&
        cmp -s "$out/real.stdout.$name" "$out/browser.stdout.$name" &&
        cmp -s "$out/real.stderr.$name" "$out/browser.stderr.$name" &&
        cmp -s "$out/real.exit.$name" "$out/browser.exit.$name" &&
        cmp -s "$out/real.files.$name" "$out/browser.files.$name"; then continue; fi
    # Bash compatibility bugs cannot be waived through a known-differences entry.
    if [[ $name != *.sh ]] && grep -qxF "$name" <<< "$known"; then knownfail=$((knownfail + 1)); continue; fi
    failed=$((failed + 1))
    for side in real browser; do
        { echo "### $name"; cat "$out/$side.$name" 2>/dev/null || echo "[missing]"; } >> "$out/$side.txt"
        { echo "### stderr: $name"; cat "$out/$side.stderr.$name" 2>/dev/null || echo "[missing]"; } >> "$out/$side.txt"
    done
done

# Escape control/non-ASCII bytes only for the readable diff. All comparisons above
# use the untouched raw streams; a NUL must not hide the remaining mismatch details.
python3 - "$out" <<'PY'
import pathlib, sys
out = pathlib.Path(sys.argv[1])
for side in ('real', 'browser'):
    raw = (out / (side + '.txt')).read_bytes()
    display = ''.join(chr(b) if b in (9,10) or 32 <= b < 127 and b != 92 else ('\\\\' if b == 92 else f'\\x{b:02x}') for b in raw)
    (out / (side + '.diff.txt')).write_text(display)
PY
[ "$?" -eq 0 ] || exit 2
diff -u --label real --label browser "$out/real.diff.txt" "$out/browser.diff.txt"
echo
msg="$((${#names[@]} - failed - knownfail - blocked - capabilityonly - integrationonly)) of $((${#names[@]} - capabilityonly - integrationonly)) in-scope parity cases identical"; [ "$knownfail" -gt 0 ] && msg="$msg, $knownfail known differences"
[ "$blocked" -gt 0 ] && msg="$msg, $blocked unresolved reference requirements"
[ "$capabilityonly" -gt 0 ] && msg="$msg, $capabilityonly capability-only cases outside Bash parity"
[ "$integrationonly" -gt 0 ] && msg="$msg, $integrationonly integration-only cases outside Bash parity"
echo "$msg; outputs in $out"
python3 - "$cases" "$out" <<'PY'
import collections, json, pathlib, sys
cases, out = map(pathlib.Path, sys.argv[1:])
index_path = cases / 'coverage-index.json'
index = json.loads(index_path.read_text()) if index_path.exists() else {'cases': []}
metadata = {c['id']: c for c in index['cases']}
selected = (out / 'selected-names.txt').read_text().splitlines()
known_path = cases / 'known-differences.txt'
known = {line.split()[0] for line in known_path.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')} if known_path.exists() else set()
rows = []
for name in sorted(set(selected)):
    blocked = out / ('blocked.' + name)
    info = metadata.get(name, {})
    row = {'id': name, 'commands': info.get('commands', [])}
    row['parity_scope'] = info.get('parity_scope','bash')
    integration = out / ('integration-only.' + name)
    if integration.exists():
        row.update(status='integration-only', reason=integration.read_text().strip())
    elif blocked.exists():
        row.update(status='blocked', reason=blocked.read_text().strip())
    else:
        comparisons = {}
        for part in ('stdout.', 'stderr.', 'exit.', 'files.'):
            real = out / ('real.' + part + name); browser = out / ('browser.' + part + name)
            comparisons[part.rstrip('.')] = browser.exists() and real.read_bytes() == browser.read_bytes()
        row['comparisons'] = comparisons
        row['expected_exit'] = (out / ('real.exit.' + name)).read_text().strip()
        row['actual_exit'] = (out / ('browser.exit.' + name)).read_text().strip() if (out / ('browser.exit.' + name)).exists() else 'missing'
        row['status'] = 'capability-only' if row['parity_scope']=='capability-only' else ('identical' if all(comparisons.values()) else ('known-difference' if not name.endswith('.sh') and name in known else 'mismatch'))
    rows.append(row)
(out / 'results.json').write_text(json.dumps({'cases': rows, 'counts': dict(collections.Counter(r['status'] for r in rows))}, indent=2) + '\n')
PY
[ "$?" -eq 0 ] || exit 2
[ "$failed" -eq 0 ] && [ "$blocked" -eq 0 ]
