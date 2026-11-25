#!/usr/bin/env bash
# deploy.sh — the deployment script lives in the bench repo (bench/deploy.sh); this keeps `./deploy.sh [--git-only|--worker-only|--check-only]` working.
here="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # CDPATH set: cd printed the directory itself, and the path came out twice
[ -x "$here/bench/deploy.sh" ] || { echo "deploy.sh: bench/deploy.sh is missing (the bench repo is not checked out in $here/bench)" >&2; exit 1; }
exec "$here/bench/deploy.sh" "$@"
