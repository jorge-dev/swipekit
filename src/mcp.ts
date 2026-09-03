#!/usr/bin/env node
/**
 * MCP server, stdio by default, streamable HTTP when MCP_HTTP is set.
 *
 * stdio (default — works fine with more than one client now; openSession in
 * collect/session.ts attaches a second process to the first one's Chrome instead of
 * fighting it for the profile lock, so no manual setup is needed for the common case):
 *
 *   swipekit-mcp
 *   claude mcp add swipekit -- swipekit-mcp
 *
 * HTTP (a genuinely shared process — one SQLite handle and warm cache across every
 * client, not per-process; reach for this when several agents should be reading the
 * same cache rather than each keeping their own):
 *
 *   MCP_HTTP=1 MCP_PORT=8934 swipekit-mcp &
 *   claude mcp add --transport http swipekit http://127.0.0.1:8934/mcp
 *   codex mcp add swipekit --url http://127.0.0.1:8934/mcp
 *
 * Binds to 127.0.0.1 only — this is a personal local tool, not a multi-tenant service.
 *
 * Tool descriptions here are prompt real estate — they encode the research strategy
 * (rank by outlier not views, follow sounds, search not hashtags) so the model doesn't
 * have to guess it. Every tool returns a summary under ~2KB; raw posts stay in SQLite.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import type { BrowserContext } from "playwright-core";
import { open, searchLibrary } from "./store/db.ts";
import { discover, topPosts } from "./collect/discover.ts";
import { hideBrowser, openSession, showBrowser } from "./collect/session.ts";
import { scanAccount, scanAccounts } from "./collect/scan.ts";
import { formatRollup, AnalysisSchema } from "./analyze/taxonomy.ts";
import { alreadyAnalyzed, fetchSlides, fetchSlidesWithRefresh, saveAnalyses } from "./output/slides.ts";
import { soundCandidates, trackSound } from "./collect/sound.ts";
import { zipPost, zipTopPosts } from "./output/zip.ts";
import {
  evidencePack,
  getPlaybook,
  listPlaybooks,
  PlaybookSchema,
  savePlaybook,
} from "./analyze/playbook.ts";
import { PlanEntrySchema, latestPlan, savePlan } from "./analyze/calendar.ts";
import { buildPlanDoc } from "./output/plan.ts";
import { findAccounts } from "./analyze/accounts.ts";
import {
  currentRun,
  findPriorResearch,
  listRuns,
  requireRun,
  setCurrentRun,
  startRun,
} from "./store/runs.ts";
import { cachedBatch } from "./collect/discover.ts";
import { getProduct, listProducts, saveProduct } from "./store/products.ts";
import { buildReport } from "./output/report.ts";
import { exportBundle } from "./output/export.ts";

process.chdir(new URL("..", import.meta.url).pathname); // library/ is relative to the project

const db = open();

// One browser for the whole session, opened lazily — launching Chrome on startup would
// pop a window even for read-only tools.
let ctx: BrowserContext | null = null;
let warmed = false;

/**
 * Is our handle on Chrome still good?
 *
 * It can stop being good without us doing anything. openSession() may have attached us over
 * CDP to a browser another process launched; when that process exits, its Chrome goes with
 * it and our context is a handle on nothing. The user also just closes the window sometimes.
 * Either way the next browser-driving call would fail on a dead object forever, because we
 * cached it. Checking is cheap and the recovery is to open a fresh session.
 */
function browserIsLive(c: BrowserContext): boolean {
  try {
    const b = c.browser();
    // A context from launchPersistentContext can report no browser; nothing has told us it
    // died, so assume it is fine and let the close event below correct us if it is not.
    return b ? b.isConnected() : true;
  } catch {
    return false;
  }
}

async function browser(): Promise<BrowserContext> {
  if (ctx && !browserIsLive(ctx)) ctx = null;
  if (!ctx) {
    ctx = await openSession();
    // Warmup is per-browser, not per-process: a new browser has a cold profile again.
    warmed = false;
    ctx.once("close", () => {
      ctx = null;
      warmed = false;
    });
  }
  return ctx;
}

/**
 * Serializes every browser-driving tool call behind one queue.
 *
 * Under stdio this never matters — one client, one process, calls are already sequential.
 * Under HTTP it's load-bearing: multiple clients share this one process, and two concurrent
 * calls both scrolling the same Playwright page would corrupt each other's state. Non-browser
 * tools (find_accounts, evidence_pack, library_stats, ...) never touch this queue and run
 * concurrently — only crawling is serialized.
 */
let browserQueue: Promise<unknown> = Promise.resolve();
let activeBrowserTasks = 0;

function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const task = async () => {
    activeBrowserTasks++;
    // Raise it before the work so you can watch, and only if it already exists: the first
    // call creates a visible window anyway.
    if (ctx) await showBrowser(ctx);
    try {
      return await fn();
    } finally {
      activeBrowserTasks--;
      // Last one out minimises. The context stays alive for the warm profile; the window
      // stops sitting in front of everything with nothing to do.
      if (activeBrowserTasks === 0 && ctx) await hideBrowser(ctx);
    }
  };
  const run = browserQueue.then(task, task);
  browserQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Accept either the array parameter or its singular alias.
 *
 * Reading a real session transcript showed 12 of 14 tool errors were this one shape: the
 * agent's instinct is to call a tool once per item ({handle: "x"}, {awemeId: "y"}), not to
 * batch ({handles: ["x"]}). It recovers after the error, but every one of those is a wasted
 * round trip, and read_slides in particular is the call it retried six times before getting
 * the shape right. Accepting both is cheaper than teaching every agent the same lesson.
 */
function oneOrMany(many: string[] | undefined, one: string | undefined, field: string, hint = ""): string[] {
  const list = many ?? (one ? [one] : []);
  if (!list.length) {
    // The old wording said "an array of ids" for every caller, which is wrong for
    // discover — those are search phrases, not ids — and a misleading error is worse
    // than a terse one when the model is deciding what to send next.
    throw new Error(`${field} is required: pass an array, or the singular form.${hint ? ` ${hint}` : ""}`);
  }
  return list;
}

