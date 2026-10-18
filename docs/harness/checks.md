# Checks, approval and safety

Weaker models make mistakes that stronger ones rarely do. The harness checks the agent's own output while it works, and asks you before risky actions.

## Step checks

- **Repaired tool calls.** When a model writes a tool call as plain text instead of a real call, FreeGent turns it into a real call.
- **Narration without action** and questions the agent could answer by looking (for example by reading a file) are flagged, and the agent is nudged to act.
- **Completion gate.** Before the agent declares a task done, checks look at what the run actually did. If the work was not verified, for example the code was never run, the agent gets one nudge to do so. A second declaration is accepted, since the agent may have a reason; a declaration that the task is blocked is never bounced.
- **Edit review** (off by default): when `write_file` would change at least half of an existing file's lines, a second model call reviews the edit before it is applied and rejects it if content was dropped or broken. It adds latency.

## Intent validation

**Settings → Agent → Tool call intent validation** compares calls to `fetch_url`, `write_file`, `execute_code` and `delete_file` with what you originally asked for, to catch prompt injection from fetched pages. The default is **Heuristic** (fast pattern checks); **LLM** is slower and catches subtler attacks.

## Approval and safety

**Settings → Agent → Tool approval** has three levels:

| Level | Asks before |
|---|---|
| Off | nothing |
| High-risk only | delete and execute |
| All writes | every write |

When the setting is left unset, FreeGent asks before each command if the code would run on your machine without isolation, and does not ask when the code runs in a browser sandbox or an isolated local sandbox. Approval does not apply inside sub-workers. After you press Stop, the rest of a tool batch does not start and does not ask for approval.

See [Code execution](/code-execution/) for what each sandbox protects and [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md) for the threat model.
