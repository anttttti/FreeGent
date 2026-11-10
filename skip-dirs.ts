// skip-dirs.ts — FreeGent: folders that hold dependencies, build output or caches, not the project's own files.
//
// Five hand-kept lists said this and disagreed (a Rust `target/` was left out when a folder was imported and walked when it was opened live; the
// headless runner had six entries). One list, in two tiers: the base set is skipped everywhere; a person's browser folder also skips the extras,
// whose names (`vendor`, `env`, `out`) can be a project's own code and so are not hidden from the agent in a headless run.
//
// Pure data, no imports.

/** Skipped by every file walk: version control, dependency folders, virtual environments, build output, tool caches. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'target', '.next', '.nuxt', '.svelte-kit', '.vite', '.parcel-cache',
    '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.cache',
]);

/** A folder the person picked or imported in the browser also skips these (and the OS's `.DS_Store`). */
export const BROWSER_FOLDER_SKIP_DIRS: ReadonlySet<string> = new Set([
    ...SKIP_DIRS,
    'out', 'env', 'vendor', 'bower_components', 'coverage', '.nyc_output', '.npm', '.pnp', '.yarn', '.DS_Store',
]);
