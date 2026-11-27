# poc-playwright-webmcp

Throwaway proof of concept. Archive rather than maintain. No blog post yet.

## Question

Can a test (or an agent harness) reliably discover and call the tools a page registers through WebMCP using Playwright's `page.webmcp`, what breaks, and how does that compare with driving the same page through DOM selectors? No LLM is involved: every figure below is a deterministic script run.

## Method

- `app/index.html` is a tiny shop page. It has a DOM UI (search, add to cart, total, checkout) and registers WebMCP tools backed by the same cart logic: `search_products`, `add_to_cart`, `get_cart`, `checkout`, plus `echo_qty` (no page-side validation, to see whether the browser validates schemas), `boom` (throws) and `hang` (never resolves).
- Query parameters switch behaviour: `?v=2` renames every test id and label in the DOM UI, `?late=<ms>` registers the tools that many milliseconds after load, `?tools=0` registers none.
- `src/bench.mjs` runs three experiments, N = 50 runs each, each run in a fresh browser context:
  1. **e1**: the same task (add 2 mugs and 1 lamp, expect total 54) via `page.webmcp.callTool` and via `getByTestId` actions written for UI variant 1, run against UI variant 1 and variant 2. State is also checked independently in the page.
  2. **e2**: tools registered 0, 50, 200 and 1000 ms after load. Read immediately after `goto` (load event), and with a 10 ms polling loop.
  3. **e3**: failure modes (bad input, unknown tool, throwing tool, hanging tool, browser without the flag, page without tools).
- Versions: Playwright 1.65.1, Chromium 159.0.8154.6 (Playwright build, headless shell), Node 24.14.1, macOS arm64, launched with `--enable-features=WebMCP`.

## Measured answer (N = 50 per row; raw data in `results/`)

Short answer: discovery and calls were 100% reliable in every case where the tools existed at the moment of the call. The things that went wrong were timing, missing schema enforcement and lost error detail.

Same task, WebMCP vs DOM (`results/e1_task.csv`, `results/summary.json`):

| UI | Method | Passed | Protocol steps | Median task time | p95 |
|---|---|---|---|---|---|
| v1 | WebMCP | 50/50 | 6 | 9.6 ms | 10.6 ms |
| v1 | DOM test ids | 50/50 | 8 | 134.8 ms | 150.8 ms |
| v2 (renamed ids) | WebMCP | 50/50 | 6 | 9.1 ms | 9.9 ms |
| v2 (renamed ids) | DOM test ids | 0/50 | n/a | 1001 ms (1000 ms timeout) | 1002.5 ms |

Steps count the calls an agent would have to make (tool calls or DOM actions). The DOM figure is low for a real page because the locators are known in advance; an agent without them also needs snapshots to find them. The timing gap comes mostly from Playwright's actionability checks, so it says little about an LLM.

Tools registered after load (`results/e2_late_registration.csv`):

| Registration delay | Found on immediate read | Found when polling | Median time until found |
|---|---|---|---|
| 0 ms | 50/50 | 50/50 | 3.2 ms |
| 50 ms | 0/50 | 50/50 | 59.1 ms |
| 200 ms | 0/50 | 50/50 | 209.2 ms |
| 1000 ms | 0/50 | 50/50 | 1008.5 ms |

`page.webmcp.tools()` does not wait. It returns an empty list, with no error, if the page has not registered yet.

Failure modes (`results/e3_failure_modes.csv`, 50 runs each, outcome identical in all 50):

- **No schema enforcement.** `echo_qty` declares `qty` as an integer with minimum 1, required, no extra properties. Through `page.webmcp.callTool`, `{qty: "3"}`, `{qty: 0}`, `{}` and an extra property all reached the page's `execute` function unchanged and returned normally. The page has to validate its own input.
- **Page-reported errors** (`isError: true`) come back as a normal result, not an exception. A test must check `result.isError`.
- **Unknown tool**: throws, and the message lists the available tools.
- **Tool that throws**: throws `OperationError: Tool execution failed.` The original message ("boom") is not included.
- **Hanging tool**: throws `Timeout 500ms exceeded` with an explicit timeout. The default is no timeout, so a hanging tool hangs the test.
- **Browser launched without the flag**: `tools()` throws `WebMCP is not enabled`. A page that registers nothing returns an empty list.

## What was not testable or not covered

- WebMCP is behind `--enable-features=WebMCP` in this Chromium. The page-side object in this build is `document.modelContext`, not `navigator.modelContext` (which is undefined here). Playwright checks both. A page that only looks for `navigator.modelContext` registers nothing in this build and nothing tells you why.
- Tool annotations: the page-side hint for a consequential tool is `consequentialHint`. My first version of the page used `consequential` and Playwright reported no annotation. Names matter and are silently dropped.
- Not run: Playwright MCP with its WebMCP support (`--no-webmcp` opt-out), Firefox, other Chromium builds, headed mode.
- No tokens or agent behaviour are measured. Step counts are scripted calls, not what a model would choose. Nothing here says an LLM picks WebMCP tools better than DOM clicks.
- One toy page on localhost, one machine, one browser build. Timings are from a warm local run and show relative orders of magnitude only. The DOM v2 failure is by construction: it shows selector fragility, not that DOM driving is generally worse (role and text locators would survive some renames).

## Rerun

```
npm ci
npx playwright install chromium
npm test          # 6 checks of the findings above
npm run bench     # N=50, writes results/ (about 3 minutes)
N=5 OUT=/tmp/quick node src/bench.mjs   # quick variant
```

CI runs the tests and the N=50 benchmark and uploads the results as an artifact.

## Licence

MIT.

<!-- links:start -->
## Links

- Write-up: [Playwright WebMCP: Calls Pass 50 of 50, First Read Misses Late Tools](https://garyparker.dev/blog/playwright-webmcp)
- Video: [youtu.be/n3WWeNLxZds](https://youtu.be/n3WWeNLxZds)
- More experiments: [garyparker.dev/measured](https://garyparker.dev/measured)
- Newsletter: [garyparker.dev/newsletter](https://garyparker.dev/newsletter)
<!-- links:end -->
