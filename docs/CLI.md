# The `swipekit` CLI

Everything the MCP tools do, without an agent in the loop. Same local library, same
numbers, same report. Use it when you want to drive the research by hand, script a
step, or check what is in the library without opening a chat.

`swipekit --help` lists every command. `swipekit <command> --help` documents that
command's flags, generated from the same definitions that parse them, so it never
drifts. This page is the part `--help` cannot give you: what each command is for, the
order they go in, and what the numbers mean.

## Running it

Three ways to invoke, all identical in parsing and output:

```bash
swipekit <command>                          # global install or npm link
node --no-warnings src/cli.ts <command>      # from a clone, no install
npm run cli -- <command>                     # from a clone, via the package script
```

A global install gives you `swipekit` and `swipekit-mcp` on your PATH:

```bash
npm install -g github:jorge-dev/swipekit
```

Node 24 and a real Google Chrome are required. macOS and Linux.

## The library

Every command reads or writes one local SQLite library plus its slide thumbnails and
rendered reports. Nothing leaves the machine and there is no account.

Resolution order, decided once at startup:

1. `$SWIPEKIT_HOME`, if set. Use this to keep separate libraries apart, or to point a
   global install at a library inside a checkout.
2. `./library`, if that directory already exists. Keeps a clone working on its own copy.
3. `~/.swipekit/library`, the default once the CLI is installed globally.

`swipekit stats` prints the path it resolved along with the row counts.

## The normal order

```bash
swipekit runs --start "Habit trackers" --brief "productivity app for students"
swipekit discover "morning routine" "how to build habits" --target 120
swipekit accounts --repeatable --limit 10
swipekit scan glowuptips.apex someotheraccount        # firm up the ones worth trusting
swipekit top --sort saves --limit 12
swipekit slides                                       # or let an agent read them
swipekit formats
swipekit report --posts 16
```

`discover`, `scan` and `track` open Chrome. Everything else reads the library and
returns immediately.

---

## Research scope

### `runs`

Start, switch, or list research runs. A run scopes every batch to one question, so two
unrelated niches never mix into one answer. With no flags it just lists the runs, with
an arrow on the current one.

| Flag | Meaning |
|---|---|
| `--start <label>` | start a new run and make it current |
| `--brief <text>` | one line on what you are researching (stored with the run) |
| `--use <runId>` | switch the current run |

```bash
swipekit runs
swipekit runs --start "Room resets" --brief "cleaning app, renters, small spaces"
swipekit runs --use run_abc123
```

### `seen`

Check whether an account or topic has already been researched before you scrape it
again. An `@handle` is looked up as an account, anything else as a topic keyword. This
is the "ask about it twice, run it once" step.

```bash
swipekit seen @glowuptips.apex
swipekit seen "potty training"
```

### `product`

Manage product profiles, the short description of what you are actually building that
the agent uses to pick a lane and rewrite a winning format in your subject matter. With
no arguments it lists profiles, with a `[slug]` it prints one.

| Flag | Meaning |
|---|---|
| `--new <slug>` | write a blank profile template you can fill in, and print its path |

```bash
swipekit product
swipekit product habit-tracker
swipekit product --new habit-tracker
```

---

## Collection (these open Chrome)

First run only: TikTok will probably show a slider captcha. Solve it in the window that
opened. The command waits up to four minutes, then continues. It only happens once per
Chrome profile.

### `discover`

Search TikTok for each query and collect what comes back. Phrase queries the way the
audience would, not the way a marketer would.

| Flag | Default | Meaning |
|---|---|---|
| `--target <n>` | `120` | posts to collect per query |
| `--max-followers <n>` | `100000` | ignore accounts bigger than this |
| `--min-vpf <n>` | `3` | minimum views per follower to keep a post |

```bash
swipekit discover "morning routine" "how to build habits" --target 120
swipekit discover "declutter my room" --max-followers 50000 --min-vpf 5
```

Prints, per query: posts scanned, slideshow count and share, qualifying accounts,
median views-per-follower, median save ratio, the modal slide count, and the top
sounds.

### `scan`

Pull an account's recent posts so its numbers stop being an estimate off the handful
of posts a search happened to surface. Run it on any account you are about to trust in
a ranking. Handles work with or without the `@`.

