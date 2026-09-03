# swipekit

Local TikTok slideshow research. Find which photo-post formats are winning in a
niche and why, with evidence a reader could check.

Node 24 + TypeScript (native type stripping) · Playwright (real Chrome) ·
`node:sqlite`. Install, commands and transports are in [README.md](README.md);
dev setup and the gate are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Interception, not the API

We do not call TikTok's API. We scroll a real page and read the feed responses
TikTok's own JS makes (`page.on("response")`). The page supplies msToken,
X-Bogus, signatures, cookies, cursors and a real TLS fingerprint because it
genuinely is the app making the request. Reimplementing the signer is the trap
that eats weeks and breaks every few months.

Five things in `collect/session.ts` are load-bearing. Changing any of them
breaks collection in ways that look like something else:

- `channel: "chrome"` gives a real Chrome TLS fingerprint
- `headless: false` because headless is detected, and because a human needs to
  see the captcha
- `launchPersistentContext` so cookies survive runs
- **Stay logged out.** Public data only. This is the legal line, not a preference
- `warmup()` before any target surface. A cold profile hitting a listing page
  trips the slider captcha
- **Never auto-solve a captcha.** Hand it to the human through the visible window

## Rules that decide whether the output is any good

1. **Tools return summaries, not posts.** Raw posts go to SQLite; a tool return
   stays under ~2KB. Returning 300 post objects burns the agent's context before
   it can reason. This single rule decides whether the MCP layer works at all.
2. **Rank by `outlier`, then `saves`, then `vpf`. Never raw views.** Views
   measure the account. Outlier measures the format, and the format is the only
   thing that transfers to the caller. `outlierBasis` says which comparison was
   available: `account` is the real one, `niche` means we hold too little of that
   account to have its median and fell back to the run's. Anything that ranks must
   stay rankable when the better measurement is missing — a metric that goes null
   on a fresh library silently stops being the ranking it claims to be.
3. **Never clone a format off a one-hit profile.** One viral post is luck. An
   account earns `repeatable` at 3+ bangers with one inside 90 days. Check
   `repeatable` and `verdict` before recommending anything.
4. **Pace like a person.** 90 posts/min ceiling, one page, one browser, jittered
   scrolls, 4 to 11 seconds between surfaces. See `humanScroll`.
5. **Describe production requirements, never judge them.** The tool records what
   inputs a format needs and lets the caller apply their own limits. A niche full
   of faces is unusable to someone with no camera and fine for someone with a
   model, a stock library, or an image generator. `read_slides` records
   `assetsNeeded`; `top_posts` and `format_rollup` take `excludeAssets`, which is
   the caller stating their constraints. There is no default.
6. **Keep it niche-agnostic and user-agnostic.** Nothing in `src/` encodes a
   niche, a product, or an assumption about who is asking.

## The agent is the analyst

The server never calls an LLM. `read_slides` returns slide images as MCP content
blocks and whichever agent is driving looks at them, then calls `save_analysis`.
So there is no API key and no second inference bill, and Claude Code, Codex,
Cursor and Claude Desktop all drive it identically.

Slides are large. Keep `read_slides` to 3 to 5 posts a call; it caps at 6 and
skips anything already analysed.

## Layout

```
src/collect/   session, harvest, payload, discover, scan, sound
src/store/     paths, db, runs, products
src/analyze/   metrics, accounts, taxonomy, playbook
src/output/    slides, zip, report
src/dev/       spike, debug (throwaway probes, not part of the product)
src/cli.ts     the CLI entry point
src/mcp.ts     the MCP entry point
```

`collect/payload.ts` is pure: it reads TikTok's item shape with no browser and no
database, which is why `store/db.ts` can use it and why it is the easiest thing
to test when their payload changes.

## Already solved, do not rebuild

- **Run scoping defaults.** `find_accounts`, `top_posts`, `evidence_pack`,
  `search_library`, `sound_candidates` and `format_rollup` all scope to
  `currentRun(db)` when given no `runId`. `test/leak.test.ts` seeds two unrelated
  niches and asserts every one of those surfaces returns only its own run, so a
  new surface that forgets to scope fails there rather than in someone's report. This closed a leak that broke the
  report twice, where an unrequested comparison against another niche crept in.
  Pass `allRuns: true` to deliberately search everything. Anything new that ranks
  or summarises across the library gets the same treatment.
