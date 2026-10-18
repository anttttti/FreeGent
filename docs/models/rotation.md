# Priority, fallbacks and retries

Free tiers have per-minute and per-day limits, and any provider can fail at any moment. FreeGent treats that as normal: it keeps an ordered list of models, moves down the list when one is limited or failing, and retries what can be retried.

## The priority list

**Settings → Models → Model Priority** is the list FreeGent works through, top first.

- **✦ Populate** asks a model to rank all available, non-cooling models by capability and replaces the list with the top ten.
- **Defaults** restores the shipped list and resumes paused models.
- The shipped list and the model catalog are refreshed from the providers from time to time (**Check for updates** in the Model Catalog). The ranking prompt and the update dialog include results from FreeGent's own long-conversation tests when a model has been tested: tasks solved per area and the largest context it held.

## Cooldowns

A model that answers `429` (rate limited) goes on a cooldown and the next model takes over.

- The base cooldown is set in **Settings → Agent** ("Rate-limit cooldown", in minutes). It doubles on each consecutive hit for the same endpoint and is capped at 10 minutes.
- If every model is cooling down, FreeGent waits for the shortest cooldown instead of failing.
- Hover the model name in the chat toolbar to see which models are cooling.

## Rotation

By default a turn stays on the first available model. **Rotate endpoints every N steps** (Settings → Agent) uses each model for N consecutive steps and then moves to the next, which spreads load across per-model token-per-minute limits. A new turn always starts again from the first model.

## Worker and utility models

- **Worker Model**: "Default" lets workers follow the priority rotation, "Priority model" always uses model #1.
- **Role model routing** (Settings → Agent): planning workers use your first model, execution workers use later ones.
- **Utility Model**: a separate model for chat titles and prompt suggestions. Set it to "None" to switch those calls off.

See [Roles and sub-agents](/harness/roles).

## Retries and errors

| Situation | What FreeGent does |
|---|---|
| Rate limit (`429`) | Cooldown on that model, continue with the next |
| Transient server error | Retried with backoff (fixed or exponential in the CLI) |
| Context overflow | Parse how much room the server has, compact the history and retry |
| Reply cut off by the output limit | Discard it, compact and retry |
| The same message rejected with `400` twice | End the turn instead of looping |

Retry timing in the CLI is set with `--retry-mode` (`exponential` or fixed) and `--retry-fixed-ms`.

On custom endpoints FreeGent also clamps `max_tokens` to the room left in the window, so a long history does not trigger overflow errors in the first place.

## Thinking level

Off, low, medium or high, one setting that is saved in profiles and mapped to each provider's own setting (token budgets for some, effort levels for others). **Worker thinking budget** is separate: inherit, low (1K tokens), medium (8K) or high (24K, the default, since workers often take the harder sub-problems). For vLLM, **Preserve thinking across turns** re-inserts each step's reasoning into later turns, which helps Qwen3 and similar models.
