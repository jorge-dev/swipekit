#!/usr/bin/env node
/**
 * Everything the MCP tools can do, without an agent in the loop.
 *
 *   swipekit discover "toddler routine" "toddler transitions" --target 120
 *   swipekit top --sort vpf --limit 15 --max-followers 100000
 *   swipekit --help
 *
 * Commander owns the help text so it is generated from the same definitions that parse
 * the flags. Hand-written usage strings drift the first time a flag changes; these cannot.
 */
// The bin shebang cannot pass --no-warnings, and node:sqlite is still flagged experimental.
// Nobody running a CLI needs to see that on every invocation.
process.removeAllListeners("warning");

import { Command, Option } from "commander";
import type { DatabaseSync } from "node:sqlite";

import { open, searchLibrary } from "./store/db.ts";
import { discover, topPosts } from "./collect/discover.ts";
import { openSession } from "./collect/session.ts";
import { scanAccounts } from "./collect/scan.ts";
import { formatRollup } from "./analyze/taxonomy.ts";
import { fetchSlides } from "./output/slides.ts";
import { soundCandidates, trackSound } from "./collect/sound.ts";
import { buildReport } from "./output/report.ts";
import { latestPlan } from "./analyze/calendar.ts";
import { buildPlanDoc } from "./output/plan.ts";
import { exportBundle } from "./output/export.ts";
import { zipPost, zipTopPosts } from "./output/zip.ts";
import { evidencePack } from "./analyze/playbook.ts";
import { accountRows, needsScan } from "./analyze/accounts.ts";
import { currentRun, findPriorResearch, listRuns, setCurrentRun, startRun } from "./store/runs.ts";
import { getProduct, listProducts, saveProduct } from "./store/products.ts";
import { LIBRARY_DIR, libPath } from "./store/paths.ts";

/**
 * Opened on first use, not at import. `--help` and a bad flag should never leave a
 * database file behind on someone's disk.
 */
const handle: { db: DatabaseSync | null } = { db: null };
const db = () => (handle.db ??= open());

const int = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;
const csv = (v?: string) => (v ?? "").split(",").filter(Boolean);

/**
 * Aligned columns, no ceremony. console.table() prints an "(index)" column and wraps
 * every string in quotes, which reads like a debugger dump rather than a report — fine
 * for a REPL, wrong for a tool someone runs to make a decision.
 *
 * Numbers right-align, everything else left-aligns, and a column whose header ends in
 * "%" gets its values run through pct(). Pass `cols` to fix the order and drop the rest.
 */
