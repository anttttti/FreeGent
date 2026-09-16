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
