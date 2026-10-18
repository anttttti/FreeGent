# Context and compaction

Models are expected to have large windows, but answer quality drops long before the window is full. FreeGent therefore keeps history small on purpose instead of waiting for an overflow.

## Compaction

History is compacted when it passes a threshold, or when a turn is cut off by the output limit.

- **Threshold:** set in **Settings → Agent → Context Management** as a percentage of the window or as a token count. The first threshold reached triggers compaction.
- **What compaction does:** your original task is pinned so it is never lost, the most recent messages are kept, and a model-written summary replaces everything in between. The summary request sends the same prefix as the main request, so providers with prefix caching can reuse it, and it starts on the model you are already using unless that one is cooling down. On a local model a long history can take a few minutes to summarise.
- **Cut-off replies:** if the output limit ends a reply mid-way, that reply is discarded, the history is compacted and the turn retried.
- **Manually:** `/compact` in the TUI. In the CLI, `--compaction-limit` (default 20000 estimated tokens) and `--context-window` set the thresholds.

The chat toolbar shows context token usage as `4.2k / 128k`, yellow at 70% and red at 90%.

## Keeping tool results small

Tool results are truncated before they enter the history (Settings → Agent → Context Management):

- **Workers:** a maximum result size in characters (default 100,000).
- **Main agent:** a maximum in characters for `read_file` (default 100,000, 0 turns it off). A larger file is replaced by an outline of its definitions with line numbers plus as many full function bodies as fit, and the agent can read ranges for the rest.

## Custom endpoints

For local and custom servers FreeGent clamps `max_tokens` to the room left in the window and uses the context length you configured. Set it to what the server really supports; see [Local models](/models/local-models).

## Worker context

Workers get scoped context by default (**Lean worker context**), and only director workers fork the full conversation. See [Roles and sub-agents](/harness/roles).
