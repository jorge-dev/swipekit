---
name: swipekit
description: Research TikTok slideshow (photo post) formats with the `swipekit` MCP server — find accounts winning in a niche, measure them on real numbers, read their slides, and turn that into what to post. Use this whenever someone asks how to promote or get distribution for an app or product on TikTok, wants accounts or formats to copy or get inspired by, asks whether a niche is worth entering, wants to know why a post went viral, or wants a content plan built from real data — even when they never say "slideshow" or "TikTok research". Use it the moment such a question is asked, not after offering to: answering "is this niche worth it" from general knowledge when a tool can measure it is the failure this skill exists to prevent.
---

# Slideshow research

The tool descriptions already tell you how to run the tools. This file is only about **how much evidence the answer has to carry**, and the numbers the tools don't give you.

The job: *what should I post, and why do we believe it* — answered with enough raw material that the reader could check you and disagree.

## Never answer this from general knowledge

"Is this niche worth it", "what should I post", "which accounts should I copy" are measurable
questions, and answering them from priors is the one outcome this whole tool exists to
prevent. General plausible advice about a niche is worth nothing to the reader; it is what
they could already write themselves.

Do not offer to do the research and wait for permission. Start it. The first steps cost
nothing and open no browser — `library_stats`, `find_prior_research`, `search_library` are
instant local reads, so there is no expense to seek approval for. Run them the moment the
question is asked. Only `discover`, `scan_account` and `track_sound` open Chrome and take
real time, and by then you will have actual numbers to say what you are about to do and why.

## Playbook, report, export are tool calls, not sentences

Nothing you write in the chat persists anywhere. If someone asks for a playbook, a report,
or an export, that means calling `write_playbook`, `build_report`, `export_bundle` — not
composing a good-sounding answer and stopping. The report reads *only* what got saved
through these tools; a well-written chat reply that never called them produces an empty
page, because from the report's side nothing happened.

This chains: `write_playbook` needs real analysed posts to have anything true to say, so it
refuses to save if this run hasn't read any yet (that's `read_slides` then `save_analysis` —
looking at slides without saving the verdict doesn't count, the row has to exist). If
`evidence_pack`'s coverage notes say posts are still unnamed, that is not background
information to skim past — it is telling you the exact step standing between you and a
playbook that means anything. Do it before calling `write_playbook`, not instead of it.

## The evidence floor

An answer isn't finished until it carries all of these. If one is missing, go get it before writing.

Most of this floor is only reachable through `read_slides` followed by `save_analysis` —
captions and view counts alone cannot tell you what slide 1 said or how the deck was built.
An answer written without reading any slides has no verbatim hooks, no slide skeletons and
no production requirements, which is most of the floor missing at once. It reads as generic
because it is. Read 3-5 of the top posts before writing, including for a plain go/no-go
question: "is this niche worth it" is a question about what the winners actually made.

- **Verbatim hooks.** Slide-1 text of the top posts, quoted exactly, each with its view count. Then say what the hook *system* is across them. A described hook is worth far less than a quoted one.
- **Verbatim captions**, with hashtags, at least for the blueprint account. If a caption promotes a product, **name the product** — a competitor's distribution playbook is often the most useful thing in the dataset, so don't anonymise it.
- **Post-level numbers for every account you recommend.** Views and save rate per post, not just the account aggregate. The spread is the finding: 837k / 602k / 10.7k / 10.6k tells the reader the real hit rate that a median hides.
- **Links.** Every TikTok account you name gets a `tiktok.com/@handle` link the first time it appears — in the table *and* in the prose, not just the table. Brands @-tagged inside a quoted caption are not accounts you're recommending, so leave those as plain text. Link the specific posts you cite too; the tools return both.
- **Sound ids** when a cohort is in play, with `independentAccounts` and `topicalCoherence` beside them.
- **Norms from the niche you were asked about** — median views, typical save rate, what a good post looks like *there*. Stay inside that niche. Only bring in a different one when the question is whether a lane is viable at all, and then say plainly why you're comparing. Someone asking "find me looksmaxxing accounts" does not want a paragraph about parenting; unrequested cross-niche comparison reads as the library leaking into their answer, because it is.
- **What producing it costs**, in inputs: imagery, design tool, whether a real person or a real child has to be in frame, whether their own screenshots do the job.

**Whenever you name two or more accounts, put them in a markdown table**, whatever the
question was. Not only for "find me N accounts" — a go/no-go answer that recommends four
accounts still owes the reader a table. Prose alone makes them reconstruct the comparison in
their head, and comparing accounts is the entire point. Handle, followers, views in the
window, slideshow share, posts per week, best post. Then put the per-account detail in prose
beside it rather than compressing everything into columns.

