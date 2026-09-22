// Vitest setupFile — loads shared window globals before each test file.
// Plain-JS source files (no imports, no/minimal TS annotations) are eval'd so their
// function declarations and Object.assign bridges land on window.
// TypeScript source files that import from state.js are loaded via dynamic import;
// vitest transforms them, and their Object.assign(window, …) bridges run automatically.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf-8');

// Stub fetch as a vitest mock so agent.test.ts can call window.fetch.mockReset() and
// control return values per-test without hitting the network.
vi.stubGlobal('fetch', vi.fn());

// All source files are ES modules now (ESM migration complete) — vitest transforms
// them and their Object.assign(window, …) bridges run automatically on import.
// state.ts must come first: it sets up reactive window properties for openaiHistory,
// _seenReadFiles, setSeenReadFiles, softStopPending, mainAgentRole, etc.
await import('../state.ts');
// config.ts: enabledTools, skillsRegistry, activeSkills, all get*() functions
await import('../config.ts');
// session-schema.ts / session-store.ts: SESSION_SCHEMA_SQL, setSessionStore, session* wrappers
await import('../session-schema.ts');
await import('../session-store.ts');
// tools.ts: toolLabel, executeToolAsync
await import('../tools.ts');
// workers.ts: resolveWorkerModelSpec, callLLMComplete — now imports state.js, so it loads
// as a real module (after config.ts eval: its top level calls getAgentConcisePrompts()).
await import('../workers.ts');
// model-caps.ts: parseFnTagCalls, getModelToolFormat
await import('../model-caps.ts');
// tool-schemas.ts: _hasBashOrCode, buildOAITools, buildGeminiTools, activeTools
await import('../tool-schemas.ts');
// skill-guidance.ts: evaluateSkillTriggers, _skillExcludedForRole, buildTriggeredGuidance
await import('../skill-guidance.ts');
// turn-context.ts: applyTurnTriggers, buildTurnPrelude, buildWorkspaceIndex — shared
// per-turn evaluation for both the interactive and headless entry points
await import('../turn-context.ts');
// nudge-emitter.ts: emitNudge — window bridge for nudge logging
await import('../nudge-emitter.ts');
// payload-builder.ts: buildChatPayload, isCustomEndpoint — shared OAI payload construction
await import('../payload-builder.ts');
// detectors.ts: _updateStuckDetector, _checkTextResponse, _fpTrunc
await import('../detectors.ts');
// tool-call-repair.ts: _repairToolCallArgs, _repairToolNames, _repairExecCodeArgs, aliases
await import('../tool-call-repair.ts');
// history.ts: truncateResultForHistory, pruneOAIHistory, repairHistoryArray, _normPath
await import('../history.ts');
// model-router.ts: specToEndpoint, cooldowns, modelFriendlyName, resolveWorkerModelSpec
await import('../model-router.ts');
// stream-decode.ts: readSSE, streamOAICompat, nonStreamOAICompat, streamGeminiSSE
await import('../stream-decode.ts');
// retry.ts: withRetry, isTransient, retry handlers, _parseRetryAfter
await import('../retry.ts');
// deep-research.ts: extractRelevant (callLLMComplete must be stubbed per-test)
await import('../deep-research.ts');
// system-prompt.ts: buildSystemPrompt (needs enabledTools + _hasBashOrCode on window)
await import('../system-prompt.ts');
// workspace.ts: initDB, agentReadFile, agentWriteFile, agentListFiles, agentDeleteFile, etc.
await import('../workspace.ts');
// search-providers.ts: tavilySearch, braveSearch, wikipediaSearch, performWebSearch
await import('../search-providers.ts');
// qa.ts: transitionTask, setTaskStatus, _updateLedgerRow — update_task_status routes
// through these, so they must exist here as they do in index.html and headless-runner.
await import('../qa.ts');
// chat-render.ts: renderMarkdown, cleanResponse, createResponsePlaceholder, appendMessage
await import('../chat-render.ts');
