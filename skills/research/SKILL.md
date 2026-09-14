---
name: research
description: Research a topic and save a cited report to the workspace. For most topics use the deep_research tool directly; this skill adds guidance for academic literature and parallel multi-angle research.
requires_tools: web_search,fetch_url
---

When invoked with `/research [topic]`:

**For most topics** — call `deep_research` directly. It plans sub-questions, searches multiple sources, and saves a cited report to `research/` automatically. No further steps needed.

**For academic/scientific topics** — supplement `deep_research` with `academic_search`:

| Need | Tool + source |
|---|---|
| Preprints, CS/math/physics | `academic_search` `source:"arxiv"` |
| Most-cited / cross-discipline | `academic_search` `source:"semantic_scholar"` |
| Biomedical peer-reviewed | `academic_search` `source:"pubmed"` |

arXiv field prefixes: `ti:` title, `au:` author, `abs:` abstract, `cat:` category (e.g. `cat:cs.AI`).

**For broad topics needing parallel coverage** — use `run_workers` (one worker per angle: background, current state, applications, limitations, comparisons), then synthesize into a single report. Only use this when `deep_research` alone would miss important angles due to topic breadth.

**Do not fabricate citations.** Only link to URLs actually returned by search tools.
