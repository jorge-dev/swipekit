# Setup and when browsing breaks

## Install

The MCP server is a local stdio server. Register once:

```bash
claude mcp add swipekit -- node --no-warnings --experimental-strip-types /ABSOLUTE/PATH/TO/swipekit/src/mcp.ts
```

Node 24+ (it runs TypeScript directly and uses the built-in `node:sqlite`), Playwright, and
real Google Chrome installed. No API key — the agent calling these tools does the analysis,
so the server never buys its own inference. Works identically in Claude Code, Claude Desktop,
Codex and Cursor.

## First run

Browsing opens a visible Chrome window with a persistent, logged-out profile. Leave it alone
while it works.

A fresh profile hitting TikTok for the first time usually gets a slider captcha. The tool
pauses, prints a message, and waits up to four minutes — **solve it in the window yourself**
and it resumes. This is the whole reason the browser is visible rather than headless. Once
solved, the profile carries it and later runs are clean.

Never log in. Everything works logged out, and staying logged out is what keeps this to
public data.

## When results look wrong

**"No posts harvested"** — a gated response is an HTTP 200 with a zero-byte body, which looks
identical to an empty feed. Almost always a captcha or a soft block. Check the Chrome window.

**Empty results on a hashtag** — expected. Hashtag feeds return a video-skewed slice; several
return no slideshows at all. Use search queries.

**"slide URLs expired"** — slide images carry a signature good for roughly 48 hours. Re-run
`discover` or `scan_account` for that account, then read or download again.

**Repeated empty responses across surfaces** — a soft block. Stop for the day rather than
retrying; a retry storm turns a soft block into a hard one.

## Pacing

The crawler paces itself like a person: jittered scrolls, one page, one browser, 4-11 seconds
between surfaces, roughly 40-90 posts a minute. Don't try to parallelise it. At personal
scale this traffic is indistinguishable from one person doing research, which is the only
anti-bot strategy that doesn't decay.
