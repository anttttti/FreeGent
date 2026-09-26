// Build the exec sandbox bundle (fg-exec-sandbox.js) and print it to stdout.
// The dev server and `vite build` do this themselves; this is for tests and inspection:
//   node --experimental-strip-types --loader ./js-to-ts-loader.mjs scripts/build-exec-sandbox.mjs > /tmp/sbx.js
import { buildExecSandbox } from '../dev-api.ts';
process.stdout.write(await buildExecSandbox(new URL('..', import.meta.url).pathname));
