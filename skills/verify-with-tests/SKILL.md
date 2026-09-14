---
name: verify-with-tests
description: After editing code, use the project's own test suite to verify changes (pytest, unittest, npm test, etc.) when tests exist for the affected files.
trigger_on_file_present: tests/, test/, spec/, __tests__/
trigger_on_completion: triggered
verify_criteria: The project's existing test suite was run against the edited files and all relevant tests passed.
type: rule
requires_tools: execute_code
---

## Verify before declaring complete

A test suite is present. Before COMPLETED:

1. **Run the full test file** for any file you edited — `python -m pytest tests/test_foo.py`, `npm test`, etc. Never use `-k` to exclude tests: filters hide regressions the evaluator will catch. A passing run across the full file is required. Code review, diff inspection, and "the logic looks correct" are not substitutes.
2. **If the environment blocks execution after one genuine attempt** (no compiler, pytest not installed, C extension import fails, missing system library): declare `BLOCKED: <specific reason>` — e.g. `BLOCKED: C extensions require gcc which is not installed`. One attempt is enough to confirm the environment limit; do not try to rebuild, patch build systems, or install missing dependencies.
