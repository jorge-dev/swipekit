# What running it actually taught us

Measured, not assumed. Each row cost a debugging session, so check here before
re-deriving any of it.

## Which surfaces yield slideshows

| Finding | Detail |
|---|---|
| Search is the slideshow surface | `/tag/toddlermom` returned 0 slideshows in 59 posts. `/search?q=…` returns ~30% photoShare. The challenge feed is a video-skewed slice. Discovery leads with search queries |
| Niche density varies ~15x | parenting: goNoGo 10, photoShare ~30%. looksmaxxing: goNoGo 150, photoShare up to 96%. Build tooling against a dense niche; thin ones make bad test corpora |
| Only the web payload shape appears | `imagePost.images[].imageURL.urlList[0]`. The `image_post_info…thumbnail` shape is parsed but has never been seen on web |

## Blocking and captchas

| Finding | Detail |
|---|---|
| A gated response is HTTP 200 with a 0-byte body | Indistinguishable from an empty feed. Check for a captcha *before* counting idle scroll rounds |
| Captcha is once per profile | A warmed profile ran 4+ subsequent surfaces clean |

## Media

| Finding | Detail |
|---|---|
| Slide URLs expire in ~48h | Not "a few hours". Download at ingest. `read_slides` and `download_post` self-heal by re-scanning the owning account |
| Image download needs a Referer and a real UA | `Referer: https://www.tiktok.com/`. Yields 1546x2000 JPEGs, ~180KB each |

## Metrics that were wrong before they were right

Each of these is now pinned by a test in `test/`. Read the test before changing
the metric.

| Finding | Detail |
|---|---|
| VPF needs an absolute views floor | Without `minViews`, an 83-follower post with 10k views scores VPF 123 and outranks everything real. Default floor 50k |
| Banger *rate* is the wrong gate | It punishes accounts for posting more. Gate on count (3 or more) plus one banger inside 90 days |
| Cadence must be recent | A lifetime average reported 1.46/wk for an account posting 20 times a month. Now: posts in the last 56 days ÷ 8 |
| Gap-variance consistency was broken | It collapsed to 0 for anyone posting in bursts, which is most creators. Now: the fraction of the last 8 weeks with at least one post |
| Recency is load-bearing | The 180d filter dropped a 621k-view, 9.2%-save post as stale. Old formats may simply be dead |
| `outlier` is null until `scan_account` runs | It needs 5+ posts from one account to have a median. Search batches return 1 or 2 |

## Sound cohorts

Tracking a sound is the highest-yield single move: a 3-account signal in the
library expanded to 85 slideshows across 61 accounts in one call. Another sound
was correctly rejected at 3 slideshows in 59 posts, because it was a video sound.

Two traps, both verified on sound `7635803634156636936`:

**Distinct accounts is not distinct operators.** One person running 20 accounts
that post the same caption, sound and slide count is the standard slideshow
playbook. That 61-account cohort contained a 5-account cluster all posting the
same caption; 47 were genuinely independent. `track_sound` clusters on the
normalised caption and reports `independentAccounts`, and `isCohort` gates on
that rather than the raw count. Both halves are useful: the independent count
validates the format, the cluster shows you someone running the multi-account
play.

**A sound cohort is an audio cohort, not a format cohort.** That same sound
carried looksmaxxing guides alongside an unrelated meme, with the top hashtag
covering only 32% of it. `track_sound` reports `topicalCoherence`, and `isCohort`
requires 0.35 or better. Trending audio attracts everyone, and that is not a
format.