- **A fresh library barely fills the 30-day window, and the ranking accounts for
  it.** Search returns what performed, not what is recent, so after discover alone
  `views30d` is 0 for most accounts. `find_accounts` sorts on `auto`, which uses
  the window only when more than half the rows actually have posts in it and falls
  back to `bestViews` otherwise, reporting which in `sortedBy`. Ranking on the raw
  window put a 257k-median account below one with 564 views. An empty result also
  distinguishes "nothing collected" from "your filter did this" — telling someone
  to run discover when they just did is the unhelpful version.
- **Expired slide URLs self-heal.** Try the cheap fetch, and only on an actual
  expiry queue a targeted re-scan of the owning account and retry once.
- **The browser window manages itself.** Watching it scroll is useful, so it stays
  visible while working, minimises when the browser queue drains, and raises
  itself when `waitForCaptcha` needs a human. Done over CDP against one window
  id, because telling macOS to hide "Google Chrome" would hide the user's own
  browser too. The context is never closed between MCP calls; that would cost
  the warm profile and re-trigger the captcha.
- **Two sessions share one Chrome, automatically.** `openSession` always probes
  `--remote-debugging-port` before launching. A second process (a second Claude
  Code window, an agent plus a manual CLI call) attaches over CDP to the first
  one's browser instead of fighting it for the profile lock — this used to hang
  silently for minutes with no error. A launch that still can't get in within
  20s fails with a clear message instead of hanging forever. `SWIPEKIT_CDP_PORT`
  overrides the fixed port (default 9423) if something else on the machine is
  already using it.
- **A stdio server must end itself.** `mcp.ts` listens for `end` and `close` on stdin and
  shuts down. Those listeners look redundant and are not: `StdioServerTransport` binds
  only `data` and `error`, and Node's own exit-on-EOF happens *only while nothing holds
  the event loop open*. So a server that never touched the browser exits on its own, and
  one that has called `openSession()` — holding a launched Chrome, or a CDP socket to a
  sibling's — never does. Left alone, an afternoon of ordinary use accumulates idle
  servers pinned to browsers that closed hours ago. Anything else that takes a long-lived
  handle inherits the same rule.
- **A cached browser context can go stale.** `openSession()` may attach us over CDP to a
  browser another process launched; when that process exits, our handle refers to nothing.
  `browser()` checks `isConnected()` and re-opens rather than failing every later call on
  a dead object, and resets `warmed`, because a new browser means a cold profile again.
- **Prior work is queryable.** `find_prior_research(handle | keyword)` answers
  "have I researched this already" from the runs and batches tables with no
  browsing. `list_playbooks` and `get_playbook` do the same for playbooks.

## When the model makes a bad research move

Fix the tool description or the return shape. That is almost always the bug,
rather than the model. Tool descriptions are where the strategy lives, and they
are already in context whenever the server is connected, which is why neither
this file nor the skill restates them.

Testing the server by hand has two gotchas: stdio JSON-RPC is newline-delimited,
so a pretty-printed request body is silently ignored, and a stale import takes
the whole server down at startup. Re-run the initialize plus tools/list handshake
after touching imports.

## Pointers

- Numbers from real runs: which surfaces yield slideshows, what a gated response
  looks like, how long slide URLs live, and the metrics that were wrong before
  they were right, in [docs/findings.md](docs/findings.md).
- How the crawl works in detail: [docs/crawler-mechanics.md](docs/crawler-mechanics.md).
- Why the agent loop is shaped this way: [docs/agent-loop.md](docs/agent-loop.md).
- Two shipped skills, `swipekit` (research) and `swipekit-plan` (dated
  schedule), each carried as an independent copy per host: `.claude/skills/` for
  Claude Code, `.agents/skills/` for Codex. The Codex copies add an
  `agents/openai.yaml` (interface metadata + the MCP dependency); the SKILL.md
  body is identical across both, so edit both when you change one. They are
  model-invoked and carry the evidence floor and how to read the numbers, not the
  tool mechanics.