| Flag | Default | Meaning |
|---|---|---|
| `--target <n>` | `60` | posts to pull per account |

```bash
swipekit scan glowuptips.apex
swipekit scan @habib.lifts @another.creator --target 90
```

Prints, per account: followers, posts scanned, slideshow share, modal slide count,
banger rate, whether it is `REPEATABLE`, median views / vpf / save / comment, recency
and cadence, top sounds, and a one-line verdict.

### `track`

Collect every post using a sound, to tell a real repeatable format from a post that
just rode a trending audio. Give it sound IDs (from `discover` output or `sounds`).

| Flag | Default | Meaning |
|---|---|---|
| `--target <n>` | `120` | posts to collect per sound |

```bash
swipekit track 7123456789012345678
```

Prints, per sound: posts scanned, slideshow count, distinct accounts, whether it is a
`COHORT` (one operator running many accounts), median vpf, and modal slide count.

---

## Reading the library

### `search`

Full-text search everything already collected. Instant, never browses.

| Flag | Default | Meaning |
|---|---|---|
| `--limit <n>` | `15` | rows to print |

```bash
swipekit search "potty training"
swipekit search glowuptips --limit 30
```

### `stats`

What is in the library right now: the resolved path, post and slideshow counts,
accounts, batches, and the one number that decides a niche, how many accounts under
100k followers have a slideshow past 100k views.

```bash
swipekit stats
```

### `accounts`

Rank collected accounts on the numbers that transfer to you, not raw views. Six columns
by default: handle, followers, slideshow share, views in the window, best single post,
and whether the account is repeatable. The finer metrics still drive `--sort`, they
just are not all printed.

| Flag | Default | Meaning |
|---|---|---|
| `--min-views-30d <n>` | | floor on views in the rolling 30 day window |
| `--max-followers <n>` | | ignore accounts bigger than this |
| `--min-followers <n>` | | ignore accounts smaller than this |
| `--min-slideshow <n>` | | minimum share of posts that are slideshows, `0` to `1` |
| `--repeatable` | off | only accounts that cleared the bar 3+ times, one inside 90 days |
| `--window <days>` | `30` | rolling window for the views column |
| `--sort <field>` | `views30d` | `views30d`, `vpf`, `spike`, `followers`, `postsPerWeek` |
| `--limit <n>` | `10` | rows to print |
| `--run <runId>` | | scope to one research run |

```bash
swipekit accounts --repeatable --limit 10
swipekit accounts --min-views-30d 100000 --max-followers 50000 --sort spike
```

If any printed account is still running on too few held posts, it prints an
`unreliable ... scan first` line naming them. Run `scan` on those before trusting the row.

### `top`

The individual posts worth looking at. Prints each post's handle, followers, views,
vpf, save and comment rate, outlier score, slide count, age, the hook, and the URL.

| Flag | Default | Meaning |
|---|---|---|
| `--batch <id>` | | scope to one collection batch |
| `--sort <field>` | `vpf` | `vpf`, `views`, `saves`, `outlier`, `recent` |
| `--limit <n>` | `12` | rows to print |
| `--max-followers <n>` | | ignore accounts bigger than this |
| `--min-views <n>` | `50000` | floor on views, keeps junk out of the ranking |
| `--max-age-days <n>` | `180` | ignore posts older than this |
| `--exclude-assets <list>` | | comma separated asset types to skip, e.g. `face,studio` |
| `--run <runId>` | current run | scope to one research run |
| `--all-runs` | off | search the whole library, mixing every niche |

```bash
swipekit top --sort saves --limit 12
swipekit top --sort outlier --exclude-assets face,studio --max-followers 100000
```

`--sort saves` is usually the one to start with. A save means "I will come back to
this", which is the intent that installs an app.

### `sounds`

Sounds that more than one account is using, with account and post counts, median views,
and how recent the newest post is. A `→` marks one you have not tracked yet, a `·` one
you have.

| Flag | Default | Meaning |
|---|---|---|
| `--limit <n>` | `10` | rows to print |

```bash
swipekit sounds
```

### `formats`

Hook types and structures that more than one unrelated account landed on. One account
doing something well is a person, several unrelated accounts is a format. Prints
grouped tables: hook types, structures, visual styles, and what producing each costs by
input asset.

