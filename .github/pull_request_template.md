<!-- Title: a Conventional Commit, e.g. "fix(collect): clip captions at a word".
     One thing per PR. See CONTRIBUTING.md. -->

## Description

<!-- What changes, and why — what problem does it solve? -->
<!-- If it fixes an open issue, link it. -->

Fixes # (issue)

## How this was tested

<!-- Say what you actually ran, not "works". "Ran discover on 3 queries, 2 cached,
     1 fresh" beats "tested locally". If you touched the crawler, include post
     counts from a real run, before and after. -->

- [ ]
- [ ]

<!-- Tool or CLI surface changes, if any:
## Interface changes
`top_posts` now returns `outlierBasis`; `swipekit accounts` drops the `spike` column.
-->

<details><summary>Screenshots (if the report or CLI output changed)</summary>

<!-- Paste below this line. -->

</details>

## Checklist

- [ ] `npm run check` passes (typecheck + lint + test)
- [ ] I did a self-review of the diff and there are no unrelated changes
- [ ] Odd-looking constants have a comment explaining why
- [ ] Docs updated if behaviour changed (README / AGENTS.md / a tool description)
- [ ] Any new dependency is genuinely necessary
- [ ] New behaviour has a test where it reasonably can
- [ ] No login, no headless mode, no parallelised crawling, no niche or user assumptions baked into `src/`

## LLM use

<!-- This is an agent tool, so using one is fine. Say to what degree a model wrote
     this PR, and confirm you have read and run every line. Delete this section if
     none was used. -->
