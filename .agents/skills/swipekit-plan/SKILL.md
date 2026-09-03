---
name: swipekit-plan
description: Turn swipekit research into a dated posting schedule — what to post, on which day, modelled on posts that were actually measured. Use whenever someone asks for a content plan, a posting schedule, a content calendar, what to post next week or next month, "plan my next 30 days", or how often to post. Also use when a playbook already exists and they ask what to do with it. Plan from the library's own evidence, never from general content-marketing advice.
---

# Planning what to post

The research says what works. This turns it into the thing someone actually opens on Monday
morning: dated posts, each one modelled on a specific post that was measured.

Use `save_plan`. It assigns the dates; you decide what each post is. `get_plan` returns the
schedule already written for this run, so check it before writing a second one — they usually
want to adjust the plan they have, not replace it.

## Ask first, it costs one message

A schedule built on a cadence they cannot keep gets abandoned in week two, so ask before
building one:

- **How many posts a week can they realistically make?** The blueprint account's cadence is
  the target, not the answer. Someone with a day job and no designer does not post 9 times a
  week, and a plan that assumes they will is worse than no plan.
- **Is there a date to work back from?** A launch, a season, a deadline.
- **Which topics does their product already cover?** Posts about features they have ship this
  week; posts about features they do not are a content plan for a different product.

If they would rather you just pick, use the blueprint account's cadence and say plainly that
is what you did and why.

## Every post traces back to a measured one

`sourceAwemeIds` is required and `save_plan` refuses ids whose slides were never read. That
is deliberate: a plan is only worth more than their own guesses if each post comes from
something observed. Plan from what `read_slides` and `save_analysis` actually found — the
hook shapes, the structures, the slide skeletons — not from general content advice that would
read the same for any product.

So a planned post is a real pattern applied to a real topic: the contrarian correction that
worked on 4 unrelated accounts, pointed at the highest-friction thing their product solves.
Not "post a tip on Tuesday".

## Write the posts, not a schedule

This is the part that makes the plan worth paying for. A row saying "Tuesday: contrarian
post" leaves the entire job undone — they still have to invent the slides, the words, the
images. Write the finished post:

- **Every slide, with its real on-screen text.** Not "hook slide" — the actual words, line
  breaks and all, as they will appear. A 5-slide post gets 5 slides written out.
- **An image prompt per slide**, in the visual style the winning posts actually used. They
  paste it into an image generator and get the asset. Describe what `read_slides` genuinely
  showed you: the background, the character or photo treatment, the type weight.
- **The caption, with hashtags**, and the CTA, on the slide the winners put it on.
- **Real topics, never placeholders.** "Crunches vs dead bugs", not "contrarian post 1".
- **Rotate patterns** rather than running one into the ground, and lead with the strongest
  evidence.
- **Front-load the topics their product covers**, so the early posts can carry a real CTA.

Then call `build_plan_doc` and give them the path. That page is the deliverable — week by
week, day by day, every slide written out. The JSON is not the answer, the document is.

If they post several times a day, use `postsPerDay` and write every one of them.

## Be honest about the hit rate

Say what the blueprint account's median post actually does, and that roughly one in five
breaks out. A plan that implies twenty hits sets them up to quit in week two when post three
does 800 views. The volume *is* the strategy: most posts underperform and the winners pay for
them.

If the research was thin, say the plan is a starting hypothesis rather than a proven
schedule, and say what would firm it up.
