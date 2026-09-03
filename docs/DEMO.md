# Re-recording the demos

Two GIFs in the README, made two different ways. The CLI one regenerates from a text
file with no recording at all; the hero one needs a real screen recording because the
most convincing part of it happens outside any terminal.

---

## The CLI GIF — `docs/demo-cli.gif`

Rendered headlessly by [VHS](https://github.com/charmbracelet/vhs). There is no
footage. The demo *is* `scripts/demo.tape`, and editing that file is how you re-cut it.

```bash
brew install vhs
vhs scripts/demo.tape        # ~60s, writes docs/demo-cli.gif
```

It reads the local library and never browses, so it cannot stall on a captcha and it
renders identically every time. It does need a library with something in it — run the
research once first, or you will render a table of zeros.

`swipekit` has to be on your PATH (`npm link`), otherwise every beat renders
"command not found".

The beats, and what each one is actually saying:

| Beat | The line worth saying |
|---|---|
| `stats` | One number decides a niche: how many *small* accounts have a *big* slideshow. |
| `accounts` | Spike is best ÷ median. High spike on few posts is a lottery ticket, not a system. |
| `top --sort saves` | Saves, not views. A save means "I'll come back to this" — the intent that installs an app. |
| `formats` | One account doing this well is a person. Several unrelated accounts is a format. |

---

## The hero GIF — `docs/demo.gif`

This one shows an agent being asked a question in plain English, opening Chrome,
scrolling TikTok, and coming back with a table. VHS cannot make it: Chrome opens on the
real desktop, outside VHS's terminal entirely, and watching it drive a browser is the
whole point.

So it is a real screen recording, cut afterwards.

### Recording

1. Do Not Disturb on, Dock hidden (`Cmd+Option+D`).
2. A **fresh** agent session in this repo, so the skills load and the tool calls are visible.
3. **Empty the library first** — `npm run reset` also wipes the Chrome profile and brings
   back the first-run captcha, so to keep the profile warm delete only
   `~/.swipekit/library`.
4. Warm the profile on a throwaway query, pointing somewhere else so the real library
   stays empty:
   `SWIPEKIT_HOME=/tmp/warm swipekit discover "morning routine ideas" --target 25`
5. `Cmd+Shift+5` → Record Entire Screen. Wait two seconds, paste the prompt, then take
   your hands off the keyboard until the answer finishes.

Record it at real speed, all of it. Do not try to speed anything up while recording, and
do not stop when it looks slow — a full run is ten to fifteen minutes, because the skill
tells the agent to scan accounts and read slides rather than answer off the first search.

**A retake needs the cache cleared.** Searches are cached, so running the same prompt
again answers from the library and Chrome never opens.

### Cutting

```bash
./scripts/cut-demo.sh ~/Desktop/recording.mov docs/demo.gif
```

Three segments, concatenated so there is no jump cut: the prompt at real speed, the
crawl compressed ~55×, the verdict and table at ~7×. Fifteen minutes becomes about
thirty seconds and still reads as one continuous take. The boundaries are constants at
the top of the script — retune them for a different recording, since where the answer
lands moves with how much work the agent decided to do.

`gifsicle` runs at the end. GitHub renders an inline GIF up to about 10MB, and a dark UI
over a photographic desktop lands just over that without it.
