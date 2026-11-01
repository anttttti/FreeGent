// Deployment version, e.g. "v1.0.77": the version series plus a unique, incrementing deploy counter.
// Injected at build time (vite.config.ts `define`, from bin/version.mjs); a dev server gets `git describe`
// (e.g. "v1.0.77-3-gabc1234-dirty"), and "dev" is left when nothing injected it (tests, headless runs).
declare const __FG_VERSION__: string | undefined;
export const FG_VERSION: string = typeof __FG_VERSION__ !== 'undefined' && __FG_VERSION__ ? __FG_VERSION__ : 'dev';

// The code at that version on GitHub (Settings links to it), injected alongside it; the repository otherwise.
declare const __FG_VERSION_URL__: string | undefined;
export const FG_VERSION_URL: string = typeof __FG_VERSION_URL__ !== 'undefined' && __FG_VERSION_URL__ ? __FG_VERSION_URL__ : 'https://github.com/anttttti/FreeGent';
