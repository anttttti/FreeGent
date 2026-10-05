#!/usr/bin/env bash
# deploy.sh — FreeGent deployment: safety checks → build → CF Worker → git push
#
# Usage:
#   ./deploy.sh                  # build + CF Worker + git push
#   ./deploy.sh --worker-only    # CF Worker deploy only
#   ./deploy.sh --git-only       # build + git push only
#   ./deploy.sh --check-only     # run checks and build without deploying
#
# CLOUDFLARE_API_TOKEN is read (in order) from:
#   1. Environment variable CLOUDFLARE_API_TOKEN
#   2. ~/.config/freegent/credentials  (line: CLOUDFLARE_API_TOKEN=cfut_...)
#   Never hard-code it here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# ── Terminal colours ──────────────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
ok()   { echo -e "${G}✓${N} $*"; }
warn() { echo -e "${Y}⚠${N} $*"; }
fail() { echo -e "${R}✗ $*${N}" >&2; exit 1; }
info() { echo -e "${B}→${N} $*"; }
step() { echo; echo -e "${B}── $* ──${N}"; }

# ── Parse options ─────────────────────────────────────────────────────────────
DO_WORKER=true
DO_GIT=true
DO_DEPLOY=true
for arg in "$@"; do
    case "$arg" in
        --worker-only) DO_GIT=false ;;
        --git-only)    DO_WORKER=false ;;
        --check-only)  DO_DEPLOY=false ;;
        --help|-h)
            sed -n '2,10p' "$0" | sed 's/^# \{0,2\}//'
            exit 0 ;;
        *) fail "Unknown option: $arg" ;;
    esac
done

# ═══════════════════════════════════════════════════════════════════════════════
step "Safety checks"

# 0. Deploy only committed code. Typecheck/tests/build run on the working tree and
#    wrangler uploads cf-worker/ straight from disk, so uncommitted edits would
#    otherwise be tested or deployed without existing in any commit.
if $DO_DEPLOY; then
    _DIRTY=$(git status --porcelain --untracked-files=no)
    if [ -n "$_DIRTY" ]; then
        echo "$_DIRTY" | sed 's/^/    /' >&2
        fail "Uncommitted changes to tracked files — commit or stash before deploying."
    fi
    if $DO_WORKER; then
        _WDIRTY=$(git status --porcelain -- cf-worker)
        if [ -n "$_WDIRTY" ]; then
            echo "$_WDIRTY" | sed 's/^/    /' >&2
            fail "Untracked or modified files in cf-worker/ — commit or remove before deploying the Worker."
        fi
    fi
    ok "Working tree clean"
fi

