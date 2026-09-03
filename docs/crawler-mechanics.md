# How it actually scrolls TikTok

The crawl layer, in detail. This is the hard part. Everything else in the tool
is downstream of this working.

---

## The core insight

There are three ways to get data off TikTok. Most people reach for the worst one.

| Mode | What it is | Verdict |
|---|---|---|
| **1. Passive harvest** | Scroll the real page; TikTok's own JS makes the paginated API calls; you read the responses off the wire | **Use this.** Zero signing, zero cursor management |
| **2. Active pull** | Call `/api/post/item_list/` yourself from inside the page context | Use for deep pagination once you have a `secUid` |
| **3. DOM scrape** | Read rendered HTML | Last resort only |

**Mode 1 is the whole trick.** You don't reconstruct TikTok's API — you let
TikTok call its own API and eavesdrop. The page supplies `msToken`, `X-Bogus`,
`_signature`, cookies, TLS fingerprint, and the correct cursor sequencing,
because it genuinely is the app doing the requesting. You just scroll and listen.

This is literally what "searches TikTok like a person would" means.

---

## Session setup

One persistent, logged-out, headful Chrome. Reused across every run.

```ts
import { chromium, type BrowserContext } from "playwright-core";

export async function openSession(): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(
    `${process.env.HOME}/.swipekit/chrome-profile`,
    {
      headless: false,                       // headless is the #1 detection signal
      channel: "chrome",                     // real Chrome, not bundled Chromium → real TLS fingerprint
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
      ],
    },
  );

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return ctx;
}
```

Notes that matter:

- **`channel: "chrome"`** — bundled Chromium has a distinguishable TLS fingerprint.
  Real Chrome doesn't. This one line removes an entire detection class.
- **`headless: false`** — a real window on your own Mac. Yes, it's visible. That's
  fine; it's your machine. Headless-shell fingerprints are trivially detected.
- **Persistent profile** — cookies and `msToken` survive between runs, so you look
  like a returning visitor rather than a fresh anonymous hit every time.
- **Never log in.** Everything below works logged out, and logging in is what
  moves you from "defensible under Meta v. Bright Data" to "breach of contract."

---

## Mode 1: the passive harvest loop

Attach a response listener, then scroll. The listener does all the work.

```ts
type Harvest = { items: any[]; sawEnd: boolean };

const FEEDS = [
  "/api/search/general/full",   // search → Top tab
  "/api/search/item/full",      // search → Videos tab
  "/api/search/user/full",      // search → Users tab
  "/api/post/item_list",        // a profile's posts
  "/api/challenge/item_list",   // a hashtag's posts
  "/api/music/item_list",       // a sound's posts   ← the slideshow vector
  "/api/recommend/item_list",   // For You feed
];

export async function harvest(
  page: Page,
  url: string,
  opts: { target: number; maxScrolls?: number } = { target: 200 },
): Promise<Harvest> {
  const seen = new Map<string, any>();
  let sawEnd = false;
  let idleRounds = 0;

  page.on("response", async (res) => {
    const u = res.url();
    if (!FEEDS.some((f) => u.includes(f))) return;
    if (res.status() !== 200) return;

    let body: any;
    try { body = await res.json(); } catch { return; }   // some come back empty

    const batch = body.itemList ?? body.item_list ?? body.data ?? body.user_list ?? [];
    for (const raw of batch) {
      // search endpoints wrap the post one level deeper
      const item = raw.item ?? raw.aweme_info ?? raw;
      const id = item.id ?? item.aweme_id ?? raw.user_info?.sec_uid;
      if (id && !seen.has(id)) seen.set(id, item);
    }
    if (body.hasMore === false || body.has_more === 0) sawEnd = true;
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page, 2000, 4000);

  const maxScrolls = opts.maxScrolls ?? 120;
  for (let i = 0; i < maxScrolls; i++) {
    if (seen.size >= opts.target || sawEnd) break;
    if (await isBlocked(page)) throw new BlockedError(page.url());

    const before = seen.size;
    await humanScroll(page);
    await settle(page, 900, 2200);

    // nothing new for 4 rounds → either the end, or a silent block
    idleRounds = seen.size === before ? idleRounds + 1 : 0;
    if (idleRounds >= 4) break;
  }

  return { items: [...seen.values()], sawEnd };
}
```

That's the entire crawler. Everything else is pacing and error handling.

### The scroll itself

Constant-delta scrolling is the single most obvious behavioral tell. Vary it.

```ts
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const settle = (p: Page, a: number, b: number) => p.waitForTimeout(rand(a, b));

async function humanScroll(page: Page) {
  // break one "scroll" into 3–6 wheel ticks, like a real trackpad flick
  const ticks = Math.floor(rand(3, 7));
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, rand(280, 620));
    await page.waitForTimeout(rand(40, 140));
  }

  if (Math.random() < 0.15) {                  // occasional correction scroll up
    await page.mouse.wheel(0, -rand(150, 400));
    await page.waitForTimeout(rand(200, 600));
  }
  if (Math.random() < 0.25) {                  // idle mouse drift
    await page.mouse.move(rand(200, 1000), rand(200, 700), { steps: Math.floor(rand(5, 15)) });
  }
  if (Math.random() < 0.06) {                  // "read something" pause
    await page.waitForTimeout(rand(3000, 9000));
  }
}
```

