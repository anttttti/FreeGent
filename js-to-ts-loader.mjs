// Node.js --loader: redirects './X.js' imports to './X.ts' when X.js doesn't exist.
// Needed in the headless Docker runner: TypeScript source files use .ts but ES module
// imports reference .js (the TypeScript/Vite convention for browser builds). Node.js
// gets the literal .js path, which fails. This loader intercepts those and falls back
// to the .ts equivalent.
// Use with --experimental-strip-types to also handle TypeScript syntax in the .ts files.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';

export function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.startsWith('file://')) {
        const dir = dirname(fileURLToPath(context.parentURL));
        const jsPath = pathResolve(dir, specifier);
        if (!existsSync(jsPath)) {
            const tsPath = jsPath.replace(/\.js$/, '.ts');
            if (existsSync(tsPath)) {
                return { shortCircuit: true, url: pathToFileURL(tsPath).href };
            }
        }
    }
    return nextResolve(specifier, context);
}
