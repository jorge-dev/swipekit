# Contributing

This started as a personal tool and I am sharing it because it turned out to be useful. So treat what follows as "here is how it has been kept sane", not rules for their own sake.

## Getting set up

```bash
npm install
npm link
swipekit stats
```

That should print a table even on an empty library. You need Node 24+ and real Google Chrome. `npm install` checks for it and prints a one-line notice if it's missing, so that shows up now instead of later as a tool failure mid-conversation with your agent.

While you are working, run the source directly rather than the installed command:

```bash
npm run cli -- accounts --limit 5
```

`swipekit` on your PATH runs the compiled copy in `dist/`, so it will not show your edits until you `npm run build`. The compile exists only because Node refuses to strip types under `node_modules`, which is what breaks a real install. Nothing else in the project needs a build step.

To check the crawler itself works:

```bash
npm run spike -- --url "https://www.tiktok.com/search?q=morning%20routine" --target 40
```

If that prints slideshow posts with slide URLs then everything downstream is normal application code. If it does not, start with `npm run debug -- --url "..."`, which dumps every `/api/` call the page makes plus a screenshot.

## Before you open a PR

```bash
npm run check
```

That is three things in a row and all three have to pass:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm test            # node:test
```

The typecheck matters more here than in most repos. Node strips the types and runs the file, it never checks them, so nothing tells you a signature is wrong until it blows up at runtime. That is exactly how a stale import once broke the MCP server on startup.

Tests are plain `node:test`, no framework. They live in `test/`, run against an in-memory SQLite, and never touch the network or open Chrome, so the whole suite finishes in under a second. `npm run test:watch` while you work, `npm run coverage` if you want the numbers.

Write tests against the seams that carry meaning. `test/helpers.ts` builds real TikTok payload shapes and pushes them through the same parsing path production uses, so a change to their payload breaks a test instead of quietly writing empty columns. The metric tests are worth reading before you change any scoring, because most of them exist to pin down a bug that already happened once.

## Where things live

```
src/collect/   getting data out of TikTok
  session.ts     persistent Chrome, human-ish scrolling, captcha handling
  harvest.ts     the scroll loop that intercepts TikTok's own feed responses
  payload.ts     pure readers for their item shape (no browser, no database)
  discover.ts    search led discovery, cache aware
  scan.ts        per account deep scan and repeatability verdict
  sound.ts       sound cohorts and operator clustering

src/store/     what we keep
  paths.ts       where the library lives (SWIPEKIT_HOME, ./library, ~/.swipekit)
  db.ts          SQLite schema, idempotent upserts, FTS5
  runs.ts        run scoping, one research question per run
  products.ts    product profiles, what the caller builds

src/analyze/   turning rows into an argument
  metrics.ts     vpf, saves, outlier scoring
  accounts.ts    account rows (30 day window, spike, reliability)
  taxonomy.ts    the format taxonomy and cross account rollup
  playbook.ts    evidence pack and saved playbooks

src/output/    what a human or an agent reads
  slides.ts      fetch slide images for the agent to read
  zip.ts         slides plus metadata bundled per post
  report.ts      the HTML report

src/dev/       throwaway probes, not part of the product
  spike.ts       raw harvest against one URL, no database
  debug.ts       dump every /api/ call plus a screenshot
  reset.ts       wipe the library and Chrome profile back to a fresh install

src/cli.ts     the CLI entry point
src/mcp.ts     the MCP entry point
```

Dependencies only point inward: `collect` and `output` may use `store` and
`analyze`, but nothing in `store` or `analyze` reaches for Playwright. That is
why `payload.ts` was split out of `harvest.ts`, and it is what keeps the test
suite able to cover the whole scoring path without opening a browser.

## Things worth keeping

These are not style preferences. Each one is here because breaking it caused a real bug.

**Do not call TikTok's API directly.** Scroll a real page and read the responses its own JavaScript makes. Reimplementing the request signing is the trap and it breaks constantly.

**Tools return summaries, not raw data.** Raw posts go to SQLite. A tool return should be small enough for an agent to think about. Returning 300 post objects burns its context before it can reason. Around 2KB is the target.

**Describe what a format needs, do not judge whether someone can make it.** Record `assetsNeeded` as fact. Whether "needs a real person on camera" is a blocker depends completely on who is asking. Someone with a camera, a stock library or an image generator all get different answers. The caller decides, the tool reports.

**Do not encode a niche or a user.** Nothing in `src/` should assume what the caller is building. That assumption leaked twice and produced answers comparing niches nobody asked about.

**Scope to a run.** Every search, scan and sound pull belongs to a research question. Unscoped analysis mixes niches and the output stops making sense.

**Answer from the library first.** Browsing is slow, rate limited and rude. `discover` and `scan_account` reuse recent results on their own, and read only tools never browse at all.

**Pace like a person.** The jitter and delays in `session.ts` are doing real work. Do not parallelise the crawler, do not remove the sleeps, do not add a headless mode.

**Never add a login.** The whole legal position of this tool rests on it only touching public, logged out data. I will not merge a PR that adds authentication.

## Adding a platform

The crawler is TikTok specific but most of the rest is not. `metrics.ts`, `runs.ts`, `playbook.ts` and the MCP layer already work on the normalised `posts` table instead of raw TikTok JSON.

Realistically it is two files of new work per platform. A harvest layer for that platform's feed endpoints and response shape, and a session layer for its anti bot behaviour, both feeding the same schema. Add a `platform` column rather than forking the tables.

## Pull requests

One thing per PR.

Say what you actually checked. "Ran discover on 3 queries, 2 cached, 1 fresh" is more useful than "works". If you touched the crawler, include post counts from a real run before and after.

Comments should explain why, especially anything that looks arbitrary. Most of the odd looking constants in here exist because something broke.

## Using an LLM

This whole project is an agent tool, so it would be strange to ban the thing.
If a model wrote part of a change, say so in the PR, and only open it once you
have read every line, know why it works, and have run it. A PR the author cannot
walk through in review gets closed — reviewing code nobody understands is slower
than writing it. Generated tests or type boilerplate are fine and need no note.

## Reporting bugs

Include the command or the question you asked your agent, what you expected, what happened, whether a Chrome window opened and what was in it, and the output of `swipekit stats`.

Scraper bugs are often just TikTok changing their markup. If posts stop being found, run `npm run debug -- --url "..."` and say which `/api/` endpoints fired. That usually identifies it straight away.

## Scope

This is a research tool for one person studying a niche. Things that push it toward scale, so parallel crawling, proxy rotation, headless mode, captcha solving services, hosted multi tenant use, are out of scope and would change its legal position. Please do not.