Target throughput: **roughly 40–90 posts/minute**, not 500. At that rate a
100-account scan is ~30 min unattended. That's the correct tradeoff — you're
running one machine on residential IP against a system tuned to catch farms.

---

## Mode 2: active pull, for deep pagination

Once you have a `secUid`, scrolling a profile to post #400 is slow. Ask directly
— **from inside the page**, so the request carries the page's own credentials.

```ts
export async function pullUserPosts(page: Page, secUid: string, max = 300) {
  return page.evaluate(async ({ secUid, max }) => {
    const out: any[] = [];
    let cursor = 0;

    while (out.length < max) {
      const qs = new URLSearchParams({
        aid: "1988",
        secUid,
        count: "35",
        cursor: String(cursor),
        // msToken is already in document.cookie; the SDK appends signatures itself
      });
      const r = await fetch(`/api/post/item_list/?${qs}`, { credentials: "include" });
      if (!r.ok) break;
      const j = await r.json();

      out.push(...(j.itemList ?? []));
      if (!j.hasMore) break;
      cursor = j.cursor;

      await new Promise((res) => setTimeout(res, 800 + Math.random() * 1200));
    }
    return out;
  }, { secUid, max });
}
```

**You must already be on a tiktok.com page** when you call this — the relative
URL, the cookies, and the origin all depend on it. Navigate to the profile first,
then pull.

If a bare `fetch` gets rejected for a missing signature, the fallback is to make
the page do it *and* watch the wire: trigger one real scroll (Mode 1) to capture
a valid signed URL from `page.on("request")`, then mutate only the `cursor`
param on subsequent calls. Signatures generally survive cursor swaps.

---

## The surfaces, and what each one is for

| Goal | Navigate to | Endpoint that fires | Notes |
|---|---|---|---|
| Find accounts by topic | `/search/user?q=…` | `/api/search/user/full` | Users tab. Thin results — hashtags are better |
| Find posts by topic | `/search?q=…` | `/api/search/general/full` | Mixed feed; needs session cookies, so warm the profile first |
| **Posts under a hashtag** | `/tag/toddlermom` | `/api/challenge/item_list` | **Primary discovery surface** |
| **Posts using a sound** | `/music/x-1234567` | `/api/music/item_list` | **Best slideshow vector** — trends are sound-locked |
| An account's posts | `/@handle` | `/api/post/item_list` | First ~35 also in the rehydration blob, free |
| One post's full detail | `/@handle/photo/123` | — | Read `__UNIVERSAL_DATA_FOR_REHYDRATION__`, no XHR needed |
| Related accounts | any profile page | `/api/related/item_list` | Cheap graph expansion |

Note the URL shape: slideshows live at **`/photo/<id>`**, not `/video/<id>`.
Detect a photo post by `item.imagePost != null`.

### Single post — no scrolling required

```ts
export async function readPost(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const blob = await page.locator("#__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent();
  const scope = JSON.parse(blob!)["__DEFAULT_SCOPE__"];
  return scope["webapp.video-detail"].itemInfo.itemStruct;   // "video-detail" for photos too
}
```

---

## The frontier: turning one seed into a library

Discovery is graph traversal with a work queue, not a single scrape.

```ts
async function crawl(ctx: BrowserContext, seeds: string[], filters: Filters) {
  const queue: Node[] = seeds.map((tag) => ({ kind: "hashtag", id: tag, depth: 0 }));
  const doneAccounts = new Set<string>();
  const doneSounds = new Set<string>();
  const page = await ctx.newPage();

  while (queue.length) {
    const node = queue.shift()!;
    if (node.depth > 2) continue;

    const { items } = await harvest(page, urlFor(node), { target: 150 });
    const photos = items.filter((i) => i.imagePost);

    for (const p of photos) {
      db.upsertPost(p);

      // expand along the author edge
      const sec = p.author?.secUid;
      if (sec && !doneAccounts.has(sec) && passes(p.author, filters)) {
        doneAccounts.add(sec);
        queue.push({ kind: "account", id: sec, depth: node.depth + 1 });
      }

      // expand along the sound edge — only for posts that actually outperformed
      const sound = p.music?.id;
      if (sound && !doneSounds.has(sound) && db.outlierScore(p.id) > 4) {
        doneSounds.add(sound);
        queue.push({ kind: "sound", id: sound, depth: node.depth + 1 });
      }
    }

    await settle(page, 4000, 11000);   // between surfaces, not just between scrolls
  }
}
```

Two edges, and the asymmetry is deliberate: **follow every qualifying author, but
only follow sounds from posts that beat their own account's median.** Otherwise
the sound edge floods you with the generic trending audio everybody uses.

Depth 2 from ~6 hashtag seeds is a few thousand posts and a few hundred accounts.
That's a full library. Don't go deeper.

---

## When it breaks — and it will