Then interpret: name the blueprint and why, name the flukes, say what you'd do next week.

## Write it like a blog post someone chose to read

The reader is a solo app developer deciding what to post next week, not an analyst reading a
study. Write the way a good engineering blog post reads: one idea per paragraph, the point at
the top of each one, and the numbers in the middle of a sentence rather than stacked up in a
wall. They should be able to skim the bold shape of it in thirty seconds, then go back and
read the parts that matter to them.

**Depth is not the same as density.** Keep every number, every quote, every link. It is the
prose around them that gets simpler and more spaced out. A finding does not become more
rigorous by being harder to read.

Concretely, when you fill in a playbook:

- **Break it into paragraphs.** `verdict`, `whyItWorks` and `adaptation` are rendered with
  blank lines turned into real paragraphs, so a blank line between ideas is a formatting
  instruction that actually lands. A single 120-word paragraph with six statistics in it is
  the failure mode. Three short paragraphs carrying the same six statistics is the fix.
- **Lead with the sentence they would repeat to a friend.** The first line of `verdict` is
  the whole answer in one sentence: enter the lane or don't, and the single thing that
  decides it. Everything after it is support. Do not open with setup, scope, or a summary of
  what you did.
- **One statistic per sentence.** "A 3,391-follower account pulled 727,728 views in 30 days"
  lands. The same sentence carrying four more figures does not. Split it.
- **Name the mechanism in plain words.** Say why a human thumb stopped, not what the
  distribution looked like. "It names something the viewer is already doing and calls it
  harmful, so the scroll stops on guilt rather than curiosity" is the level to write at.
- **`evidence` is a sentence, not a log line.** Write it as readable text with the figures
  inline. Handles, view counts, save rates and dates all still belong there.
- **Cut the em dash habit and the throat-clearing.** No "it is worth noting", no "the
  decisive fact", no "importantly". Say the thing.

Read it back as if you did not do the research. If a sentence needs a second pass to parse,
it is too long or it is carrying too many numbers. Split it and keep both halves.

## Start from what's already true

Collecting requires an active run, and the tools will refuse without one. A run is the
container that keeps niches apart, so that asking about dogs today and motorcycles tomorrow
doesn't blend the two. Before the first collection, ask the user what they're building:
product or app name, and one line on what it does and who it's for. That single line is what
separates a recommendation adapted to them from generic advice. If they'd rather skip it,
name the run after the topic and move on; don't interrogate them.