# 1. No .env files may be git-tracked (.env.example is the only allowed one)
_TRACKED_ENV=$(git ls-files | grep -E '(^|/)\.env([.~_-].*)?$' | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$_TRACKED_ENV" ]; then
    echo "$_TRACKED_ENV" | sed 's/^/    /' >&2
    fail "env file(s) tracked by git! Run: git rm --cached <file> and add it to .gitignore"
fi
ok "No .env files tracked"

# 2. Credentials file must be outside the repo
CREDS="${XDG_CONFIG_HOME:-$HOME/.config}/freegent/credentials"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -n "$REPO_ROOT" ] && [[ "$CREDS" == "$REPO_ROOT"/* ]]; then
    fail "Credentials file is inside the repo: $CREDS"
fi
ok "Credentials file location safe"

# Resolve the set of commits about to be pushed (used by the history scan in 3
# and by checks 5–7).
_UPSTREAM=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo "")
_REMOTE_REF="${_UPSTREAM:-origin/main}"
if ! git rev-parse --verify "${_REMOTE_REF}" >/dev/null 2>&1; then
    warn "Cannot resolve upstream '${_REMOTE_REF}' — skipping commit-history checks (first push?)"
    _PUSH_RANGE=""
else
    _PUSH_RANGE="${_REMOTE_REF}..HEAD"
fi

# 3. Scan for secret-shaped strings in tracked files (working tree and HEAD) and in
#    every line added by the commits about to be pushed — a key committed and later
#    deleted still ships in history. Matches are a hard failure; values are never
#    printed. Bypass for a verified false positive: FREEGENT_ALLOW_SECRET_MATCH=1
SECRET_PATTERNS=(
    '(^|[^A-Za-z0-9_-])sk-(ant-(api|admin)[0-9]{2}-|or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}'
                                         # Anthropic / OpenRouter / OpenAI-style
    'gsk_[A-Za-z0-9]{20,}'               # Groq
    'AIza[A-Za-z0-9_-]{30,}'             # Google / Gemini
    'cfut_[A-Za-z0-9]{20,}'              # Cloudflare API tokens
    'gh[pousr]_[A-Za-z0-9]{36,}'         # GitHub tokens
    'github_pat_[A-Za-z0-9_]{40,}'       # GitHub fine-grained tokens
    'hf_[A-Za-z0-9]{30,}'                # Hugging Face
    '(AKIA|ASIA)[A-Z0-9]{16}'            # AWS access key IDs
    'xox[baprs]-[A-Za-z0-9-]{10,}'       # Slack
    '-----BEGIN [A-Z ]*PRIVATE KEY-----' # PEM private keys
    'eyJhbGci[A-Za-z0-9._-]{30,}'        # JWTs
    'thk_live_[A-Za-z0-9]{10,}'          # TokenHarbor
    "Bearer [A-Za-z0-9._-]{30,}[\"']"    # Hardcoded Bearer values
)
SECRET_RE=$(IFS='|'; echo "${SECRET_PATTERNS[*]}")

LEAKS=()
while IFS= read -r _loc; do
    [ -n "$_loc" ] && LEAKS+=("$_loc (working tree)")
done < <(git grep -nIE -e "$SECRET_RE" 2>/dev/null | cut -d: -f1-2 || true)
while IFS= read -r _loc; do
    [ -n "$_loc" ] && LEAKS+=("${_loc#HEAD:} (HEAD)")
done < <(git grep -nIE -e "$SECRET_RE" HEAD 2>/dev/null | cut -d: -f1-3 || true)
if [ -n "$_PUSH_RANGE" ]; then
    while IFS= read -r _hash; do
        # grep -c (not -q): -q exits at the first match, the upstream commands then die of SIGPIPE,
        # and under pipefail the pipeline reports failure — so a secret early in a large commit
        # was treated as "no match".
        _hits=$(git show --format= --no-color "$_hash" 2>/dev/null \
                | grep -E '^\+' | grep -cE -e "$SECRET_RE" || true)
        if [ "${_hits:-0}" -gt 0 ]; then
            LEAKS+=("$(git log -1 --oneline "$_hash") (added in pending commit)")
        fi
    done < <(git rev-list "$_PUSH_RANGE" 2>/dev/null || true)
fi
if [ ${#LEAKS[@]} -gt 0 ]; then
    echo -e "${R}✗ Secret-shaped strings found:${N}" >&2
    for f in "${LEAKS[@]}"; do echo "    $f" >&2; done
    echo >&2
    if [ "${FREEGENT_ALLOW_SECRET_MATCH:-0}" = "1" ]; then
        warn "FREEGENT_ALLOW_SECRET_MATCH=1 — continuing despite matches"
    else
        fail "Remove the secret (rewrite history if it is in a pending commit) and rotate it.\n  For a verified false positive: FREEGENT_ALLOW_SECRET_MATCH=1 ./deploy.sh"
    fi
else
    ok "No secret patterns in tracked files or pending commits"
fi

# 4. CF Worker must use env parameter, keep its origin allowlist and rate limiter,
#    and have no hardcoded key values
WORKER="cf-worker/worker.js"
WRANGLER="cf-worker/wrangler.toml"
if [ -f "$WORKER" ]; then
    # Must accept env: fetch(request, env)
    grep -q 'fetch(request, env)' "$WORKER" \
        || fail "$WORKER: missing env parameter in fetch handler (key injection won't work)"
    ok "CF Worker uses env parameter"

    # Must have origin allowlist
    grep -q 'ALLOWED_ORIGINS' "$WORKER" \
        || fail "$WORKER: ALLOWED_ORIGINS not found — worker would be open to any origin"

    # Rate limiter bounds use of the shared keys; it must be both used and bound
    grep -q 'FG_RATE_LIMITER' "$WORKER" \
        || fail "$WORKER: FG_RATE_LIMITER not referenced — shared keys would be unmetered"
    grep -qE '^name *= *"FG_RATE_LIMITER"' "$WRANGLER" \
        || fail "$WRANGLER: FG_RATE_LIMITER ratelimit binding missing"
    ok "CF Worker has origin allowlist and rate limiter"

    # Must not contain hardcoded key values (anything secret-shaped, as in check 3)
    if grep -qE -e "$SECRET_RE" "$WORKER" "$WRANGLER"; then
        fail "Hardcoded secret value detected in cf-worker/"
    fi
    ok "CF Worker has no hardcoded secrets"
fi

# 5. No bench/ changes committed to FreeGent  (bench code belongs in FreeGentBench)
# 6. No AI-agent-attributed commits            (only human-authored commits allowed)
# 7. All commits authored by the repo owner    (bypass: FREEGENT_ALLOW_FOREIGN_AUTHOR=1)
if [ -n "$_PUSH_RANGE" ]; then

    # 5. No bench/ changes
    _BENCH_HITS=$(git diff --name-only "$_PUSH_RANGE" 2>/dev/null \
        | grep -E '^bench(/|$)' || true)
    if [ -n "$_BENCH_HITS" ]; then
        echo -e "${R}✗ bench/ changes found in commits to be pushed:${N}" >&2
        echo "$_BENCH_HITS" | sed 's/^/    /' >&2
        echo >&2
        fail "Benchmark code belongs in FreeGentBench (the bench/ submodule).\n  Commit there — never directly to FreeGent."
    fi
    ok "No bench/ changes in pending commits"

    # 5b. No tracked FreeGent file imports from bench/ — it is gitignored, so such code
    #     (e.g. tests) breaks in CI, where bench/ isn't checked out. Tests for bench/ live there.
    _BENCH_IMPORTS=$(git grep -nE "(from|import\()[[:space:]]*['\"](\.\./)+bench/" -- '*.ts' '*.tsx' '*.js' '*.mjs' 2>/dev/null || true)
    if [ -n "$_BENCH_IMPORTS" ]; then
        echo -e "${R}✗ Tracked files import from bench/:${N}" >&2
        echo "$_BENCH_IMPORTS" | sed 's/^/    /' >&2
        echo >&2
        fail "bench/ is not part of FreeGent. Move this code or its tests to FreeGentBench."
    fi
    ok "No tracked files import from bench/"

    # 6. No AI-agent attribution in commit messages or author/committer email
    #    Known attribution patterns (updated 2025-09):
    # All patterns are anchored to line-start (^) so they match actual trailers/
    # footers, not descriptions that merely mention agent names in prose.
    # Matching is case-insensitive: git trailers are case-insensitive, and Claude
    # Code writes "Co-Authored-By:".
    _AI_MSG_PATTERNS=(
        '^Claude-Session:'                       # Claude Code (Anthropic)
        '^Co-authored-by:.*[Cc]laude'            # Claude generic co-author
        '^Co-authored-by:.*noreply@anthropic\.com' # Claude Code co-author email
        'Generated with \[?Claude Code'          # Claude Code PR/commit footer
        '^Generated-by:.*[Cc]laude'              # Claude trailer variant
        '^Co-authored-by:.*[Cc]opilot'           # GitHub Copilot Workspace
        '^Co-authored-by:.*[Aa]ider'             # Aider  <aider@aider.chat>
        '^Co-authored-by:.*[Dd]evin'             # Devin (Cognition AI)
        '^Generated by Devin'                    # Devin commit footer
        '^Co-authored-by:.*[Ss]weep'             # Sweep AI
        '^Co-authored-by:.*Amazon.?Q'            # Amazon Q Developer
        '^Co-authored-by:.*[Tt]abnine'           # Tabnine PR Agent
        '^Co-authored-by:.*[Cc]odeium'           # Codeium
        '^Co-authored-by:.*[Ww]indsurf'          # Windsurf (Codeium)
        '^Co-authored-by:.*JetBrains.AI'         # JetBrains AI Assistant
        '^Co-authored-by:.*[Rr]eplit'            # Replit AI Agent
        '^Authored by OpenHands'                 # OpenHands (fka OpenDevin)
        '^Co-authored-by:.*[Oo]pen[Hh]ands'     # OpenHands co-author
        '^Co-authored-by:.*SWE-agent'            # SWE-agent (Princeton NLP)
        'Co-authored-by:.*AutoCodeRover'         # AutoCodeRover (ASE)
    )
    # Email patterns: GitHub App bot accounts and known AI service addresses
    _AI_EMAIL_PATTERNS=(
        '\[bot\]@'                               # Any GitHub App bot
        'aider@aider\.chat'                      # Aider
        'noreply@anthropic\.com'                 # Claude Code
        'devin-ai-integration'                   # Devin bot account
        'copilot@github\.com'                    # Copilot Workspace
        'openhands@all-hands\.dev'               # OpenHands
        'amazonq@amazon\.com'                    # Amazon Q Developer
        'ai@replit\.com'                         # Replit AI
        'tabnine@tabnine\.com'                   # Tabnine
        'ai-assistant@jetbrains\.com'            # JetBrains AI
    )

    _AGENT_HITS=()
    while IFS= read -r _hash; do
        _body=$(git log -1 --format="%B" "$_hash" 2>/dev/null || true)
        _ae=$(git log -1 --format="%ae" "$_hash" 2>/dev/null || true)
        _ce=$(git log -1 --format="%ce" "$_hash" 2>/dev/null || true)
        _emails="$_ae $_ce"
        _hit_reason=""

        for _pat in "${_AI_MSG_PATTERNS[@]}"; do
            if echo "$_body" | grep -qiE "$_pat"; then
                _hit_reason="message matches '$_pat'"
                break
            fi
        done
        if [ -z "$_hit_reason" ]; then
            for _epat in "${_AI_EMAIL_PATTERNS[@]}"; do
                if echo "$_emails" | grep -qiE "$_epat"; then
                    _hit_reason="email matches '$_epat' (author: $_ae)"
                    break
                fi
            done
        fi

        if [ -n "$_hit_reason" ]; then
            _AGENT_HITS+=("$(git log -1 --oneline "$_hash") — $_hit_reason")
        fi
    done < <(git log "$_PUSH_RANGE" --format="%H" 2>/dev/null || true)

    if [ ${#_AGENT_HITS[@]} -gt 0 ]; then
        echo -e "${R}✗ AI-agent-attributed commits detected:${N}" >&2
        for _h in "${_AGENT_HITS[@]}"; do echo "    $_h" >&2; done
        echo >&2
        fail "Only human-authored commits may be pushed to FreeGent.\n  Squash or amend to remove agent attribution before deploying."
    fi
    ok "No AI-agent attribution in pending commits"

    # 7. All pending commits authored and committed by the repo owner (git config user.email)
    if [ "${FREEGENT_ALLOW_FOREIGN_AUTHOR:-0}" != "1" ]; then
        _MY_EMAIL=$(git config user.email 2>/dev/null || echo "")
        if [ -z "$_MY_EMAIL" ]; then
            warn "git config user.email not set — skipping author-email check"
        else
            _FOREIGN=()
            while IFS= read -r _line; do
                [ -n "$_line" ] && _FOREIGN+=("$_line")
            done < <(git log "$_PUSH_RANGE" --format="%h%x09%ae%x09%ce%x09%s" 2>/dev/null \
                | awk -F'\t' -v me="$_MY_EMAIL" \
                    'NF && (tolower($2) != tolower(me) || tolower($3) != tolower(me)) \
                     { print $1 "  author=" $2 " committer=" $3 "  " $4 }' || true)

            if [ ${#_FOREIGN[@]} -gt 0 ]; then
                echo -e "${R}✗ Commits not authored/committed by ${_MY_EMAIL}:${N}" >&2
                for _f in "${_FOREIGN[@]}"; do echo "    $_f" >&2; done
                echo >&2
                fail "All commits must be authored by you (${_MY_EMAIL}).\n  To override for a merge commit or deliberate exception:\n  FREEGENT_ALLOW_FOREIGN_AUTHOR=1 ./deploy.sh"
            fi
            ok "All pending commits authored by ${_MY_EMAIL}"
        fi
    else
        warn "FREEGENT_ALLOW_FOREIGN_AUTHOR=1 — skipping author-email check"
    fi

fi  # end _PUSH_RANGE checks

# Generated routing documentation must match the catalog; this check never writes.
step "Shiro inventory"
npx tsx scripts/shiro-inventory.mjs --check || fail "Stale Shiro inventory — regenerate and commit its note and artifacts together."
ok "Shiro inventory current"

# 8. Typecheck + test suite
step "Typecheck"
if npm run typecheck 2>&1; then
    ok "Typecheck passed"
else
    fail "Type errors — fix before deploying."
fi

step "Tests"
if npm test -- --reporter=verbose 2>&1 | tee /tmp/_fg_test_out.txt | tail -6; then
    _TEST_PASS=$(grep -c '✓' /tmp/_fg_test_out.txt 2>/dev/null || echo 0)
    _TEST_FAIL=$(grep -c '✗\|FAIL\| × ' /tmp/_fg_test_out.txt 2>/dev/null || echo 0)
    ok "Tests passed ($_TEST_PASS)"
else
    echo
    grep -E '(FAIL|✗| × |●)' /tmp/_fg_test_out.txt | head -20 >&2
    fail "Test suite failed — fix before deploying."
fi

# ═══════════════════════════════════════════════════════════════════════════════
if $DO_GIT || ! $DO_DEPLOY; then
    step "Build"
    npm run build 2>&1 | grep -v "^$" | tail -8
    ok "Build succeeded"
fi

[ "$DO_DEPLOY" = false ] && { echo; ok "Checks complete (--check-only, nothing deployed)"; exit 0; }

# ═══════════════════════════════════════════════════════════════════════════════
if $DO_WORKER; then
    step "CF Worker deploy"

    # Resolve Cloudflare API token
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
        if [ -f "$CREDS" ]; then
            CLOUDFLARE_API_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' "$CREDS" 2>/dev/null \
                | head -1 | cut -d= -f2- | tr -d "[:space:]\"'" || true)
        fi
    fi
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] \
        || fail "CLOUDFLARE_API_TOKEN not set.\n  Export it, or add to: $CREDS"

    (cd cf-worker && CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler deploy)
    ok "CF Worker deployed → https://proxy.freegent.ai"
fi

# ═══════════════════════════════════════════════════════════════════════════════
if $DO_GIT; then
    step "Git push"
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    FREEGENT_DEPLOY=1 git push
    ok "Pushed branch '$BRANCH' → https://github.com/anttttti/FreeGent"
    ok "GitHub Pages → https://freegent.ai (Pages build may take ~60s)"
fi

echo
echo -e "${G}✓ Deployment complete${N}"
