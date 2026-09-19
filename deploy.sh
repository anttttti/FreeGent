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

# 1. .env must not be git-tracked
if git ls-files --error-unmatch .env 2>/dev/null; then
    fail ".env is tracked by git! Run: git rm --cached .env && echo '.env' >> .gitignore"
fi
ok ".env not tracked"

# 2. Credentials file must be outside the repo
CREDS="${XDG_CONFIG_HOME:-$HOME/.config}/freegent/credentials"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -n "$REPO_ROOT" ] && [[ "$CREDS" == "$REPO_ROOT"/* ]]; then
    fail "Credentials file is inside the repo: $CREDS"
fi
ok "Credentials file location safe"

# 3. Scan git-tracked source files for secret-shaped strings
#    (not node_modules or dist — those aren't committed)
SECRET_PATTERNS=(
    'gsk_[A-Za-z0-9]{20,}'              # Groq
    'sk-[A-Za-z0-9T]{20,}'             # OpenAI-style
    'AIza[A-Za-z0-9_-]{30,}'           # Google / Gemini
    'cfut_[A-Za-z0-9]{20,}'            # Cloudflare API tokens
    'eyJhbGci[A-Za-z0-9._-]{30,}'      # JWTs
    'thk_live_[A-Za-z0-9]{10,}'        # TokenHarbor
    'Bearer [A-Za-z0-9._-]{30,}["\x27]' # Hardcoded Bearer values
)
LEAKS=()
for pat in "${SECRET_PATTERNS[@]}"; do
    # grep over files tracked by git, skipping binary blobs
    while IFS= read -r match; do
        LEAKS+=("$match")
    done < <(git ls-files | xargs -r grep -rIlE "$pat" 2>/dev/null || true)
done
if [ ${#LEAKS[@]} -gt 0 ]; then
    warn "Possible secrets found in tracked files:"
    for f in "${LEAKS[@]}"; do echo "    $f"; done
    echo
    read -rp "  Continue anyway? [y/N] " reply
    [[ "${reply,,}" == y ]] || fail "Aborted by user."
else
    ok "No secret patterns in tracked files"
fi

# 4. CF Worker must use env parameter and have no hardcoded key values
WORKER="cf-worker/worker.js"
if [ -f "$WORKER" ]; then
    # Must accept env: fetch(request, env)
    grep -q 'fetch(request, env)' "$WORKER" \
        || fail "$WORKER: missing env parameter in fetch handler (key injection won't work)"
    ok "CF Worker uses env parameter"

    # Must have origin allowlist
    grep -q 'ALLOWED_ORIGINS' "$WORKER" \
        || warn "$WORKER: ALLOWED_ORIGINS not found — worker may be open to any origin"

    # Must not contain hardcoded key values (pattern: key-like strings assigned to variables)
    if grep -qE "= *['\"]gsk_|= *['\"]sk-[A-Za-z]|= *['\"]AIza|= *['\"]thk_live_" "$WORKER"; then
        fail "Hardcoded secret value detected in $WORKER"
    fi
    ok "CF Worker has no hardcoded secrets"
fi

# 5. No bench/ changes committed to FreeGent  (bench code belongs in FreeWorkerBench)
# 6. No AI-agent-attributed commits            (only human-authored commits allowed)
# 7. All commits authored by the repo owner    (bypass: FREEGENT_ALLOW_FOREIGN_AUTHOR=1)
#
# Resolve the set of commits about to be pushed.
_UPSTREAM=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo "")
_REMOTE_REF="${_UPSTREAM:-origin/main}"
if ! git rev-parse --verify "${_REMOTE_REF}" >/dev/null 2>&1; then
    warn "Cannot resolve upstream '${_REMOTE_REF}' — skipping commit-history checks (first push?)"
    _PUSH_RANGE=""
else
    _PUSH_RANGE="${_REMOTE_REF}..HEAD"
fi

if [ -n "$_PUSH_RANGE" ]; then

    # 5. No bench/ changes
    _BENCH_HITS=$(git diff --name-only "$_PUSH_RANGE" 2>/dev/null \
        | grep -E '^bench(/|$)' || true)
    if [ -n "$_BENCH_HITS" ]; then
        echo -e "${R}✗ bench/ changes found in commits to be pushed:${N}" >&2
        echo "$_BENCH_HITS" | sed 's/^/    /' >&2
        echo >&2
        fail "Benchmark code belongs in FreeWorkerBench (the bench/ submodule).\n  Commit there — never directly to FreeGent."
    fi
    ok "No bench/ changes in pending commits"

    # 6. No AI-agent attribution in commit messages or author/committer email
    #    Known attribution patterns (updated 2025-09):
    # All patterns are anchored to line-start (^) so they match actual trailers/
    # footers, not descriptions that merely mention agent names in prose.
    _AI_MSG_PATTERNS=(
        '^Claude-Session:'                       # Claude Code (Anthropic)
        '^Co-authored-by:.*[Cc]laude'            # Claude generic co-author
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
            if echo "$_body" | grep -qE "$_pat"; then
                _hit_reason="message matches '$_pat'"
                break
            fi
        done
        if [ -z "$_hit_reason" ]; then
            for _epat in "${_AI_EMAIL_PATTERNS[@]}"; do
                if echo "$_emails" | grep -qE "$_epat"; then
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

    # 7. All pending commits authored by the repo owner (git config user.email)
    if [ "${FREEGENT_ALLOW_FOREIGN_AUTHOR:-0}" != "1" ]; then
        _MY_EMAIL=$(git config user.email 2>/dev/null || echo "")
        if [ -z "$_MY_EMAIL" ]; then
            warn "git config user.email not set — skipping author-email check"
        else
            _FOREIGN=()
            while IFS= read -r _line; do
                [ -n "$_line" ] && _FOREIGN+=("$_line")
            done < <(git log "$_PUSH_RANGE" --format="%h %ae  %s" 2>/dev/null \
                | grep -v "^$" \
                | grep -v " ${_MY_EMAIL}  " || true)

            if [ ${#_FOREIGN[@]} -gt 0 ]; then
                echo -e "${R}✗ Commits not authored by ${_MY_EMAIL}:${N}" >&2
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

# 8. Test suite
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
    ok "CF Worker deployed → https://fg-proxy.antti-puurula.workers.dev"
fi

# ═══════════════════════════════════════════════════════════════════════════════
if $DO_GIT; then
    step "Git push"
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    UNCOMMITTED=$(git status --porcelain | wc -l | tr -d ' ')
    if [ "$UNCOMMITTED" -gt 0 ]; then
        warn "$UNCOMMITTED uncommitted change(s) — pushing what's already committed"
        git status --short
    fi
    FREEGENT_DEPLOY=1 git push
    ok "Pushed branch '$BRANCH' → https://github.com/anttttti/FreeGent"
    ok "GitHub Pages → https://anttttti.github.io/FreeGent/ (Pages build may take ~60s)"
fi

echo
echo -e "${G}✓ Deployment complete${N}"
