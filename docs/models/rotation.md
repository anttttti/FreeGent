# Priority, fallbacks and retries

Free tiers have per-minute and per-day limits, and any provider can fail at any moment. FreeGent treats that as normal: it keeps an ordered list of models, moves down the list when one is limited or failing, and retries what can be retried.

## The priority list

**Settings → Models → Model Priority** is the list FreeGent works through, top first.

- **✦ Populate** asks a model (the utility model) to rank all text-capable models, including ones on a cooldown, and replaces the list with the ten best. Each ranked model is added with every provider that offers it, kept together, so the list can hold more than ten entries and rotation tries the same model elsewhere before moving to the next one.
- **Defaults** restores the shipped list and resumes paused models.
- The shipped list and the model catalog are refreshed from the providers from time to time (**Check for updates** in the Model Catalog). The ranking prompt and the update dialog include results from FreeGent's own long-conversation tests when a model has been tested: tasks solved per area and the largest context it held.

## Cooldowns

A model that answers `429` (rate limited) goes on a cooldown and the next model takes over.

- The base cooldown is set in **Settings → Agent** ("Rate-limit cooldown", in minutes). It doubles on each consecutive hit for the same endpoint and is capped at 10 minutes.
- If every model is cooling down, FreeGent waits for the shortest cooldown instead of failing.
- A `402` (payment required, or a free allowance used up) cools down the model and its free siblings until the reset the error names, or for an hour.
- Cooldowns are kept in this browser, so reloading the page does not make FreeGent try an exhausted model again. Point at the model name in the chat header to see which models are cooling down and for how long; **Clear cooldowns** there forgets them, for example after you add credit or a new key.
- Hover the model name in the chat toolbar to see which models are cooling.

## Rotation

By default a turn stays on the first available model. **Rotate endpoints every N steps** (Settings → Agent) uses each model for N consecutive steps and then moves to the next, which spreads load across per-model token-per-minute limits. A new turn always starts again from the first model.

## Worker and utility models

- **Worker Model**: "Default" lets workers follow the priority rotation, "Priority model" always uses model #1.
- **Role model routing** (Settings → Agent): planning workers use your first model, execution workers use later ones.
- **Utility Model**: a separate, lighter model for short side calls: chat titles, prompt suggestions, tool classification, Populate's ranking and the judge calls of the output checks. Left unset it is a Google Gemma model, unless your first model is a custom endpoint or Settings → Privacy is stricter than Routed (Provider-only, the default, counts), in which case it follows your first model. Set it to "None" to switch titles and suggestions off; the other calls then use a model from your list.

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

Default (no thinking setting is sent, so the endpoint decides), Off, Low, Medium or High: one setting that is saved in profiles and mapped to each provider's own setting (token budgets for some, effort levels for others). **Worker thinking budget** is separate: inherit, low (1K tokens), medium (8K) or high (24K, the default, since workers often take the harder sub-problems). For vLLM, **Preserve thinking across turns** re-inserts each step's reasoning into later turns, which helps Qwen3 and similar models.
