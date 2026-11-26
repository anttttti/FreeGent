// bin/version.mjs — the one place FreeGent's version comes from, for the WebUI build (vite.config.ts), the docs
// build (docs/.vitepress/config.mts) and `freegent --version`. In order:
//   1. FG_VERSION, set by deploy.sh and the Pages workflow from the deployment tag (e.g. v1.0.77)
//   2. `git describe` against the deployment tags: the tag itself on a deployed commit, otherwise
//      e.g. v1.0.77-3-gabc1234 (3 commits later), with -dirty for uncommitted changes
//   3. "dev" when neither is available (an npm-installed copy without .git)
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fgVersion(env = process.env) {
    if (env.FG_VERSION) return env.FG_VERSION;
    try {
        const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        // Git looks in parent directories: a copy unpacked inside another checkout would report that checkout's tag.
        if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(resolve(ROOT))) return 'dev';
        // Deployment tags only (vX.Y.Z): a pre-release tag such as v1.0.78-rc.1 matches the glob but is none.
        return git(['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', 'v*-*', '--dirty']) || 'dev';
    } catch { return 'dev'; }
}

// The GitHub page for a version: the code at its tag when it is one, otherwise the repository.
export function fgVersionUrl(version) {
    const GH = 'https://github.com/anttttti/FreeGent';
    return /^v\d+\.\d+\.\d+$/.test(version) ? `${GH}/tree/${version}` : GH;
}
