# "I'm into looksmaxxing, go find what works" — the agent loop

The part that makes it feel like a product. Companion to
`crawler-mechanics.md` (the primitives).

---

## The realization

There is no niche-understanding algorithm in here. There's no "looksmaxxing
module." The thing that turns a vague sentence into a research plan, adapts when a
search comes back empty, and decides what's worth zooming into — **that's the
agent, running a loop over dumb tools.**

That's why this ships as an MCP server with no model inside it. It's a toolbelt,
and whatever agent is driving it is already the researcher.

Which means the work splits cleanly:

| Layer | Who does it |
|---|---|
| Knowing "looksmaxxing" as a subculture with its own vocabulary | the agent, from its prior |
| Phrasing the search queries as the audience's pain | the agent |
| Noticing a query came back thin and re-planning | the agent |
| Looking at the slide images and naming the format | the agent (`read_slides` hands it the pixels) |
| Deciding there's enough to synthesize | the agent |
| Scrolling TikTok and harvesting posts | the server (crawler doc) |
| Computing outlier / spike / repeatable | the server |
| **Returning results in a shape the agent can reason about** | the server — *this is the actual craft* |

The last row is where these tools live or die. More on it below.

---

## What actually happens when you type that sentence

Annotated. Roughly nine tool calls; the uncached crawls are ~60–90s each, so a
cold run is a few minutes and a warm one is seconds.

> **You:** I'm into looksmaxxing and I want to make slideshows. Go find what's working.

**1. The agent expands the niche — no tool call, pure prior.**
It knows the vocabulary: `mewing`, `jawline`, `canthal tilt`, `hardmaxxing`,
`softmaxxing`, `glowup`, `bonesmashing`. It also knows to phrase queries as what
the audience *types when it hurts* — "how to fix asymmetrical face", "why do I
look tired" — not as the product. Hashtag feeds return almost no slideshows
(measured: 0 in 59 posts on `#toddlermom`); search is where the photo posts are.

**2. → `start_run`**
A run is the container that keeps niches apart, so looksmaxxing today and
motorcycles tomorrow never bleed into one answer. Everything below scopes to it.
If the caller named a product, `save_product_profile` records the one line that
separates advice adapted to them from advice that reads the same for anyone.

**3. → `find_prior_research` / `search_library`**
Instant, local, no browser. Has this niche — or any account the caller named —
been looked at already? If so, most of the run is answering from SQLite.

**4. → `discover({ queries: [...] })`**
The crawl. Returns a **per-query summary plus a `batchId`**, never the posts:

```json
{ "batchId": "b_7f3a", "scanned": 294, "slideshows": 141,
  "qualifyingAccounts": 22, "medianVpf": 2.1, "outlierPosts": 9,
  "modalSlideCount": 7,
  "topSounds": [{ "id": "7412…", "posts": 3 }],
  "cached": false }
```

Queries searched within `maxAgeDays` come back `cached:true` with no page load.
`maxAgeDays:0` forces a fresh crawl. If `qualifyingAccounts` is under 5, the lane
is thin — the honest move is to say so, not manufacture a plan.

**5. → `sound_candidates`, then `track_sound({ soundIds: ["7412…"] })`**
`sound_candidates` reads the library and lists sounds already seen on slideshows
from 2+ different accounts. `track_sound` then pulls everyone running that sound —
the set of accounts on the same skeleton right now. **This is the moment the tool
beats manual scrolling**, and the move a human researcher skips because it's
tedious. Check `isCohort`: one account using a sound ten times is a habit, not a
format.

**6. → `find_accounts`**
The main answer tool for "find me N accounts to learn from." Library only, no
browsing. One row per account: followers, views in the last 30 days, slideshow %,
slides/post, posts/week, `spike`, `bangers`, `repeatable`, links. This becomes the
markdown table in the reply.

**7. → `top_posts({ batchId: "b_7f3a", sortBy: "outlier" })`**
Compact rows — id, handle, followers, views, vpf, outlier, slide count — ranked
by outlier, never raw views.

**8. → `read_slides` on 3–5 top posts, then `save_analysis` for each.**
`read_slides` returns the actual slide images as MCP content blocks. **There is no
model call inside the tool** — the agent looks at the pixels and works out
`hookText` (verbatim slide 1), `hookType`, `structure`, `emotionalAngle`,
`ctaStyle`, a topic-stripped `reusableTemplate`, and what the format *requires* to
produce (`assetsNeeded`, `requiresOwnLikeness`, `requiresSpecificSubject`) as
neutral fact. `save_analysis` records the verdict so no post is ever read twice.