Before scraping anything: `find_prior_research` on the topic, and on any account the caller
already named. `search_library` for a quick full-text check on a phrase. Both are instant —
no browsing, no cost to check. If the caller already named specific accounts ("check out
@handle1 and @handle2"), skip discover entirely and go straight to `scan_account` on those
handles; discover is for finding accounts you don't have yet, not a detour before looking at
ones you were just handed.

The same applies mid-conversation. A follow-up question ("which of these post most often",
"just the ones over 5% save rate") is almost never a reason to scrape again — it's a reason
to re-run `find_accounts`/`top_posts`/`format_rollup` with different filters, or just slice
what a prior tool call already returned. Treat "go get more data" as the last resort, not
the first move, once the library already covers the question.

## Dig further than the question strictly requires

There's no step at which you stop. When a cheaper answer would technically satisfy the prompt, spend what's left on whatever would change the recommendation:

- **Scan the accounts you're about to recommend.** A blueprint whose median post does 914 views is a different recommendation from one whose median does 106k, and only `scan_account` tells you which you have.
- **Read the slides even for a go/no-go question.** "Is this niche worth it" is a question about what the winners actually made. Reading three posts moves the answer more than another `discover` query.
- **Track the sound.** Highest-yield move available, and the one nobody makes by hand.
- **Slice the corpus yourself.** Photo vs video inside the same niche, save rate vs likes, recent window vs all-time, median views by caption keyword. These aren't tools — they're you querying what the tools returned, and they produce the findings nobody else has.
- **Say what the numbers mean mechanically**, not just statistically. "A 121-follower account printed 455k views, so nobody is following these accounts — the format is being served to strangers" explains a pattern that a ratio only reports.

## Numbers the tools don't carry

- **Save-rate calibration.** ~1-2% is the norm, 3-4% strong, 6-9% best-in-class. A save means "reference material I'll come back to", which is the intent that converts to an install — so for a utility product a high-save/low-view post can beat the reverse. Report saves next to views every time.
- **Shares vs saves vs comments.** Shares far above comments is a "send this to him" post: great reach, weaker intent. High on both saves and shares is a utility post, the best profile for app distribution.
- **`topicalCoherence` below ~0.35** means the sound is trending audio rather than a format marker. One measured sound carried both looksmaxxing guides and an unrelated food meme.
- **The quantified parenthetical.** "(+solutions)", "(+25 max attractiveness)", "(start with these first)" recurs across unrelated accounts on high performers. Where it recurs, it's part of the format.
- **Production floor.** Million-view posts are routinely a flat colour and a system font. Polish can read as an ad — worth testing the crude version.

## Thresholds are evidence, not verdicts

Every rule of thumb — the `goNoGo` bands (<5 thin, 5-20 viable but thin, >20 a live lane), `repeatable`, `spike`, minimum accounts for a format — is a prior. The data in front of you is the posterior. Report the count, say what it usually implies, then say what *these particular numbers* say. Where they disagree, the data wins and you explain why.

Two known failure modes:

- **`spike` is a bad instrument on a right-skewed account.** Seven posts between 73k and 435k produce a large spike and are obviously not a one-hit profile. Look at the post list before letting spike disqualify anyone.
- **A thin lane can still be the right lane.** Three operators with 7-11% save rates where the norm is 0.4% is a finding, not a disqualification. Say the lane is thin *and* say what's working in it.

Show the numbers a rule came from rather than quoting the rule as authority.

## Honest without being useless

Two-sided failure mode. Overstating confidence is one; the other is a caveat section that tells the reader what you didn't do instead of telling them something.

- **Every caveat carries a fact and a next action.** Not "I didn't read the slides" but "the six posts worth opening are X, Y, Z — their slide URLs are live for another 48h, so they're downloadable now and won't be next week."
- **Unreliable rows stay in, labelled.** `windowCovered: false` means the figure is a floor; say which accounts, and what would fix it.
- **An operator network is not a weaker finding than a real cohort.** It's a competitor's playbook visible in public, and usually the most directly useful thing you'll find. Check `independentAccounts`, then say which it is.
- **Borrowed formats: proven shape, untested audience.** Label both halves.
- **Record `assetsNeeded` as neutral fact** — but do flag the risks of *shipping* a format under a company name: likeness and celebrity-photo rights, health or clinical claims, moderation exposure, whether it should run from a content account rather than the brand handle. That isn't judging what they can make; it's the part they'll wish you'd said.

## Keep out of the answer

Run ids, briefs, query strings, step numbers, tool names, or this file. Provenance gets half a sentence — "from the local library, N posts, not a fresh crawl" — and the opening paragraph goes to the strongest finding you have.

## Artefacts, only when asked

A playbook and a report are different things, and asking for one is not asking for the other.
The **playbook** is the recommendation itself, stored by `write_playbook`. "Give me the
playbook", "write me a playbook" means produce that and show its content in the chat: the
verdict, each pattern, the slide skeletons, what to avoid, what to do next. If one already
exists for this run, `get_playbook` returns it — show it, don't silently rebuild something
else. The **report** is the HTML rendering of that same playbook plus the evidence, and it
is only what they want when they say report, export, or file.

Never answer "give me the playbook" by handing over a report path. Even when you do build a
report, the chat still carries the recap: the verdict in a sentence, the accounts table, and
the patterns. A file path is not an answer.

`download_post` zips every slide plus a `metadata.json`. `build_report` writes a scoped HTML report and returns its path; scope it to the run unless they ask for the whole library.

## The plan is the deliverable they act on

After the playbook, `save_plan` turns it into dated posts. Offer it once a playbook exists,
and reach for it whenever they ask what to post next, for a schedule, a calendar, or "the
next 30 days" — a plan is what someone actually works from on Monday morning.

Two rules hold even if you plan straight from here: ask what cadence they can realistically
keep before assuming the blueprint account's, and cite `sourceAwemeIds` on every entry, which
`save_plan` enforces. Real topics from their niche, never "contrarian post 1", and write
slide 1 where you can.

The fuller version — what to ask, how to rotate patterns, how to be honest about the hit
rate — is in the `swipekit-plan` skill.

## Never reach past the current run

Every tool that reads the library scopes to the current run on its own. `allRuns` exists for
one case: the user explicitly asked about their whole library, or named another niche. That
is the only time it is correct.

The tempting misuse is a thin run — three accounts, not much to say — and `allRuns` sitting
there offering more data. Do not take it. **A thin run is the finding.** Say the lane looks
thin and how thin, which is genuinely useful; answering with another niche's accounts is not
more helpful, it is a different question answered without being asked, and the reader has no
way to tell. Someone researching an ab workout app does not want a parenting account in the
table, however well it performed.

Install, first run, captchas, and what to do when browsing breaks: [`references/setup.md`](references/setup.md)
