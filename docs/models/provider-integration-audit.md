# MoonMath and APInex integration audit

Compared against Google, OpenRouter, Groq, NVIDIA, Nous, TokenHarbor, Kilo, and Vercel on 2026-11-01. This audit covers repository integration; publishing the frontend and Worker remains a separate step.

| Area | Checked behavior / corrections |
|---|---|
| Credentials | Both inputs render, retain the requested prefixes for server-held keys, save, reload, override, and clear. APInex recognizes bare `sk-apx...` keys. Generic `sk-` keys remain ambiguous. |
| Credential boundaries | Both server placeholders substitute only for the exact HTTPS API host. Worker secrets, developer-key availability, and lookalike-host rejection are covered. Values are excluded from profiles and agent command environments. |
| CLI and TUI | Both named providers and environment aliases resolve. Explicit TUI provider selection now chooses that provider's key instead of the first available key for another provider. |
| Routing | Main, worker, utility/background, and compaction paths use the existing shared request/payload infrastructure. The static frontend routes shared keys through the Worker; native headless calls go directly. |
| Catalog and selectors | Defaults, priority selection, add-model form, worker/utility selectors, model-page links, canonical model grouping, key availability, and privacy gating are wired. |
| Discovery | MoonMath authenticated catalog + alias deduplication + conservative free-model allowlist; APInex authenticated catalog joined to live public free-eligibility metadata. Missing metadata does not remove the saved catalog. |
| Saved discovery metadata | Context, modalities, tools, and documented reasoning capabilities survive Apply. No-tools filtering is visible and active by default. Runtime reasoning/tool capability checks honor discovered custom entries. |
| Media | All 11 default routes were probed with a random image code. Nine read it correctly: both MoonMath routes and seven APInex routes. Two APInex routes rejected images despite public metadata advertising vision; they stay text-only. Audio/video/speech are not inferred from generic API compatibility. |
| Thinking | Main and worker controls share budget mapping. Default omits controls; background requests use the lowest documented setting. MoonMath GLM and APInex GLM/DeepSeek cannot be assumed to disable reasoning. Unsupported fields retain the shared retry fallback. |
| Quotas | APInex has one proactive account RPM counter, a documented free baseline, and response-header updates for other limits. Compaction counts too. Model subscription refusals, account RPM, wallet/key allowance, and free allowance have separate cooldown scopes. Retry/reset headers are readable through both proxies. |
| Errors and recovery | Native tool-call round trips and full read-file runs were verified earlier. HTTP errors retain status/message. Unit coverage checks subscription refusals, account cooldowns, reset formats, and fallback behavior. Daily exhaustion has not been forced live. |
| Browser / headless loading | The new getters and rate-limit helper are declared and bridged. The headless probe checks their availability. Production build and browser credential/proxy smoke checks run without exposing credentials. |

Remaining limitations are explicit: MoonMath does not label free eligibility in `/v1/models`, so a newly advertised free model needs an allowlist update. APInex's public eligibility endpoint has no browser CORS header and needs a proxy from a hosted page; Provider-only privacy cannot silently bypass that restriction. Exact daily free allowances and sustained throughput have not been measured. Advertised context lengths have not been stress-tested to their maximum.

Regression coverage is in `tests/apinex-provider.test.ts`, `tests/moonmath-provider.test.ts`, `tests/key-paste.test.ts`, `tests/quota-cooldown.test.ts`, `tests/compaction.test.ts`, `tests/html-escape-dotenv.test.ts`, and existing routing, proxy, privacy, profile, and key-exposure tests.