### Detecting a block

```ts
async function isBlocked(page: Page) {
  return (await page.locator(
    "#captcha-verify-container, .captcha_verify_container, [class*='captcha']"
  ).count()) > 0
  || (await page.locator("text=/log in to continue|something went wrong/i").count()) > 0;
}
```

**Do not auto-solve captchas.** Solver services exist for TikTok; they're a
different risk posture and against the platform's terms. On a personal-scale
crawl the right response is to back off.

### Recovery ladder

| Signal | Response |
|---|---|
| Captcha appears | Pause the run, surface it in the terminal, **solve it yourself in the visible window**, resume. This is the whole reason `headless: false` is worth it |
| Empty `itemList` on a page you know has posts | Silent soft-block. Sleep 15–30 min, resume from the cursor |
| Repeated 403 / empty across surfaces | Stop for the day. Do not retry-storm — that's what escalates a soft block into a hard one |
| Endpoint shape changed (fields missing) | TikTok shipped a change. Half a day of work, 2–4× a year |
| Anything above, and you need the data now | Fall through to ScrapeCreators for that one call and burn a credit |

The fallback in the last row is the point of the hybrid design. Blocks become
*slower*, never *blocking*.

### Checkpointing

Persist after **every batch**, not at the end of a run. Store the cursor per
surface. A crawl that dies at post 1,800 should resume at 1,800, not 0 — both
because your time matters and because re-fetching 1,800 posts is exactly the
traffic pattern that gets you flagged.

```sql
crawl_state(surface_key PK, cursor, last_run_at, items_seen, status)
```

---

## Pacing budget

Numbers that have held up for personal-scale crawling:

| Knob | Value |
|---|---|
| Between wheel ticks | 40–140 ms |
| Between scroll rounds | 0.9–2.2 s |
| Between surfaces (hashtag → next hashtag) | 4–11 s |
| Concurrent pages | **1.** Not 2 |
| Posts/min ceiling | ~90 |
| Session length | ≤ 45 min, then a 20+ min gap |
| Runs/day | 2–3 |

One page, one browser, human pace, your home IP. You are one person doing
research, and at these rates your traffic is genuinely indistinguishable from
one person doing research — which is the only anti-bot strategy that doesn't
decay.

---

## Phase 0 spike — 30 lines, settles everything

```ts
const ctx = await openSession();
const page = await ctx.newPage();

const { items } = await harvest(page, "https://www.tiktok.com/tag/toddlermom", { target: 60 });
const photos = items.filter((i) => i.imagePost);

console.log(`${items.length} posts, ${photos.length} slideshows`);
console.log(photos.slice(0, 3).map((p) => ({
  id: p.id,
  author: p.author.uniqueId,
  followers: p.authorStats?.followerCount,
  views: p.stats.playCount,
  slides: p.imagePost.images.length,
  sound: p.music?.id,
  firstSlide: p.imagePost.images[0].imageURL.urlList[0],
})));
```

If that prints slideshow URLs, the entire project is de-risked and everything
downstream is ordinary application code.

---

## Verified against the live site — 2026-08-18

Phase 0 ran. The full chain works: scroll → intercept → detect slideshow →
extract URLs → download real JPEGs. Four things the run corrected.

### 1. Search is the primary slideshow surface, not hashtags

This reverses the recommendation above.

| Surface | Posts | Slideshows | photoShare |
|---|---|---|---|
| `/tag/toddlermom` | 59 | 0 | **0%** |
| `/tag/photomode` | 0 | 0 | — (empty feed, `hasMore:false`) |
| `/search?q=toddler routine` | 52 | 4 | **8%** |

`/api/challenge/item_list` returns a video-skewed ranked slice — 59 posts, every
one with a `video` object of nonzero duration, zero image fields. Not a detection
bug; the hashtag feed genuinely doesn't surface photo posts.

**`/api/search/general/full` does.** Lead discovery with search queries; use
hashtags only to expand from an account you already found.

### 2. Cold profile → hashtag page trips the slider captcha

First-ever request from a fresh profile straight to a listing page = "Drag the
slider to fit the puzzle", and the gated response is **HTTP 200 with a 0-byte
body** — which looks identical to an empty feed. Two consequences:

- `warmup()` (land on the homepage, settle, scroll once) before any target
  surface. After warming, the next two runs drew no captcha at all — the
  persistent profile carries it.
- Captcha detection must run **before** idle-round counting, or you silently
  report "no posts" instead of "blocked". The original narrow selector
  (`.captcha_verify_container`) missed it; match on the visible container **or**
  the body text.

### 3. Only the web shape appears

`imagePost.images[].imageURL.urlList[0]` is what comes back. The app shape
(`image_post_info…thumbnail.url_list`) never appeared in any web response —
keep it as a fallback branch, but don't build on it.

### 4. Slide URLs last ~48h, not "a few hours"

Measured `x-expires` = **47.6 hours** out. Still download at ingest, but a
same-day re-fetch is safe. Downloads work with `Referer: https://www.tiktok.com/`
+ a real UA — 4/4 at 1546×2000, ~180KB each.
