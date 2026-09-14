#!/usr/bin/env node
/**
 * gen-role-docs.mjs
 * Regenerates 02–05_*_role.txt documentation files from BUILTIN_ROLES in workers.ts.
 * Run whenever roles change: node scripts/gen-role-docs.mjs
 *
 * Tool lists in the generated files come directly from role.tools in the source —
 * they are never written by hand.  At runtime, _filterRoleBody() further intersects
 * role.tools with enabledTools, so the model only sees what it can actually call.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = resolve(__dir, '..');
const src   = readFileSync(resolve(root, 'workers.ts'), 'utf8');

const HR = '━'.repeat(60);

// ── template-literal extractor ────────────────────────────────────────────────
// Scans from `startPos` to find the opening backtick, then returns the raw content
// up to (but not including) the matching closing backtick, handling ${...} nesting.
function extractTemplateLiteral(src, startPos) {
    let i = startPos;
    while (i < src.length && src[i] !== '`') i++;
    if (i >= src.length) throw new Error(`No backtick found from pos ${startPos}`);
    i++; // skip opening backtick
    let out = '';
    let exprDepth = 0;
    while (i < src.length) {
        if (exprDepth === 0 && src[i] === '`') return { content: out, end: i };
        if (src[i] === '\\' && exprDepth === 0) { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { exprDepth++; out += '${'; i += 2; continue; }
        if (exprDepth > 0 && src[i] === '}') { exprDepth--; }
        out += src[i]; i++;
    }
    throw new Error('Unterminated template literal');
}

// ── BUILTIN_ROLES block extractor ─────────────────────────────────────────────
// Character-level scanner that respects template literals, strings, and brace
// depth so role boundaries are always found correctly regardless of body content.
function parseBuiltinRoles(src) {
    const arrayStart = src.indexOf('const BUILTIN_ROLES = [');
    if (arrayStart < 0) throw new Error('BUILTIN_ROLES not found in workers.ts');

    let i = src.indexOf('[', arrayStart) + 1;
    const roles = [];

    while (i < src.length) {
        // Skip whitespace / commas between objects
        while (i < src.length && (src[i] === ',' || /\s/.test(src[i]))) i++;
        if (src[i] === ']') break; // end of array
        if (src[i] !== '{') { i++; continue; }

        // Scan the full role object, respecting strings and template literals
        const objStart = i;
        let depth = 1; i++;
        let inStr = false; let strCh = '';
        let inTpl = false; let exprD = 0;

        while (i < src.length && depth > 0) {
            const c = src[i];
            if (inStr) {
                if (c === '\\') { i += 2; continue; }
                if (c === strCh) inStr = false;
                i++; continue;
            }
            if (inTpl) {
                if (exprD === 0 && c === '`') { inTpl = false; i++; continue; }
                if (c === '\\') { i += 2; continue; }
                if (c === '$' && src[i + 1] === '{') { exprD++; i += 2; continue; }
                if (exprD > 0 && c === '}') { exprD--; i++; continue; }
                i++; continue;
            }
            if (c === '`') { inTpl = true; i++; continue; }
            if (c === '"' || c === "'") { inStr = true; strCh = c; i++; continue; }
            if (c === '{') { depth++; i++; continue; }
            if (c === '}') { depth--; i++; continue; }
            i++;
        }

        const objSrc = src.slice(objStart, i);
        roles.push(extractRole(objSrc, src, objStart));
    }
    return roles;
}

function extractRole(objSrc, fullSrc, objOffset) {
    const nameM = objSrc.match(/\bname:\s*'([^']+)'/);
    const descM = objSrc.match(/\bdescription:\s*'([^']+)'/);
    const tierM = objSrc.match(/\btier:\s*'([^']+)'/);
    const toolM = objSrc.match(/\btools:\s*new Set\(\[([^\]]+)\]\)/);

    const name        = nameM?.[1] ?? '(unknown)';
    const description = descM?.[1] ?? '';
    const tier        = tierM?.[1] ?? 'execution';
    // Use matchAll to pick only quoted strings — ignores comments inside new Set([...])
    const tools       = toolM
        ? [...toolM[1].matchAll(/'([^']+)'/g)].map(m => m[1])
        : [];

    // body: is a template literal; find it within the full source at objOffset.
    // body_fn: dynamic body — extract the `return \`` template literal inside the function.
    let body = '';
    const bodyKey    = 'body:';
    const bodyFnKey  = 'body_fn(';
    const bodyIdx    = objSrc.indexOf(bodyKey);
    const bodyFnIdx  = objSrc.indexOf(bodyFnKey);

    if (bodyIdx >= 0 && (bodyFnIdx < 0 || bodyIdx < bodyFnIdx)) {
        // Static body: template literal directly assigned to `body:`
        ({ content: body } = extractTemplateLiteral(fullSrc, objOffset + bodyIdx + bodyKey.length));
    } else if (bodyFnIdx >= 0) {
        // Dynamic body_fn: find `return \`` inside the function block and extract that literal.
        const fnStart  = objOffset + bodyFnIdx;
        const retIdx   = fullSrc.indexOf('return `', fnStart);
        if (retIdx >= 0) {
            ({ content: body } = extractTemplateLiteral(fullSrc, retIdx + 'return'.length));
        }
    }

    return { name, description, tier, tools, body };
}

// ── runtime interpolation notes ───────────────────────────────────────────────
// Map from interpolation expression to human-readable description for the docs.
const INTERPOLATION_NOTES = {
    '_roleConciseBlock':        '[injected when concise prompts are enabled: ## Conciseness — telegraphic style, outcome-only summary]',
    'availableToolsSection':    '[dynamic ## Available tools section — built at call time from enabledTools; lists only active tools and their worker role descriptions]',
};

function annotateBody(body) {
    return body.replace(/\$\{([^}]+)\}/g, (_, expr) =>
        INTERPOLATION_NOTES[expr.trim()] ?? `\${${expr}}`
    );
}

// ── sent-to descriptions ──────────────────────────────────────────────────────
const SENT_TO = {
    director:   'main agent system prompt when mainRole = director (bench, headless, or user-selected)\n         also used as worker system prompt when run_workers spawns a director sub-worker',
    researcher: 'worker system prompt when run_workers spawns a researcher sub-worker\n         (also used as main-agent prompt when --role=researcher)',
    coder:      'worker system prompt when run_workers spawns a coder sub-worker',
    planner:    'worker system prompt when run_workers spawns a planner sub-worker',
};

const FILE_MAP = {
    director:   '02_director_role.txt',
    researcher: '03_researcher_role.txt',
    coder:      '04_coder_role.txt',
};

// ── generate ──────────────────────────────────────────────────────────────────
const roles = parseBuiltinRoles(src);
console.log(`Parsed ${roles.length} roles: ${roles.map(r => r.name).join(', ')}`);

for (const role of roles) {
    const outFile = FILE_MAP[role.name];
    if (!outFile) {
        console.log(`  skip: no FILE_MAP entry for '${role.name}'`);
        continue;
    }

    const sentTo  = SENT_TO[role.name] ?? '(see workers.ts)';
    const toolList = role.tools.join(', ') || '(none)';
    // body_fn roles generate their body at call time (dynamic tool lists); call it for docs.
    const rawBody  = typeof role.body_fn === 'function' ? role.body_fn() : role.body;
    const body     = annotateBody(rawBody.trim());

    const content = [
        `SOURCE: workers.ts — BUILTIN_ROLES entry for '${role.name}'`,
        `GENERATED: by scripts/gen-role-docs.mjs — do not edit by hand; run the script to update`,
        `SENT TO: ${sentTo}`,
        '',
        HR,
        '',
        body,
        '',
        HR,
        `NOTES:`,
        `- role.tools (API ceiling): ${toolList}`,
        `- _filterRoleBody() removes any of the above absent from enabledTools at runtime.`,
        `- Effective tool set the model sees = role.tools ∩ enabledTools.`,
        `- tier: ${role.tier} — ${role.tier === 'orchestrator' ? 'can spawn sub-workers via run_workers' : 'cannot spawn sub-workers'}.`,
        role.description ? `- description: ${role.description}` : null,
    ].filter(l => l !== null).join('\n');

    const outPath = resolve(root, outFile);
    writeFileSync(outPath, content, 'utf8');
    console.log(`  wrote ${outFile} (${role.tools.length} tools)`);
}

// ── 05_planner_role.txt — note removal from BUILTIN_ROLES ────────────────────
const plannerPath = resolve(root, '05_planner_role.txt');
const plannerNote = [
    `SOURCE: workers.ts — BUILTIN_ROLES`,
    `GENERATED: by scripts/gen-role-docs.mjs — do not edit by hand; run the script to update`,
    `STATUS: planner role removed from BUILTIN_ROLES`,
    '',
    HR,
    '',
    `The 'planner' role is no longer defined in BUILTIN_ROLES in workers.ts.`,
    '',
    `It was previously used as a sub-worker role for generating execution plans.`,
    `Its functionality was absorbed into the director role (which reads and delegates`,
    `planning inline) and into custom roles/ workspace files when needed.`,
    '',
    `If you want to restore the planner, add an entry to BUILTIN_ROLES in workers.ts`,
    `and re-run: node scripts/gen-role-docs.mjs`,
    '',
    HR,
    `NOTES:`,
    `- Not in BUILTIN_ROLES — run_workers cannot spawn a planner sub-worker.`,
    `- Custom role files in roles/ can define a 'planner' role; see workers.ts _parseRoleFile().`,
].join('\n');
writeFileSync(plannerPath, plannerNote, 'utf8');
console.log(`  wrote 05_planner_role.txt (removed-role note)`);

console.log('Done.');
