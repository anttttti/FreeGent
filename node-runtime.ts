// node-runtime.ts — JSDOM-free headless bootstrap for the harness adapter path (§7).
//
// Replaces bootstrap-jsdom.ts for entry points that only need the core execution
// engine (LLM calls, tool execution, history) and not a synthetic browser environment.
//
// The harness adapter path (freegent-harness-adapter.ts) calls bootstrapNodeRuntime()
// before the first generate() call. fg-run.ts and fg-tui.tsx continue to use
// bootstrap-jsdom.ts because they load skills / tools that touch localStorage or DOM APIs.
//
// Prerequisites: Node.js 22+. Same process.env / fs as the regular headless path.
//
// Usage:
//   import { bootstrapNodeRuntime } from './node-runtime.js';
//   await bootstrapNodeRuntime({ workDir: process.cwd(), role: 'director' });

// NOTE (§7 status): This file is a stub for the transition phase.
// Full JSDOM elimination requires adding named ES module exports to all modules
// that currently only export via Object.assign(window, {...}).
// Until that dual-export pass is complete, the harness adapter still requires
// bootstrap-jsdom.ts and this file is used only for documentation / future use.
// See agentharness_migration.md §7 for the dual-export migration plan.

import { setMainAgentRole, setWorkflowMode } from './state.js';

export interface NodeRuntimeConfig {
    /** Working directory for workspace file operations. Default: process.cwd(). */
    workDir?: string;
    /** Agent role name. Default: 'director'. */
    role?: string;
    /** If true, the agent must complete autonomously (no user prompts). Default: false. */
    workflowMode?: boolean;
}

let _bootstrapped = false;

/**
 * Bootstrap the FreeGent runtime for Node.js headless execution without JSDOM.
 *
 * Idempotent: safe to call multiple times; only runs once per process.
 *
 * CURRENT STATUS: Partial. The full JSDOM-free path requires §7 dual-export pass.
 * This function sets up the minimal state that doesn't require JSDOM. Modules that
 * still use window.* globals (workspace, skills, config) must be loaded separately
 * via the JSDOM path for now.
 */
export async function bootstrapNodeRuntime(config: NodeRuntimeConfig = {}): Promise<void> {
    if (_bootstrapped) return;
    _bootstrapped = true;

    const { role = 'director', workflowMode = false } = config;

    // Set role and workflow mode in state (these use ES module exports, no JSDOM needed)
    setMainAgentRole(role);
    setWorkflowMode(workflowMode);

    // Workspace adapter, skills, and session store are initialised by headless-runner.ts::setup()
    // via JSDOM. Migrating those imports here is a future refactor task.
}

/**
 * Reset bootstrap state (for testing).
 */
export function _resetBootstrap(): void {
    _bootstrapped = false;
}