function registerAllTools(server: McpServer): void {
  const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

  server.registerTool(
    "product_profile",
    {
      title: "What the caller is building, and what they can produce",
      description:
        "READ THIS BEFORE WRITING A PLAYBOOK. A product profile is a markdown file the user owns " +
        "describing their product, audience, and — the load-bearing part — what they can actually " +
        "produce: design tools, stock or generated imagery, photography of real subjects, their " +
        "own face on camera, screen recordings.\n\n" +
        "Use the 'What I can produce' section to set excludeAssets on top_posts and format_rollup, " +
        "rather than assuming anything. If no profile exists, offer to create one — do not invent " +
        "the caller's constraints.\n\n" +
        "Call with no slug to list profiles.",
      inputSchema: { slug: z.string().optional().describe("Omit to list all profiles") },
    },
    async ({ slug }) => {
      if (!slug) {
        const all = listProducts();
        return json({
          products: all,
          note: all.length
            ? "Pass a slug to read one."
            : "No profiles yet. save_product_profile creates one from a template the user can edit.",
        });
      }
      const p = getProduct(slug);
      return json(p ?? { error: `no profile '${slug}'`, available: listProducts() });
    },
  );

  server.registerTool(
    "save_product_profile",
    {
      title: "Create or update a product profile",
      description:
        "Writes library/products/<slug>.md. Pass content to write it, or omit content to lay down " +
        "a template for the user to fill in.\n\n" +
        "Only record what the caller actually told you, especially in 'What I can produce' — a " +
        "guessed constraint silently removes formats from every future recommendation.",
      inputSchema: {
        name: z.string().describe("Product name, e.g. 'TickTod'"),
        content: z.string().optional().describe("Full markdown; omit for a blank template"),
      },
    },
    async ({ name, content }) => {
      const p = saveProduct(name, content);
      return json({ slug: p.slug, path: p.path, wroteTemplate: !content });
    },
  );

  server.registerTool(
    "find_prior_research",
    {
      title: "What's already been researched, before you browse anything",
      description:
        "Checks an account or a keyword against every run ever recorded — not just the current " +
        "one. Call this before discover or scan_account when you suspect the work might already " +
        "be done; it costs nothing, no browsing.\n\n" +
        "For a handle: which run(s) hold posts from this account, how many, and when they were " +
        "last fetched — so you can decide 'reuse this' vs 'it's stale, re-scan' instead of " +
        "guessing. For a keyword: which runs already touched this niche, so you can switch to " +
        "that run (list_runs) instead of starting a duplicate one.",
      inputSchema: {
        handle: z.string().optional().describe("An account to check, with or without @"),
        keyword: z
          .string()
          .optional()
          .describe("A niche or topic word to check against past run labels/briefs/queries"),
      },
    },
    async ({ handle, keyword }) => json(findPriorResearch(db, { handle, keyword })),
  );

  server.registerTool(
    "list_playbooks",
    {
      title: "Playbooks already written",
      description:
        "Every write_playbook call ever saved, newest first, with a brief snippet and which run " +
        "it belongs to. Check here before regenerating one — if the same brief was already " +
        "answered, get_playbook returns it instantly instead of re-running evidence_pack.",
      inputSchema: {
        runId: z.string().optional().describe("Restrict to one run; omit for every playbook ever written"),
      },
    },
    async ({ runId }) => json(listPlaybooks(db, runId)),
  );

  server.registerTool(
    "get_playbook",
    {
      title: "Retrieve one saved playbook in full",
      description: "The complete stored playbook by id, exactly as write_playbook saved it.",
      inputSchema: {
        id: z.string().describe("Playbook id from list_playbooks or write_playbook's own return"),
      },
    },
    async ({ id }) => {
      const pb = getPlaybook(db, id);
      return json(pb ?? { error: `no playbook '${id}'` });
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Begin a scoped research question",
      description:
        "Call this FIRST for any new research question. A run groups every search, sound pull " +
        "and account scan that belongs to one question, so later analysis and reports cover that " +
        "question only.\n\n" +
        "Without it the library becomes one undifferentiated pile and a report ends up arguing " +
        "about one product while showing evidence from an unrelated niche. Label it for the niche " +
        "or product; put what the caller is building in `brief`.",
      inputSchema: {
        label: z.string().optional().describe("Short name, e.g. 'Looksmaxxing app' or 'Toddler routines'"),
        topic: z.string().optional().describe("Alias for label"),
        brief: z.string().optional().describe("What the caller is building, in their words"),
        context: z.string().optional().describe("Alias for brief"),
        goal: z.string().optional().describe("Alias for brief"),
        product: z.string().optional().describe("Product profile slug this run is for, if there is one"),
      },
    },
    async ({ label, topic, brief, context, goal }) => {
      const name = label ?? topic;
      if (!name) throw new Error("label is required: a short name for this research question.");
      // The user's product context arrived as `context` in a real run and was silently
      // dropped because the field is called `brief`, leaving the run with no record of what
      // was being built. Accept what the agent actually reaches for.
      return json({ runId: startRun(db, name, brief ?? context ?? goal ?? ""), current: true });
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "Past research questions",
      description:
        "Runs already in the library, newest first, with post counts and which is current. " +
        "Check here before starting a new run — if the question was asked before, reuse that run " +
        "instead of re-scraping. Pass a runId to switch the current run.",
      inputSchema: { setCurrent: z.string().optional().describe("Switch the current run to this id") },
    },
    async ({ setCurrent }) => {
      if (setCurrent) setCurrentRun(db, setCurrent);
      return json({ runs: listRuns(db), current: currentRun(db) });
    },
  );

  server.registerTool(
    "discover",
    {
      title: "Discover slideshow posts by search query",
      description:
        "Scroll TikTok search for each query and store every post found. Returns per-query " +
        "SUMMARIES (counts, medians, modal slide count, shared sounds) plus a batchId — not " +
        "the posts themselves; use top_posts to look at specific ones.\n\n" +
        "Use SEARCH QUERIES, not hashtags: measured 0 slideshows in 59 posts on #toddlermom " +
        "vs ~30% photoShare on search. Phrase queries as the audience's PAIN, not the product " +
        "('toddler wont turn off tv', not 'visual timer').\n\n" +
        "ANSWERS FROM THE LIBRARY FIRST. A query searched within maxAgeDays is returned from " +
        "SQLite instantly and no browser opens — results are marked cached:true with ranDaysAgo. " +
        "Only genuinely new queries cost a page load. Set maxAgeDays:0 to force a refresh when " +
        "the caller wants what's winning *right now*.\n\n" +
        "Each uncached query takes ~60-90s. Start with 2-4. If qualifyingAccounts is under 5, " +
        "say the lane is thin rather than manufacturing a plan.",
      inputSchema: {
        queries: z
          .array(z.string())
          .min(1)
          .max(6)
          .optional()
          .describe("Search phrases, audience pain language"),
        query: z.string().optional().describe("Alias for a single search phrase"),
        target: z.number().default(120).describe("Posts to harvest per query"),
        maxFollowers: z
          .number()
          .default(100_000)
          .describe("Accounts above this don't transfer to a small account"),
        minVPF: z.number().default(3).describe("views/followers floor for 'qualifying'"),
        maxAgeDays: z
          .number()
          .default(7)
          .describe("Reuse a previous run of the same query newer than this; 0 forces a fresh pull"),
      },
    },
    async ({ queries, query, target, maxFollowers, minVPF, maxAgeDays }) => {
      requireRun(db);
      const qs = oneOrMany(
        queries,
        query,
        "queries",
        "This tool does not turn a niche into queries for you — that is your job, and it is the " +
          "part that decides whether the crawl finds anything. Send the phrases the AUDIENCE " +
          "would type when the problem bites, not a description of the niche or the product. " +
          'e.g. queries: ["not building muscle even though i go to the gym", "how to track ' +
          'progressive overload"] — not {niche: "fitness"} and not ["workout tracking app"].',
      );
      // Don't launch Chrome at all if every query is already answered, and don't make a
      // cache-only call wait behind the browser queue either — it never touches the browser.
      const allCached = maxAgeDays > 0 && qs.every((q) => cachedBatch(db, "search", q, maxAgeDays));
      if (allCached) {
        const summaries = await discover(null as any, db, {
          queries: qs,
          target,
          warmed,
          maxAgeDays,
          filters: { maxFollowers, minVPF },
        });
        return json(summaries);
      }
      return withBrowser(async () => {
        const c = await browser();
        const summaries = await discover(c, db, {
          queries: qs,
          target,
          warmed,
          maxAgeDays,
          filters: { maxFollowers, minVPF },
        });
        warmed = true;
        return json(summaries);
      });
    },
  );

  server.registerTool(
    "find_accounts",
    {
      title: "Qualifying accounts as comparison rows",
      description:
        "THE MAIN ANSWER TOOL for 'find me N accounts to learn from'. Reads the library only — " +
        "no browsing. Returns one row per account with everything needed to compare them: " +
        "followers, views in the last 30 days, slideshow %, slides/post, posts/week, spike, " +
        "bangers, repeatable, and links.\n\n" +
        "Present these as a MARKDOWN TABLE in your reply, then say how to read it — which account " +
        "is the blueprint and why, which is the counter-example, which is a fluke. `spike` is " +
        "best ÷ median views: a high spike with few posts is one lucky hit, not a system; a spike " +
        "near 1 with high postsPerWeek is a steady machine. Say that in words; the table alone " +
        "isn't the answer.\n\n" +
        "Check `windowCovered` before quoting views30d — false means we hold fewer posts than the " +
        "window, so the figure is a floor. Accounts with few collected posts need scan_account " +
        "first; `needsScan` in the result names them.\n\n" +
        "Filters are the caller's, with no defaults beyond a limit — pass only what they asked for.",
      inputSchema: {
        minViews30d: z
          .number()
          .optional()
          .describe("e.g. 100000 for 'at least 100k views in the last 30 days'"),
        minFollowers: z.number().optional(),
        maxFollowers: z.number().optional(),
        minSlideshowPct: z
          .number()
          .optional()
          .describe("0-1. Defaults to 0.5 since this is a slideshow tool; pass 0 to include video accounts"),
        minPostsPerWeek: z.number().optional(),
        requireRepeatable: z.boolean().optional().describe("Drop one-hit accounts"),
        windowDays: z.number().default(30),
        sortBy: z
          .enum(["auto", "views30d", "bestViews", "medianViews", "vpf", "spike", "followers", "postsPerWeek"])
          .default("auto")
          .describe(
            "auto ranks on views in the window, but falls back to lifetime best when the window " +
              "is nearly empty — which is normal on a fresh library, because search returns posts " +
              "that performed rather than posts that are recent. The result says which was used.",
          ),
        limit: z.number().default(10),
        runId: z.string().optional().describe("Restrict to a specific run; defaults to the current run"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
      },
    },
    async (args) => {
      const scopedRunId = args.allRuns ? undefined : (args.runId ?? currentRun(db) ?? undefined);
      const {
        rows,
        needsScan: unreliable,
        sortedBy,
        windowEmpty,
        emptyBecause,
        candidates,
      } = findAccounts(db, {
        ...args,
        runId: scopedRunId,
      });

      const notes: string[] = [];
      if (!rows.length) {
        notes.push(
          emptyBecause === "no-accounts"
            ? "Nothing in this run yet — run discover before ranking anything."
            : emptyBecause === "window-filter"
              ? `Nothing matched, and minViews30d is the likely reason: we hold ${candidates} accounts here but almost none have posts inside the window. Search returns what performed, not what is recent, so a 30-day filter on a fresh library usually empties the table. Drop it and sort on bestViews, or scan_account the handles you care about to fill the window in.`
              : `Nothing matched, though we hold ${candidates} accounts in this run. Your filters excluded all of them — loosen the tightest one rather than collecting more.`,
        );
      } else {
        notes.push(
          "Present as a markdown table, then interpret it — which account is the blueprint, which is a fluke, and why.",
        );
        if (sortedBy === "bestViews" && (args.sortBy === "auto" || args.sortBy == null)) {
          notes.push(
            "Ranked on bestViews, not views30d: too few of these accounts have posts inside the window to sort on it. That is expected from search-led discovery. Do not present these as recent-30-day numbers.",
          );
        }
        if (windowEmpty) {
          notes.push(
            "views30d is near-empty across these rows, so treat it as a floor and say so rather than quoting it.",
          );
        }
        if (unreliable.length) {
          notes.push(
            `${unreliable.length} of ${rows.length} rows are reliable:false — we hold too few of their posts, so postsPerWeek is meaningless. Run scan_account on them before quoting those numbers, or say plainly that they're provisional.`,
          );
        }
      }

      return json({ rows, needsScan: unreliable, sortedBy, note: notes.join(" ") });
    },
  );

  server.registerTool(
    "top_posts",
    {
      title: "Rank stored slideshow posts",
      description:
        "Compact rows (<=20) from the library. RANK BY 'outlier' WHEN AVAILABLE — views/the " +
        "account's own median — because it isolates the FORMAT from the account's reach, and " +
        "the format is the only thing that transfers. 'outlier' is null until scan_account has " +
        "collected >=5 posts for that account; until then prefer 'saves' (a save means the post " +
        "reads as reference material, which is what wins for slideshows) over 'vpf'. " +
        "Never rank by raw views — that just measures who already has an audience.\n\n" +
        "minViews defaults to 50000: without a floor, tiny accounts with a few thousand views " +
        "post absurd vpf numbers and crowd out real formats.",
      inputSchema: {
        batchId: z.string().optional().describe("Restrict to one discover batch; omit for whole library"),
        sortBy: z.enum(["outlier", "saves", "vpf", "views", "comments"]).default("saves"),
        limit: z.number().default(12),
        maxFollowers: z.number().optional(),
        minViews: z.number().default(50_000),
        maxAgeDays: z.number().default(180).describe("Recency is a real signal — old formats may be dead"),
        runId: z.string().optional().describe("Scope to one research run; defaults to the current run"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
        excludeAssets: z
          .array(z.string())
          .default([])
          .describe(
            "Drop posts whose format needs any of these inputs — e.g. ['creator_likeness'] or " +
              "['specific_subject']. State the CALLER's constraints; there is no default assumption. " +
              "Only applies to posts that have been analysed.",
          ),
      },
    },
    async ({ allRuns, runId, ...rest }) => {
      const rows = topPosts(db, { ...rest, runId: allRuns ? null : (runId ?? currentRun(db)) });
      const niche = rows.filter((r) => r.outlierBasis === "niche").length;
      return json({
        rows,
        note: niche
          ? `${niche} of ${rows.length} rows have outlierBasis:"niche" — we hold too few posts from those accounts to compare a post against its own median, so it is measured against this run's posts instead. It still ranks, but it says the post beat the niche, not its author. scan_account on the ones you plan to recommend upgrades them to basis "account".`
          : undefined,
      });
    },
  );

  server.registerTool(
    "scan_account",
    {
      title: "Scan accounts and test whether their format is repeatable",
      description:
        "Pull an account's recent posts and judge whether its format is worth copying.\n\n" +
        "THE RULE THIS ENFORCES: never clone a format off a profile with a single viral hit " +
        "— that was luck, not a format. An account is only 'repeatable' when it clears the " +
        "banger bar at least 3 times AND on >=15% of its posts. Check `repeatable` and " +
        "`verdict` before recommending anything.\n\n" +
        "Also unlocks outlier scores for these accounts in top_posts: outlier needs >=5 posts " +
        "from the same account to have a median, which discover batches never have. " +
        "So the normal flow is discover -> top_posts(saves) -> scan_account on the handles -> " +
        "top_posts(outlier).\n\n" +
        "Check daysSinceLastPost too — a format that stopped working is a format people stopped " +
        "posting. ~30-60s per account.",
      inputSchema: {
        handles: z
          .array(z.string())
          .min(1)
          .max(8)
          .optional()
          .describe("Handles, with or without @. Pass several at once rather than one call each"),
        handle: z.string().optional().describe("Alias for a single handle"),
        target: z.number().default(60).describe("Posts to pull per account"),
        maxAgeDays: z
          .number()
          .default(7)
          .describe("Reuse a recent deep scan instead of re-browsing; 0 forces a refresh"),
      },
    },
    async ({ handles, handle, target, maxAgeDays }) => {
      requireRun(db);
      const list = oneOrMany(handles, handle, "handles");
      return withBrowser(async () => {
        const c = await browser();
        const reports = await scanAccounts(c, db, list, { target, warmed, maxAgeDays });
        warmed = true;
        return json(reports);
      });
    },
  );

  server.registerTool(
    "sound_candidates",
    {
      title: "Sounds worth tracking — cheap, no browsing",
      description:
        "Reads the library only. Lists sounds already seen on slideshows from 2+ DIFFERENT " +
        "accounts, which is the signal that a format is spreading rather than one person " +
        "repeating themselves. Call this after discover to decide what to track_sound, instead " +
        "of guessing. Rows marked tracked have already been pulled.",
      inputSchema: { limit: z.number().default(10) },
    },
    async ({ limit }) => json(soundCandidates(db, limit, currentRun(db))),
  );

  server.registerTool(
    "track_sound",
    {
      title: "Pull every slideshow using one sound — the format cohort",
      description:
        "Slideshow trends on TikTok are SOUND-LOCKED: a format spreads as a sound + slide-count " +
        "+ hook-shape package. Pulling one sound returns the set of accounts running the same " +
        "skeleton right now — the most direct answer to 'what is working', and the move a human " +
        "researcher never makes by hand because it is tedious.\n\n" +
        "Call this whenever 2+ high-outlier posts share a soundId (discover reports these in " +
        "topSounds, and sound_candidates ranks them). PREFER IT OVER BROADENING HASHTAGS or " +
        "adding more search queries — it goes deeper into a proven format instead of wider into " +
        "unproven ones.\n\n" +
        "Check isCohort: one account using a sound ten times is a habit, not a format. " +
        "~60-90s per sound.",
      inputSchema: {
        soundIds: z
          .array(z.string())
          .min(1)
          .max(4)
          .optional()
          .describe("Sound ids from topSounds/sound_candidates"),
        soundId: z.string().optional().describe("Alias for a single sound id"),
        target: z.number().default(120),
      },
    },
    async ({ soundIds, soundId, target }) => {
      requireRun(db);
      const ids = oneOrMany(soundIds, soundId, "soundIds");
      return withBrowser(async () => {
        const c = await browser();
        const out = [];
        for (const id of ids) {
          out.push(await trackSound(c, db, id, { target, warmed }));
          warmed = true;
        }
        return json(out);
      });
    },
  );

  server.registerTool(
    "read_slides",
    {
      title: "Fetch a post's slides so YOU can read them",
      description:
        "Returns the actual slide images for each post, for you to look at directly. There is " +
        "no model call inside this tool — you are the analyst.\n\n" +
        "For each post work out the fields below, then pass them to save_analysis. It takes a " +
        "CLOSED taxonomy — the values are listed here so you can pick them while you are looking " +
        "at the slides, instead of inventing one and having the call rejected:\n" +
        "  hookText        verbatim text on slide 1\n" +
        "  hookType        curiosity_gap | contrarian | list_promise | before_after | confession |\n" +
        "                  callout | stat_shock | pov | tutorial_promise | ranked_tier\n" +
        "  structure       listicle | story_arc | problem_solution | comparison | tier_ranking |\n" +
        "                  day_in_life | mistake_reveal | reference_sheet\n" +
        "  emotionalAngle  relief | validation | fomo | outrage | aspiration | guilt | nostalgia |\n" +
        "                  superiority | reassurance\n" +
        "  ctaStyle        none | save_prompt | soft_mention | product_last_slide | comment_bait |\n" +
        "                  follow_bait | link_in_bio   (save_prompt = the slide itself asks to be\n" +
        "                  saved or shared, drawn on rather than left to the caption)\n" +
        "  textDensity     minimal | medium | heavy\n" +
        "  reusableTemplate  slide-by-slide skeleton, topic stripped out so it can be refilled\n\n" +
        "THEN record what the format REQUIRES, as neutral fact:\n" +
        "  visualStyle     designed_graphic | text_over_photo | photo_only | screenshot | mixed\n" +
        "  assetsNeeded    design_tool | generic_imagery | specific_subject | creator_likeness |\n" +
        "                  screen_capture | video_frames   (array)\n" +
        "  requiresOwnLikeness, requiresSpecificSubject (booleans), productionNotes (one line)\n" +
        "Describe the inputs; never judge whether they are obtainable — the caller decides that, " +
        "and different callers have different constraints, budgets and tools. `generic_imagery` " +
        "covers stock and AI-generated alike; reserve `specific_subject` for a particular real " +
        "person, place or moment.\n\n" +
        "Pass your verdicts to save_analysis so no post is ever read twice. Slides are large: " +
        "do 3-5 posts per call, not 20. Slide URLs expire ~48h after harvest.",
      inputSchema: {
        awemeIds: z
          .array(z.string())
          .min(1)
          .max(6)
          .optional()
          .describe("Post ids from top_posts. Pass 3-5 at once rather than one call each"),
        awemeId: z.string().optional().describe("Alias for a single post id"),
        url: z.string().optional().describe("Alias: a full post URL, the id is taken from it"),
        urls: z.array(z.string()).optional().describe("Alias: several post URLs"),
        maxSlides: z.number().default(4).describe("Slides per post; 3-4 is enough to judge a format"),
        skipAnalyzed: z.boolean().default(true).describe("Skip posts already in the analyses table"),
      },
    },
    async ({ awemeIds, awemeId, url, urls, maxSlides, skipAnalyzed }) => {
      // top_posts hands back post URLs, so passing one straight back here is the obvious
      // move and the agent made it four times in one run. Take the id out of the URL.
      const fromUrls = [...(urls ?? []), ...(url ? [url] : [])]
        .map((u) => u.match(/\/(?:photo|video)\/(\d+)/)?.[1])
        .filter((x): x is string => Boolean(x));
      const ids = oneOrMany(
        [...(awemeIds ?? []), ...fromUrls].length ? [...(awemeIds ?? []), ...fromUrls] : undefined,
        awemeId,
        "awemeIds",
      );
      const done = skipAnalyzed ? alreadyAnalyzed(db, ids) : new Set<string>();
      const wanted = ids.filter((id) => !done.has(id));

      // Try the cheap path first, but don't hold the browser queue for it — only fall through
      // to a queued re-scan if something actually came back expired.
      let fetched = await fetchSlides(db, wanted, maxSlides);
      let rescanned: string[] = [];
      if (fetched.some((r) => r.error?.includes("expired"))) {
        const r = await withBrowser(async () => {
          const c = await browser();
          const out = await fetchSlidesWithRefresh(c, db, wanted, maxSlides, scanAccount, warmed);
          warmed = out.warmed;
          return out;
        });
        fetched = r.results;
        rescanned = r.rescanned;
      }

      const content: any[] = [];
      if (rescanned.length) {
        content.push({
          type: "text",
          text: `Re-scanned to refresh expired slide URLs: ${rescanned.join(", ")}`,
        });
      }
      if (done.size) {
        content.push({ type: "text", text: `Already analysed, skipped: ${[...done].join(", ")}` });
      }
      for (const p of fetched) {
        content.push({
          type: "text",
          text: p.error
            ? `--- ${p.awemeId} @${p.handle} — ERROR: ${p.error}`
            : `--- ${p.awemeId} @${p.handle} | ${p.views} views | ${p.followers ?? "?"} followers | ` +
              `${p.slideCount} slides (showing ${p.images.length})\nCaption: ${p.caption}`,
        });
        for (const img of p.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
      if (!content.length) content.push({ type: "text", text: "Nothing to read." });
      return { content };
    },
  );

  server.registerTool(
    "save_analysis",
    {
      title: "Persist your format verdicts",
      description:
        "Store what you concluded from read_slides so it is never re-read. Feeds format_rollup " +
        "and the producibleOnly filter on top_posts.",
      inputSchema: {
        analyses: z
          .array(AnalysisSchema.extend({ awemeId: z.string() }))
          .min(1)
          .optional()
          .describe("One entry per post you just read"),
        analysis: AnalysisSchema.extend({ awemeId: z.string() })
          .optional()
          .describe("Alias for a single entry"),
      },
    },
    async ({ analyses, analysis }) => {
      const list = analyses ?? (analysis ? [analysis] : []);
      if (!list.length)
        throw new Error("analyses is required: pass an array, or a single `analysis` object.");
      return json({ saved: saveAnalyses(db, list as any) });
    },
  );

  server.registerTool(
    "format_rollup",
    {
      title: "Which formats recur across UNRELATED accounts",
      description:
        "Aggregate the analysed posts by hook type and structure, counting DISTINCT ACCOUNTS " +
        "— only rows with more than one account are returned. One account doing something well " +
        "is a person, not a format; a format is a thing several unrelated accounts independently " +
        "converged on.\n\n" +
        "excludeAssets filters to formats that avoid inputs the caller can't or won't supply. " +
        "Also returns the visual-style mix and raw asset demand for the niche.",
      inputSchema: {
        excludeAssets: z
          .array(z.string())
          .default([])
          .describe(
            "Inputs the caller wants to avoid, e.g. ['creator_likeness']. Empty means no constraint.",
          ),
      },
    },
    async ({ excludeAssets }) => json(formatRollup(db, { excludeAssets, runId: currentRun(db) })),
  );

  server.registerTool(
    "download_post",
    {
      title: "Download slideshows as zips",
      description:
        "Every slide plus its data in one zip: the images, and a metadata.json with stats, " +
        "caption, sound, and the saved format analysis if there is one.\n\n" +
        "Give awemeIds for exact posts, or a handle to take that account's top posts sorted by " +
        "views, likes, engagement or saves. Slide URLs expire ~48h after harvest, so re-run " +
        "discover or scan_account first if a download reports expired.",
      inputSchema: {
        awemeIds: z.array(z.string()).max(10).default([]).describe("Exact posts to download"),
        handle: z.string().optional().describe("Or: an account, to take its top posts"),
        n: z.number().default(5).describe("How many, when using handle"),
        sortBy: z.enum(["views", "likes", "engagement", "saves"]).default("views"),
      },
    },
    async ({ awemeIds, handle, n, sortBy }) => {
      // zipPost/zipTopPosts self-heal expired slide URLs when given a browser; try without
      // one first (instant if everything's still live), and only queue a browser if needed.
      if (handle) {
        let out = await zipTopPosts(db, handle, { n, sortBy });
        if (out.zips?.some((z: any) => z.error?.includes("expired"))) {
          out = await withBrowser(async () => {
            const c = await browser();
            const r = await zipTopPosts(db, handle, { n, sortBy, refresh: { ctx: c, scanAccount, warmed } });
            warmed = true;
            return r;
          });
        }
        return json(out);
      }
      let out = [];
      for (const id of awemeIds) out.push(await zipPost(db, id));
      if (out.some((z) => z.error?.includes("expired"))) {
        out = await withBrowser(async () => {
          const c = await browser();
          const results = [];
          for (const id of awemeIds)
            results.push(await zipPost(db, id, { refresh: { ctx: c, scanAccount, warmed } }));
          warmed = true;
          return results;
        });
      }
      return json(out);
    },
  );

  server.registerTool(
    "evidence_pack",
    {
      title: "Everything the library knows, assembled for reasoning",
      description:
        "READ THIS BEFORE SCRAPING. Answers from the database only — no browsing, instant. " +
        "Returns the formats that recur across multiple UNRELATED accounts, the slide-by-slide " +
        "templates behind them, what inputs those formats need, and an honest coverage read.\n\n" +
        "This is the input to write_playbook. The workflow for any 'what should I post' question " +
        "is: evidence_pack first → if coverage.sufficient is false, run discover / read_slides to " +
        "fill the gap → then write_playbook. Do not scrape when the library can already answer.\n\n" +
        "coverage.notes says exactly what is missing. Report thin evidence as thin; a pattern seen " +
        "on one account is not a pattern.",
      inputSchema: {
        minAccounts: z
          .number()
          .default(2)
          .describe("Accounts a hook type needs before it counts as a pattern"),
        runId: z.string().optional().describe("Restrict to a specific run; defaults to the current run"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
      },
    },
    async ({ minAccounts, runId, allRuns }) =>
      json(
        evidencePack(db, {
          minAccounts,
          runId: allRuns ? undefined : (runId ?? currentRun(db) ?? undefined),
        }),
      ),
  );

  server.registerTool(
    "write_playbook",
    {
      title: "Save your adaptation of the evidence to a specific product",
      description:
        "The point of the whole tool. After evidence_pack, YOU decide what the caller should " +
        "make — this stores it, and the report leads with it.\n\n" +
        "For each pattern: name it, cite the evidence (how many unrelated accounts, what view " +
        "range), explain the mechanism, then ADAPT it to the caller's brief concretely — " +
        "slideSkeleton must already be rewritten in their subject matter, not the source's. " +
        "Generic advice is a failed playbook.\n\n" +
        "Set confidence honestly from the number of unrelated accounts behind it. Use `avoid` for " +
        "formats that perform but need inputs the caller lacks, and say why. Use `gaps` for what " +
        "the library still cannot answer. The caller decides what to act on; recommend, don't assume.\n\n" +
        "WRITE IT TO BE READ. verdict, whyItWorks and adaptation render blank lines as real " +
        "paragraphs, so break your writing up: one idea per paragraph, at most one statistic per " +
        "sentence, and the first line of `verdict` is the whole answer in one sentence before any " +
        "support. `evidence` is a readable sentence with the figures inline, not a stat dump. " +
        "A single dense paragraph carrying six numbers is the failure mode this field keeps hitting.",
      inputSchema: {
        ...PlaybookSchema.shape,
        runId: z.string().optional().describe("Run this answers; defaults to current"),
      },
    },
    async (pb: any) =>
      json({ id: savePlaybook(db, pb, pb.runId), saved: true, runId: pb.runId ?? currentRun(db) }),
  );

  server.registerTool(
    "search_library",
    {
      title: "Full-text search posts already collected",
      description:
        "Search captions/hashtags/handles already in the library. Call this BEFORE discover " +
        "when the user asks about a topic — re-scraping something we already have is wasted " +
        "time and unnecessary traffic.",
      inputSchema: {
        query: z.string(),
        limit: z.number().default(15),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
      },
    },
    async ({ query, limit, allRuns }) => {
      const rows = searchLibrary(db, query, limit, allRuns ? null : currentRun(db));
      return json({ matched: rows.length, rows });
    },
  );

  server.registerTool(
    "save_plan",
    {
      title: "Turn the playbook into a dated posting schedule",
      description:
        "The 'plan my next 30 days' answer. Call this AFTER write_playbook, once you know the " +
        "patterns and the cadence the winning accounts actually post at.\n\n" +
        "YOU choose what each post is about — which pattern, which topic, in what order. That " +
        "needs the research and nothing here has it. This assigns the dates, spreading posts " +
        "evenly through each week rather than stacking them, and keeps them from drifting or " +
        "double-booking a day.\n\n" +
        "WRITE EVERY SLIDE. `slides` is the post: each slide's finished on-screen text, plus an " +
        "imagePrompt they can paste straight into an image generator, described in the style " +
        "the winning posts actually used. A plan without slides is a calendar — it tells them " +
        "to post on Tuesday and leaves them to invent the post, which is the whole job. Add the " +
        "caption and the CTA too.\n\n" +
        "Give real topics from the caller's niche, not placeholders: 'why sit-ups are the worst " +
        "ab exercise', not 'contrarian post 1'. Set postsPerWeek (or postsPerDay, if they post " +
        "several times a day) from what the blueprint account does, and say plainly that most " +
        "posts land under the median.\n\n" +
        "EVERY ENTRY CITES ITS SOURCE. sourceAwemeIds are the posts you actually read the " +
        "slides of and modelled this one on; the call is refused if they were never analysed. " +
        "A plan is only worth more than the caller's own guesses if each post traces back to " +
        "something measured.\n\n" +
        "ASK BEFORE YOU PLAN. How many posts a week can they realistically make, do they have " +
        "a launch or seasonal date to work back from, and which topics does their product " +
        "already cover? A schedule built on a cadence they cannot keep is abandoned in week " +
        "two. If they would rather you just pick, use the blueprint account's cadence and say " +
        "that is what you did.",
      inputSchema: {
        entries: z.array(PlanEntrySchema).min(1).describe("One per post, in the order to post them"),
        startsOn: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
        postsPerWeek: z.number().default(5).describe("Match the blueprint account's real cadence"),
        postsPerDay: z
          .number()
          .optional()
          .describe("Use instead of postsPerWeek when they post several times a day"),
        playbookId: z.string().optional().describe("The playbook this came from"),
      },
    },
    async ({ entries, startsOn, postsPerWeek, postsPerDay, playbookId }) =>
      json(
        savePlan(db, {
          entries,
          startsOn,
          postsPerWeek,
          postsPerDay,
          playbookId,
          runId: currentRun(db),
        }),
      ),
  );

  server.registerTool(
    "get_plan",
    {
      title: "The posting schedule already written for this run",
      description:
        "Returns the latest dated plan for the current run, with each post's date, weekday, " +
        "pattern, topic and hook. Check here before writing a new one — if a plan already " +
        "exists the caller probably wants to see or adjust it, not silently replace it.",
      inputSchema: {},
    },
    async () => json(latestPlan(db, currentRun(db)) ?? { plan: null, note: "No plan yet for this run." }),
  );

  server.registerTool(
    "build_plan_doc",
    {
      title: "Write the plan out as a page they can produce from",
      description:
        "Turns the saved plan into a standalone HTML document: every week, every day, every " +
        "post, every slide's text and image prompt, the caption and the CTA, each post linked " +
        "back to the measured post it came from. Its own file, separate from the report — the " +
        "report argues the lane is worth entering, this is the production brief.\n\n" +
        "Call it after save_plan and tell the caller the path. If they asked for a content " +
        "plan or a calendar, this is the deliverable, not the JSON.",
      inputSchema: {
        out: z.string().optional().describe("Where to write it; defaults to the library"),
      },
    },
    async ({ out }) => json({ path: await buildPlanDoc(db, { out, runId: currentRun(db) }) }),
  );

  server.registerTool(
    "build_report",
    {
      title: "Generate the HTML report",
      description:
        "Writes a single self-contained HTML file of everything researched: the playbook if one " +
        "exists, the patterns behind it, the proof posts with their slides inlined as thumbnails, " +
        "the accounts, the shared sounds, and every search that built the library. Everything " +
        "links out to TikTok.\n\n" +
        "SCOPE IT TO A RUN. Defaults to the current run; pass allRuns only if the caller " +
        "explicitly wants their whole library in one file. Unscoped, a report argues about one " +
        "niche while showing evidence from another.\n\n" +
        "Tell the caller the path when it is done so they can open it. macOS only for now, " +
        "because thumbnails go through `sips` - on other platforms it still writes the file but " +
        "the slide images will be missing.",
      inputSchema: {
        posts: z.number().default(16).describe("How many posts in the proof section"),
        runId: z.string().optional().describe("Restrict to a specific run; defaults to the current run"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
        out: z
          .string()
          .optional()
          .describe(
            "Where to write it. Leave unset: the default names the file after the run it covers, so reports for different niches sit side by side instead of overwriting each other.",
          ),
      },
    },
    async ({ posts, runId, allRuns, out }) => {
      const scoped = allRuns ? null : (runId ?? currentRun(db));
      const path = await buildReport(db, { posts, out, runId: scoped });
      const run = scoped ? listRuns(db).find((r) => r.id === scoped) : null;
      return json({
        path,
        scopedTo: run ? { runId: run.id, label: run.label } : "whole library",
        note: `Report written to ${path}. Tell the caller to open it${
          run ? "" : " - note it covers every run in the library, not one question"
        }.`,
      });
    },
  );

  server.registerTool(
    "export_bundle",
    {
      title: "Export the plan as markdown plus images, zipped",
      description:
        "Writes the playbook as markdown with the slide images beside it and zips the folder. " +
        "Use when the caller wants the research out of the report and into Notion, a doc, or a " +
        "repo.\n\n" +
        "A plain .md cannot carry images: relative paths break when the file moves and base64 " +
        "data URIs are not rendered by most editors. A zip of markdown plus an images folder is " +
        "the shape Notion's Markdown import resolves, so that is what this produces. Returns the " +
        "path; the caller opens it themselves.",
      inputSchema: {
        posts: z.number().default(8).describe("Posts to include in the proof section"),
        runId: z.string().optional().describe("Scope to one research run; defaults to the current run"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Only set this when the user explicitly asks about their whole library or another niche by name. Never set it to widen a thin result — a run that looks thin IS the finding, and answering it with another niche's data is the leak this flag exists to make deliberate.",
          ),
        out: z.string().optional().describe("Where to write the zip"),
      },
    },
    async ({ posts, runId, allRuns, out }) =>
      json(
        await exportBundle(db, {
          posts,
          out,
          runId: allRuns ? null : (runId ?? currentRun(db)),
        }),
      ),
  );

  server.registerTool(
    "library_stats",
    {
      title: "Library totals and the niche go/no-go number",
      description:
        "START HERE for any 'is this niche worth it' question. Free, instant, opens no browser " +
        "— so run it immediately rather than offering to research and waiting for permission. " +
        "Answering a measurable question from general knowledge is the failure this server " +
        "exists to prevent.\n\n" +
        "Totals plus goNoGo: distinct accounts under 100k followers holding a 100k+ view " +
        "slideshow. That count is the decision, not total views — one account with 10M views " +
        "is a person, twenty accounts with 500k each is a niche. Read it as: <5 the lane isn't " +
        "there, 5-20 viable but thin, >20 a live lane.",
      inputSchema: {},
    },
    async () => {
      const one = (s: string) => (db.prepare(s).get() as any).n;
      return json({
        posts: one("SELECT COUNT(*) n FROM posts"),
        slideshows: one("SELECT COUNT(*) n FROM posts WHERE is_photo=1"),
        accounts: one("SELECT COUNT(*) n FROM accounts"),
        batches: one("SELECT COUNT(*) n FROM batches"),
        goNoGo: one(
          `SELECT COUNT(DISTINCT sec_uid) n FROM posts
           WHERE is_photo=1 AND play >= 100000 AND followers < 100000`,
        ),
      });
    },
  );
}

/**
 * Release Chrome and the database, then go.
 *
 * Guarded because several things can call it at once — a signal arriving while stdin is
 * closing, both stdin events firing for one disconnect — and closing a context twice throws.
 */
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await ctx?.close();
  } catch {}
  try {
    db.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (process.env.MCP_HTTP) {
  // Stateless mode: no session bookkeeping. This is a personal tool talking to a handful of
  // local clients, not a multi-tenant service — the shared db/ctx/browserQueue above are the
  // only state that matters, and those live at module scope regardless of transport.
  const port = Number(process.env.MCP_PORT ?? 8934);
  const httpServer = createHttpServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Binding to 127.0.0.1 does NOT make this unreachable from a web page. DNS rebinding
    // points an attacker's domain at 127.0.0.1, and the browser then treats requests to this
    // port as same-origin and sends them — CORS never comes into it. The Origin header still
    // carries the page's real origin, so checking it is what actually closes the hole, and
    // the MCP spec requires it for exactly this reason. A real MCP client is not a browser
    // and sends no Origin at all, which is why absent is allowed and mismatched is not.
    const origin = req.headers.origin;
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("forbidden origin");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end("invalid JSON");
      return;
    }
    // Fresh McpServer + transport per request. Server.connect() binds one transport to one
    // mutable field on the server object — sharing a single McpServer across concurrent
    // requests would let one request's transport clobber another's mid-flight. This is the
    // SDK's own documented pattern for stateless HTTP (examples/server/simpleStatelessStreamableHttp).
    // The state that actually matters — db, ctx, browserQueue — stays at module scope and is
    // shared across every request regardless; only the protocol-level wiring is per-request.
    const requestServer = new McpServer({ name: "swipekit", version: "0.2.0" });
    registerAllTools(requestServer);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      requestServer.close();
    });
    await requestServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  });
  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`swipekit MCP listening on http://127.0.0.1:${port}/mcp (bound to localhost only)`);
  });
  process.on("SIGINT", () => httpServer.close(() => shutdown()));
  process.on("SIGTERM", () => httpServer.close(() => shutdown()));
} else {
  const server = new McpServer({ name: "swipekit", version: "0.2.0" });
  registerAllTools(server);
  const transport = new StdioServerTransport();

  /**
   * Exit when the client goes away.
   *
   * A stdio server is spawned by its client and has no reason to outlive it, but nothing in
   * the SDK enforces that: StdioServerTransport binds `data` and `error` on stdin and never
   * `end` or `close`, so a client that dies without signalling us leaves this process alive
   * with a closed stdin, holding a database handle and possibly a Chrome, forever. Over a
   * week and a half of ordinary use that came to 44 idle servers on one machine. Watching
   * stdin directly is the fix — EOF there is the client hanging up, and it is the one signal
   * that always arrives.
   */
  transport.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  await server.connect(transport);
}
