# System Prompts

These files are **generated snapshots** of the runtime prompts used by FreeGent's agent system.
Run `node scripts/gen-role-docs.mjs` to regenerate them from the current source.

The actual prompts are built dynamically at runtime by `system-prompt.ts` and `workers.ts`
using `body_fn()` closures that inspect enabled tools, the active environment (browser /
headless / Docker), and active skills. These `.txt` files are reference snapshots only —
editing them has no effect.

| File | Snapshot of |
|------|-------------|
| `system-prompt.txt` | Main agent system prompt (no active role) |
| `director-role.txt` | Director role body (main agent role) |
| `researcher-role.txt` | Researcher worker role body |
| `coder-role.txt` | Coder worker role body |
| `planner-role.txt` | Planner worker role body |
| `tool-classifier-prompt.txt` | Tool-use classification prompt |
| `step-validation-prompts.txt` | Step validation judge prompts |
| `answer-grounding-judge.txt` | Answer grounding / hallucination detection judge |
| `nudges-and-completion-gate.txt` | Completion detection and nudge prompts |
