---
name: data-fallback
description: Fallback strategy when web fetches keep failing — switch from direct downloads to Python data libraries and known-good sources instead of retrying dead URLs. Auto-injected after repeated HTTP errors.
trigger: download data, dataset, historical data, csv download, fetch the data, time series, stock prices, market data
trigger_on_filetype: .csv, .tsv, .xlsx, .xls, .parquet
trigger_on_failure: http_error x3
requires_tools: fetch_url
---

## You have hit several failed fetches in a row — stop and change approach

Repeatedly calling `fetch_url` on download links, CSV export endpoints, or "raw" file URLs is a known dead end: many data hosts return `error code: 5xx`, a `404`, or a "page not found" / "security controls triggered" HTML body **with status 200** when hit from a server rather than a browser. Retrying variants of the same URL wastes steps. Do this instead:

### 1. Use a Python data library via `execute_code` (preferred)
Most structured data is reachable through a library that handles auth, headers, and parsing for you:
- **Financial / market data** (stock indices, equities, FX): `yfinance` (`yf.download(...)`), `pandas_datareader` (FRED, Stooq, Tiingo). Install with micropip.
- **Tabular data on a web page** (Wikipedia tables, reference pages): fetch the page text with `fetch_url`, then parse with `pandas.read_html(...)` or extract the values directly from the returned text.
- **General datasets**: try `pandas.read_csv("<raw-url>")` from inside `execute_code` — the sandbox fetch path differs from `fetch_url` and sometimes succeeds where it failed.

### 2. Switch to a source that serves data programmatically
- Prefer official APIs and Stooq/Tiingo/FRED-via-library over scraping `macrotrends`, `spglobal`, or Yahoo's HTML pages (these block or rate-limit server fetches).
- For reference figures, Wikipedia article text (already fetched) often contains the numbers — read what you already have before fetching more.

### 3. Do NOT fabricate data to unblock yourself
If no source and no library yields the real data, say so explicitly and report what you tried. If you fall back to hand-entered or approximate figures, you **must** label them clearly as approximate and state the source — never present invented numbers as authoritative. Silent fabrication is worse than reporting the limitation.

### 4. One change at a time
Make a single new attempt with a genuinely different method (library, not another URL), verify it returned real data (print `df.head()` / `df.shape`), then proceed. Do not fan out into many more `fetch_url` calls.
