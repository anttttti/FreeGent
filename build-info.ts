// Deployment version, e.g. "v0.63.12": the benchmark version the code was released at plus a
// unique, incrementing deploy counter. Injected at build time (vite.config.ts `define`);
// "dev" when not built by a deployment (dev server, tests, headless runs).
declare const __FG_VERSION__: string | undefined;
export const FG_VERSION: string = typeof __FG_VERSION__ !== 'undefined' && __FG_VERSION__ ? __FG_VERSION__ : 'dev';