| Flag | Meaning |
|---|---|
| `--exclude-assets <list>` | comma separated asset types to skip |

```bash
swipekit formats
swipekit formats --exclude-assets studio
```

### `evidence`

Dump the evidence pack the agent uses to write a playbook, as JSON on stdout. Useful
for piping into another tool or inspecting what the agent sees.

```bash
swipekit evidence > evidence.json
```

---

## Output

### `report`

Build the single self-contained HTML report: the answer, the reasoning, a slide
skeleton rewritten in your subject matter, the accounts that proved each format with
their real numbers, and the formats to skip. Thumbnails are inlined, so it opens
anywhere. Prints the path when it finishes.

| Flag | Default | Meaning |
|---|---|---|
| `--posts <n>` | `14` | posts to show in the proof section |
| `--run <runId>` | current run | scope to one research run |
| `--out <path>` | named after the run | where to write it |

```bash
swipekit report --posts 16
swipekit report --run run_abc123 --out ~/Desktop/room-resets.html
```

Scope it to a run whenever you can. Unscoped it covers the whole library, so with two
niches researched it will argue about one and show evidence from the other. Reports are
named after the run and sit side by side rather than overwriting each other.

Slide thumbnails go through `sips`, so on Linux the file still writes, it just has no
slide images.

### `plan`

Show the posting schedule your agent wrote for this run: dates, weekday, pattern,
topic, slide count, and which posts each entry is modelled on. If no plan exists yet it
says so.

| Flag | Default | Meaning |
|---|---|---|
| `--run <runId>` | current run | scope to one research run |

```bash
swipekit plan
```

### `plan-doc`

Write the plan out as a standalone page you can produce from, and print the path.

| Flag | Default | Meaning |
|---|---|---|
| `--run <runId>` | current run | scope to one research run |
| `--out <path>` | | where to write it |

```bash
swipekit plan-doc --out ~/Desktop/next-30-days.html
```

### `export`

Export the plan as markdown plus slide images, zipped for import into Notion (Import >
Markdown & CSV, pick the zip, and Notion resolves the relative image paths). Prints the
zip path and a count of posts and images.

| Flag | Default | Meaning |
|---|---|---|
| `--run <runId>` | current run | scope to one research run |
| `--all-runs` | off | export the whole library instead |
| `--posts <n>` | `8` | posts to include in the proof section |
| `--out <path>` | | where to write the zip |

```bash
swipekit export
swipekit export --run run_abc123 --posts 12
```

### `slides`

Download a post's slides to disk as JPGs plus a `metadata.json`, under
`library/posts/<awemeId>/`. With no IDs it takes the three most saved posts. An agent
reads slides in memory with `read_slides` instead, this is for when you want the files.

| Flag | Default | Meaning |
|---|---|---|
| `--max-slides <n>` | `10` | slides per post |

```bash
swipekit slides
swipekit slides 7123456789012345678 7223456789012345678 --max-slides 15
```

### `zip`

Bundle posts with their slides and metadata into a zip. Give it post IDs, or use
`--handle` to bundle an account's best posts. Prints the result as JSON.

| Flag | Default | Meaning |
|---|---|---|
| `--handle <handle>` | | bundle this account's best posts instead of listed IDs |
| `--n <n>` | `5` | posts to bundle when using `--handle` |
| `--sort <field>` | `views` | `views`, `saves`, `vpf` |

```bash
swipekit zip 7123456789012345678
swipekit zip --handle glowuptips.apex --n 8 --sort saves
```

---

## Environment variables

| Variable | Effect |
|---|---|
| `SWIPEKIT_HOME` | library location, overrides the default resolution |
| `SWIPEKIT_CDP_PORT` | Chrome DevTools port for session sharing (default `9423`) |
| `NO_COLOR` / `FORCE_COLOR` | force CLI colour off / on; otherwise it follows the terminal |
| `MCP_HTTP` / `MCP_PORT` | run `swipekit-mcp` over HTTP instead of stdio (default port `8934`) |

## Exit behaviour

`--help` and a bad flag never touch the database. Any command error prints the message
and exits non-zero. `evidence` and `zip` write JSON to stdout, everything else writes a
human-readable table or block, coloured when the terminal supports it.