function table(rows: Record<string, unknown>[], cols?: string[]): void {
  if (!rows.length) return;
  const keys = cols ?? Object.keys(rows[0]!);
  const fmt = (k: string, v: unknown) =>
    v == null ? "-" : k.endsWith("%") && typeof v === "number" ? pct(v) : String(v);
  const body = rows.map((r) => keys.map((k) => fmt(k, r[k])));
  const width = keys.map((k, i) => Math.max(k.length, ...body.map((row) => row[i]!.length)));
  const numeric = keys.map((_, i) => body.every((row) => /^[\d.%-]+$/.test(row[i]!)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (numeric[i] ? c.padStart(width[i]!) : c.padEnd(width[i]!)))
      .join("  ")
      .trimEnd();
  console.log(line(keys));
  for (const row of body) console.log(line(row));
}

/** Browser work always closes its context, including when the command throws. */
async function withSession<T>(fn: (ctx: Awaited<ReturnType<typeof openSession>>) => Promise<T>) {
  const ctx = await openSession();
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

const program = new Command();

program
  .name("swipekit")
  .description(
    "Find the TikTok slideshow formats that work in your niche, with the numbers to back it up.\n" +
      "Reads and writes a local SQLite library. No account, no API key, nothing leaves your machine.",
  )
  .version("0.1.0")
  .showHelpAfterError("(run --help to see the available options)")
  .enablePositionalOptions();

// ── research scope ───────────────────────────────────────────────────────────

program
  .command("runs")
  .description("start, switch, or list research runs (a run scopes every batch to one question)")
  .option("--start <label>", "start a new run and make it current")
  .option("--brief <text>", "one line on what you are researching", "")
  .option("--use <runId>", "switch the current run")
  .action((o) => {
    if (o.start) console.log("started", startRun(db(), o.start, o.brief));
    if (o.use) setCurrentRun(db(), o.use);
    const rows = listRuns(db()).map((r) => ({
      "": r.current ? "→" : " ",
      id: r.id,
      label: r.label,
      posts: r.posts,
      batches: r.batches,
      started: new Date(r.created_at).toISOString().slice(0, 10),
    }));
    table(rows as Record<string, unknown>[]);
  });

program
  .command("search")
  .description("full-text search posts already collected — instant, no browsing")
  .argument("<query>", "words to search captions, hashtags, handles for")
  .option("--limit <n>", "rows to print", int, 15)
  .action((query: string, o) => {
    const rows = searchLibrary(db(), query, o.limit);
    if (!rows.length) return void console.log("nothing matches yet — run discover first");
    for (const r of rows)
      console.log(`@${r.uniqueId}  ${r.views} views  ${r.saves} saves  ${r.slides} slides  ${r.hook}`);
  });

program
  .command("seen")
  .description("check whether an account or topic has already been researched, before scraping it again")
  .argument("<handleOrKeyword>", "an @handle, or a topic word")
  .action((q: string) => {
    // @-prefixed means a handle; anything else is a topic keyword. Guessing from shape alone
    // (e.g. "any bare word could be a handle") misfires on single-word topics like
    // "looksmaxxing" and silently returns nothing instead of the runs that cover it.
    const r = findPriorResearch(db(), q.startsWith("@") ? { handle: q.slice(1) } : { keyword: q });
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
    if (!r.accountCoverage.length && !r.relatedRuns.length) {
      return void console.log(`no prior research on ${q} — safe to collect`);
    }
    for (const a of r.accountCoverage)
      console.log(
        `@${a.handle}: ${a.postsHeld} posts held in run "${a.runLabel ?? "?"}", last fetched ${day(a.lastFetched)}`,
      );
    for (const run of r.relatedRuns)
      console.log(
        `run "${run.label}"  ${run.matchingBatches} matching ${run.matchingBatches === 1 ? "batch" : "batches"}  started ${day(run.createdAt)}`,
      );
  });

program
  .command("product")
  .description("manage product profiles, which tell the agent what you are actually building")
  .argument("[slug]", "print an existing profile")
  .option("--new <slug>", "write a blank profile template you can fill in")
  .action((slug, o) => {
    if (o.new) return void console.log("template →", saveProduct(o.new).path);
    if (slug) return void console.log(getProduct(slug)?.content ?? "not found");
    table(listProducts() as Record<string, unknown>[]);
  });

// ── collection (these open Chrome) ───────────────────────────────────────────

program
  .command("discover")
  .description("search TikTok and collect what comes back (opens Chrome)")
  .argument("<queries...>", "search terms, phrased the way the audience would say them")
  .option("--target <n>", "posts to collect per query", int, 120)
  .option("--max-followers <n>", "ignore accounts bigger than this", int, 100000)
  .option("--min-vpf <n>", "minimum views per follower", int, 3)
  .action(async (queries: string[], o) => {
    const summaries = await withSession((ctx) =>
      discover(ctx, db(), {
        queries,
        target: o.target,
        filters: { maxFollowers: o.maxFollowers, minVPF: o.minVpf },
      }),
    );
    for (const s of summaries) {
      console.log(`\n── "${s.query}"  [${s.batchId}]`);
      console.log(`   scanned ${s.scanned}  slideshows ${s.slideshows} (${pct(s.photoShare)})`);
      console.log(
        `   qualifying accounts ${s.qualifyingAccounts}  medianVPF ${s.medianVPF}  medianSaveRatio ${s.medianSaveRatio}`,
      );
      console.log(`   modal slide count ${s.slideCountMode}  sounds ${JSON.stringify(s.topSounds)}`);
      console.log(`   ${s.note}`);
    }
  });

program
  .command("scan")
  .description("pull an account's recent posts so its numbers become reliable (opens Chrome)")
  .argument("<handles...>", "handles, with or without the @")
  .option("--target <n>", "posts to pull per account", int, 60)
  .action(async (handles: string[], o) => {
    const reports = await withSession((ctx) => scanAccounts(ctx, db(), handles, { target: o.target }));
    for (const r of reports) {
      console.log(`\n── @${r.handle}  ${r.followers ?? "?"} followers`);
      console.log(
        `   posts ${r.postsScanned}  slideshows ${r.slideshows} (${pct(r.photoShare)})  modal slides ${r.modalSlideCount}`,
      );
      console.log(
        `   bangers ${r.bangers} (${pct(r.bangerRate)})  REPEATABLE: ${r.repeatable ? "YES" : "no"}`,
      );
      console.log(
        `   median views ${r.medianViews}  vpf ${r.medianVPF}  save ${(r.medianSaveRatio * 100).toFixed(1)}%  comment ${(r.medianCommentRatio * 100).toFixed(2)}%`,
      );
      console.log(
        `   last post ${r.daysSinceLastPost}d ago  ${r.postsLast30d} in 30d  cadence ${r.cadencePerWeek}/wk  consistency ${r.consistency}`,
      );
      console.log(`   sounds ${JSON.stringify(r.topSounds)}`);
      console.log(`   → ${r.verdict}`);
    }
  });

program
  .command("track")
  .description("collect every post using a sound, to tell a real format from trending audio (opens Chrome)")
  .argument("<soundIds...>")
  .option("--target <n>", "posts to collect per sound", int, 120)
  .action(async (ids: string[], o) => {
    await withSession(async (ctx) => {
      let warmed = false;
      for (const id of ids) {
        const r = await trackSound(ctx, db(), id, { target: o.target, warmed });
        warmed = true;
        console.log(`\n── sound ${r.soundId}`);
        console.log(
          `   scanned ${r.scanned}  slideshows ${r.slideshows}  distinct accounts ${r.distinctAccounts}`,
        );
        console.log(
          `   COHORT: ${r.isCohort ? "YES" : "no"}  medianVPF ${r.medianVPF}  modal slides ${r.slideCountMode}`,
        );
        console.log(`   ${r.note}`);
      }
    });
  });

// ── reading the library ──────────────────────────────────────────────────────

program
  .command("accounts")
  .description("rank collected accounts on the numbers that transfer to you")
  .option("--min-views-30d <n>", "floor on views in the rolling 30 day window", int)
  .option("--max-followers <n>", "ignore accounts bigger than this", int)
  .option("--min-followers <n>", "ignore accounts smaller than this", int)
  .option("--min-slideshow <n>", "minimum share of posts that are slideshows, 0 to 1", Number)
  .option("--repeatable", "only accounts that cleared the bar 3+ times, one inside 90 days")
  .option("--window <days>", "rolling window for the views column", int, 30)
  .addOption(
    new Option("--sort <field>", "ranking field")
      .default("views30d")
      .choices(["views30d", "vpf", "spike", "followers", "postsPerWeek"]),
  )
  .option("--limit <n>", "rows to print", int, 10)
  .option("--run <runId>", "scope to one research run")
  .action((o) => {
    const rows = accountRows(db(), {
      minViews30d: o.minViews30d,
      maxFollowers: o.maxFollowers,
      minFollowers: o.minFollowers,
      minSlideshowPct: o.minSlideshow,
      requireRepeatable: Boolean(o.repeatable),
      windowDays: o.window,
      sortBy: o.sort,
      limit: o.limit,
      runId: o.run,
    });
    if (!rows.length) return void console.log("no accounts matched — loosen filters or run discover");
    table(
      // Six columns, not ten: a wall of numbers is not a decision. followers next to
      // `best` is the thesis in one row — a tiny account with a huge post — and
      // `repeatable` says whether that was a system or a fluke. The finer metrics
      // (vpf, spike, cadence) still drive --sort, they just don't all need printing.
      rows.map((r) => ({
        handle: `@${r.handle}`,
        followers: r.followers ?? "?",
        "slideshow%": r.slideshowPct,
        views30d: r.views30d,
        best: r.bestViews,
        repeatable: r.repeatable ? "yes" : "no",
      })),
    );
    const ns = needsScan(rows);
    if (ns.length) console.log(`\nunreliable (too few posts held) — scan first: ${ns.join(", ")}`);
  });

program
  .command("top")
  .description("the individual posts worth looking at")
  .option("--batch <id>", "scope to one collection batch")
  .addOption(
    new Option("--sort <field>", "ranking field")
      .default("vpf")
      .choices(["vpf", "views", "saves", "outlier", "recent"]),
  )
  .option("--limit <n>", "rows to print", int, 12)
  .option("--max-followers <n>", "ignore accounts bigger than this", int)
  .option("--min-views <n>", "floor on views, keeps junk out of the ranking", int, 50000)
  .option("--max-age-days <n>", "ignore posts older than this", int, 180)
  .option("--exclude-assets <list>", "comma separated asset types to skip, e.g. face,studio")
  .option("--run <runId>", "scope to one research run (defaults to the current one)")
  .option("--all-runs", "search the whole library instead, mixing every niche you have researched")
  .action((o) => {
    const rows = topPosts(db(), {
      runId: o.allRuns ? null : (o.run ?? currentRun(db())),
      batchId: o.batch,
      sortBy: o.sort,
      limit: o.limit,
      maxFollowers: o.maxFollowers,
      minViews: o.minViews,
      maxAgeDays: o.maxAgeDays,
      excludeAssets: csv(o.excludeAssets),
    });
    if (!rows.length) return void console.log("no rows — run discover first");
    for (const r of rows) {
      console.log(
        `\n@${r.handle}  ${r.followers ?? "?"}f  ${r.views} views  vpf ${r.vpf}  save ${(r.saveRatio * 100).toFixed(1)}%  ` +
          `cmt ${(r.commentRatio * 100).toFixed(2)}%  outlier ${r.outlier ?? "–"}  ${r.slides} slides  ${r.ageDays}d old`,
      );
      console.log(`  ${r.hook || "(no caption)"}`);
      console.log(`  ${r.url}`);
    }
  });

program
  .command("sounds")
  .description("sounds that more than one account is using")
  .option("--limit <n>", "rows to print", int, 10)
  .action((o) => {
    const rows = soundCandidates(db(), o.limit, currentRun(db()));
    if (!rows.length) return void console.log("no multi-account sounds yet — run discover first");
    for (const r of rows)
      console.log(
        `${r.tracked ? "·" : "→"} ${r.soundId}  ${r.accounts} accounts / ${r.posts} posts  avg ${r.medianViews} views  newest ${r.newestDays}d`,
      );
  });

program
  .command("formats")
  .description("hook types and structures that more than one unrelated account landed on")
  .option("--exclude-assets <list>", "comma separated asset types to skip")
  .action((o) => {
    const r = formatRollup(db(), { excludeAssets: csv(o.excludeAssets), runId: currentRun(db()) });
    if (!r.byHookType.length && !r.byStructure.length) {
      return void console.log(
        "no format has repeated across accounts yet — read more posts with `top` + read_slides",
      );
    }
    console.log("\nhook types more than one account landed on");
    table(r.byHookType as Record<string, unknown>[], ["hook_type", "accounts", "posts", "avg_views"]);
    console.log("\nstructures");
    table(r.byStructure as Record<string, unknown>[], ["structure", "accounts", "posts"]);
    console.log("\nvisual style");
    table(r.visualStyles as Record<string, unknown>[], ["visual_style", "n"]);
    if (r.assetDemand.length) {
      console.log("\nwhat producing these costs, by input");
      table(r.assetDemand as Record<string, unknown>[], ["asset", "posts"]);
    }
  });

program
  .command("evidence")
  .description("dump the evidence pack the agent uses to write a playbook")
  .action(() => console.log(JSON.stringify(evidencePack(db()), null, 2)));

program
  .command("stats")
  .description("what is in the library right now")
  .action(() => {
    const q = (s: string) => db().prepare(s).get() as any;
    console.log("library     ", LIBRARY_DIR);
    console.log("posts       ", q("SELECT COUNT(*) n FROM posts").n);
    console.log("slideshows  ", q("SELECT COUNT(*) n FROM posts WHERE is_photo=1").n);
    console.log("accounts    ", q("SELECT COUNT(*) n FROM accounts").n);
    console.log("batches     ", q("SELECT COUNT(*) n FROM batches").n);
    console.log(
      "go/no-go    ",
      q(`SELECT COUNT(DISTINCT sec_uid) n FROM posts
         WHERE is_photo=1 AND play >= 100000 AND followers < 100000`).n,
      "accounts <100k followers with a 100k+ view slideshow",
    );
  });

// ── output ───────────────────────────────────────────────────────────────────

program
  .command("report")
  .description("build the self contained HTML report")
  .option("--posts <n>", "posts to show in the proof section", int, 14)
  .option("--out <path>", "where to write it; defaults to a file named after the run")
  .option("--run <runId>", "scope to one research run (defaults to the current one)")
  .action(async (o) => {
    console.log(
      "report →",
      await buildReport(db(), { posts: o.posts, out: o.out, runId: o.run ?? currentRun(db()) }),
    );
  });

program
  .command("plan")
  .description("show the posting schedule your agent wrote for this run")
  .option("--run <runId>", "scope to one research run (defaults to the current one)")
  .action((o) => {
    const plan = latestPlan(db(), o.run ?? currentRun(db()));
    if (!plan) return void console.log("no plan yet — ask your agent to write one after the playbook");
    console.log(`${plan.entries.length} posts at ~${plan.postsPerWeek}/week from ${plan.startsOn}\n`);
    for (const e of plan.entries) {
      console.log(`${e.date}  ${String(e.weekday).slice(0, 3)}  ${e.pattern}`);
      console.log(`             ${e.topic}`);
      const from = (e.sources ?? []).map((x) => `@${x.handle ?? x.awemeId}`).join(", ");
      console.log(`             ${e.slides.length} slides${from ? `, modelled on ${from}` : ""}`);
    }
  });

program
  .command("plan-doc")
  .description("write the plan out as a page you can produce from")
  .option("--run <runId>", "scope to one research run (defaults to the current one)")
  .option("--out <path>", "where to write it")
  .action(async (o) => {
    console.log(await buildPlanDoc(db(), { runId: o.run ?? currentRun(db()), out: o.out }));
  });

program
  .command("export")
  .description("export the plan as markdown plus slide images, zipped for import into Notion")
  .option("--run <runId>", "scope to one research run (defaults to the current one)")
  .option("--all-runs", "export the whole library instead")
  .option("--posts <n>", "posts to include in the proof section", int, 8)
  .option("--out <path>", "where to write the zip")
  .action(async (o) => {
    const r = await exportBundle(db(), {
      runId: o.allRuns ? null : (o.run ?? currentRun(db())),
      posts: o.posts,
      out: o.out,
    });
    console.log(`${r.zip}\n  ${r.posts} posts, ${r.images} slide images`);
    console.log("  Notion: Import > Markdown & CSV, pick the zip. Images come with it.");
  });

program
  .command("slides")
  .description("download a post's slides to disk (the agent reads them with read_slides instead)")
  .argument("[awemeIds...]", "defaults to the three most saved posts")
  .option("--max-slides <n>", "slides per post", int, 10)
  .action(async (ids: string[], o) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const targets = ids.length ? ids : topPosts(db(), { limit: 3, sortBy: "saves" }).map((r) => r.id);
    for (const p of await fetchSlides(db(), targets, o.maxSlides)) {
      if (p.error) {
        console.log(`${p.awemeId}  ✗ ${p.error}`);
        continue;
      }
      const dir = libPath("posts", p.awemeId);
      mkdirSync(dir, { recursive: true });
      for (const [k, im] of p.images.entries()) {
        writeFileSync(`${dir}/slide-${String(k + 1).padStart(2, "0")}.jpg`, Buffer.from(im.data, "base64"));
      }
      writeFileSync(`${dir}/metadata.json`, JSON.stringify({ ...p, images: undefined }, null, 2));
      console.log(`@${p.handle}  ${p.images.length} slides → ${dir}`);
    }
  });

program
  .command("zip")
  .description("bundle posts with their slides and metadata")
  .argument("[awemeIds...]")
  .option("--handle <handle>", "bundle an account's best posts instead")
  .option("--n <n>", "posts to bundle when using --handle", int, 5)
  .addOption(
    new Option("--sort <field>", "which posts to take").default("views").choices(["views", "saves", "vpf"]),
  )
  .action(async (ids: string[], o) => {
    const r = o.handle
      ? await zipTopPosts(db(), o.handle, { n: o.n, sortBy: o.sort })
      : { zips: await Promise.all(ids.map((id) => zipPost(db(), id))) };
    console.log(JSON.stringify(r, null, 2));
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  handle.db?.close();
}