**9. → `format_rollup` / `evidence_pack`, then the agent synthesizes.**
Not a data dump — an answer: the formats that recur across *unrelated* accounts,
the hook shapes, the top-quartile slide counts, the blueprint account and why.

Artefacts only if asked: `write_playbook` stores the recommendation,
`build_report` renders it to HTML, `save_plan` → `build_plan_doc` turns it into
dated posts, `export_bundle` zips markdown + slide images for Notion. The
"intelligence" — steps 1, 4-decisions, 5, 9 — is zero lines of code.

---

## Context economy: the one thing that decides if this works

The failure mode is boring and fatal: `discover` returns 300 TikTok post objects,
each several KB of JSON, and the first tool call has already buried the agent. It
is now too full to reason and the loop dies before it starts.

**Rule: tools write to the database and return observations.**

| ❌ Don't return | ✅ Return |
|---|---|
| 300 raw `itemStruct` objects | counts, medians, distributions, and a `batchId` |
| Every field TikTok gives you | the handful that inform the next decision |
| "Success" | "294 scanned, 141 slideshows, 22 qualifying accounts, 9 outliers" |
| A 200-row table | ~15 rows, sorted, with a note that the rest is in the library |

Every tool return should answer *"what should I do next?"* — not *"what did you
find?"* The data lives in SQLite; the agent pulls the slice it needs with
`search_library`, `top_posts`, or `find_accounts` when it needs it. Keep every
return **around 2KB**. AGENTS.md states this as rule 1, and it is the single rule
that decides whether the MCP layer works at all.

Corollary: give every crawl a `batchId` and make it addressable. The agent works
with the handle, not the payload.

---

## The spine of the loop

Narrower than you'd expect. Everything else is a variation on these.

| Tool | Returns | Why the loop needs it |
|---|---|---|
| `start_run` | a `runId` | keeps niches from mixing |
| `find_prior_research` | prior runs / batches touching a handle or keyword | answer from the library before browsing |
| `discover` | per-query summary + `batchId` | the crawl; cached by default |
| `sound_candidates` | sounds seen on 2+ accounts | what to `track_sound`, without guessing |
| `track_sound` | the accounts on one sound's skeleton | format cohorts — the highest-yield move |
| `scan_account` | account metrics + repeatability verdict | vet a specific creator |
| `find_accounts` | one comparison row per account | **the main answer** for "find me N accounts" |
| `top_posts` | ≤ ~15 compact rows | zoom in, ranked by outlier |
| `read_slides` | slide images, for the agent to read | name the format from the actual pixels |
| `save_analysis` | — | record the verdict so nothing is read twice |
| `write_playbook` / `save_plan` | stored artefact | the recommendation, then the dated schedule |

No tool "writes the plan" for you beyond assigning dates — `save_plan` takes the
posts the agent wrote and enforces that each cites `sourceAwemeIds` that were
actually read. The thinking stays with the agent; the tool just makes it
provable.

---

## Steering the loop (so it doesn't wander)

Two things live in the server so the behaviour is reliable rather than
vibes-based.

**1. Tool descriptions that teach strategy.** The `description` field is prompt
real estate, and it is already in the agent's context whenever the server is
connected. `track_sound`'s description says, in as many words, "prefer this over
broadening your search — it goes deeper into a proven format instead of wider into
unproven ones." That paragraph is why the agent follows a sound cluster instead of
firing more queries. Strategy encoded in the toolbelt beats hoping the model
guesses — which is also why, when the model makes a bad research move, the fix is
almost always the tool description or the return shape, not the model.

**2. A skill for how to read the numbers.** `skills/swipekit` carries the
evidence floor — what an answer has to contain before it's finished — and the
calibration the tools don't return (save-rate bands, `topicalCoherence`
thresholds, when `spike` is a bad instrument). It does *not* restate the tool
mechanics, because those are already in context. `skills/swipekit-plan` does
the same for turning a playbook into a schedule.

---

## Why this generalizes past looksmaxxing

Nothing in `src/` knows what looksmaxxing is. Swap the queries and the identical
loop researches parenting, finance, ceramics, or a kids' timer app's bedtime
niche. The tools are topic-blind by construction; all the topic knowledge lives in
the agent's prior plus what the corpus calls itself back.

Which is also the honest reason this is worth building the way it is: the
expensive part — a researcher that understands subcultures — you already pay for.
You're just building it hands.
