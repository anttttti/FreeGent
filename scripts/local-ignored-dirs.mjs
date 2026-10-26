// Top-level directories this checkout keeps out of git (`/name/` lines in .gitignore and .git/info/exclude): scratch areas, notes,
// results and sibling repositories that may hold thousands of files. Dev tooling that walks or watches the tree skips them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function localIgnoredDirs(root = process.cwd()) {
    const dirs = new Set();
    for (const file of ['.gitignore', '.git/info/exclude']) {
        let text = '';
        try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            const m = /^\/([\w.-]+)\/\s*$/.exec(line);
            if (m) dirs.add(m[1]);
        }
    }
    return [...dirs];
}
