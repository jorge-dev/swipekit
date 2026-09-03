import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * A production-ready content plan built from a playbook.
 *
 * A schedule saying "post something on Tuesday" is not a plan — the person still has to
 * invent every slide. So an entry carries the finished post: each slide's on-screen text,
 * an image prompt they can paste into a generator, the caption, and the CTA. What they
 * open on Monday should be buildable without further thinking.
 *
 * The agent writes all of that, because it needs the research and nothing here has it.
 * This owns the arithmetic that is easy to get subtly wrong by hand: spreading posts
 * across real dates at a real cadence without drifting or losing one.
 */

export const PLAN_DDL = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, run_id TEXT, playbook_id TEXT,
  starts_on TEXT, posts_per_week REAL, entries TEXT, created_at INTEGER
);`;

export const SlideSpecSchema = z.object({
  text: z.string().describe("The words that go ON this slide, written out, not described"),
  imagePrompt: z
    .string()
    .optional()
    .describe(
      "A prompt they can paste into an image generator for this slide's background or " +
        "illustration. Describe the style the winning posts actually used",
    ),
  note: z.string().optional().describe("Layout or production note for this slide only"),
});
export type SlideSpec = z.infer<typeof SlideSpecSchema>;

export const PlanEntrySchema = z.object({
  pattern: z.string().describe("Which named pattern from the playbook this post uses"),
  topic: z.string().describe("The specific subject, in the caller's niche, not a placeholder"),
  slides: z
    .array(SlideSpecSchema)
    .min(1)
    .describe(
      "Every slide, in order, with its finished on-screen text. This is the post — without " +
        "it they still have to invent the whole thing",
    ),
  caption: z.string().optional().describe("The caption to post with it, hashtags included"),
  cta: z.string().optional().describe("What the final slide asks them to do"),
  note: z.string().optional().describe("Anything they need to prepare for this one"),
  sourceAwemeIds: z
    .array(z.string())
    .min(1)
    .describe("Post ids this is modelled on. They must be posts whose slides were actually read"),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export type ScheduledEntry = PlanEntry & {
  date: string;
  weekday: string;
  week: number;
  /** 1-based across the whole plan, so "day 12" in the prose matches the document. */
  day: number;
};

/** A cited post, resolved to something a reader can actually click. */
export type PlanSource = { awemeId: string; handle: string | null; url: string };
export type ReadEntry = ScheduledEntry & { sources: PlanSource[] };

const DAY = 86_400_000;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Spread entries across real dates at the requested cadence.
 *
 * Posting days are spaced evenly through each week rather than stacked at the start, since
 * the accounts that win here post steadily. Fractional cadences work: 2.5/week alternates
 * 3 and 2 without accumulating drift, because each post's offset is computed from the start
 * date rather than added to a running total.
 */
export function schedule(
  entries: PlanEntry[],
  opts: { startsOn?: string; postsPerWeek?: number; postsPerDay?: number } = {},
): ScheduledEntry[] {
  const start = opts.startsOn ? new Date(`${opts.startsOn}T12:00:00`) : new Date();
  if (Number.isNaN(start.getTime())) throw new Error(`startsOn is not a date: ${opts.startsOn}`);

  const at = (offset: number, e: PlanEntry): ScheduledEntry => {
    const d = new Date(start.getTime() + offset * DAY);
    return {
      ...e,
      date: d.toISOString().slice(0, 10),
      weekday: WEEKDAY[d.getDay()]!,
      week: Math.floor(offset / 7) + 1,
      day: offset + 1,
    };
  };

  // Posting several times a day is a real strategy in this niche, so it gets its own
  // path rather than being faked with a fractional weekly cadence.
  if (opts.postsPerDay && opts.postsPerDay > 0) {
    const perDay = Math.floor(opts.postsPerDay);
    return entries.map((e, i) => at(Math.floor(i / perDay), e));
  }

  const postsPerWeek = opts.postsPerWeek && opts.postsPerWeek > 0 ? opts.postsPerWeek : 5;
  const gap = 7 / postsPerWeek;
  // Offset from the start every time, so rounding never compounds across a long plan.
  return entries.map((e, i) => at(Math.round(i * gap), e));
}

export function savePlan(
  db: DatabaseSync,
  opts: {
    entries: PlanEntry[];
    runId?: string | null;
    playbookId?: string | null;
    startsOn?: string;
    postsPerWeek?: number;
    postsPerDay?: number;
  },
): { id: string; scheduled: ScheduledEntry[] } {
  db.exec(PLAN_DDL);
  if (!opts.entries.length) throw new Error("A plan needs at least one entry.");

  // Every planned post has to point at a post someone actually read the slides of.
  // Without this the plan is a list of plausible-sounding topics, indistinguishable from
  // invention once it is saved and rendered as a deliverable — and by then nothing
  // downstream can tell the difference. Same reasoning as savePlaybook's analyses guard.
  const cited = [...new Set(opts.entries.flatMap((e) => e.sourceAwemeIds ?? []))];
  if (!cited.length) {
    throw new Error(
      "Every plan entry needs sourceAwemeIds: the posts it is modelled on.\n\n" +
        "A plan that cites nothing is a list of guesses. Read the winning posts with " +
        "read_slides, save what you found with save_analysis, then plan from those.",
    );
  }
  const known = new Set(
    (
      db
        .prepare(
          `SELECT a.aweme_id id FROM analyses a WHERE a.aweme_id IN (${cited.map(() => "?").join(",")})`,
        )
        .all(...cited) as any[]
    ).map((r) => r.id),
  );
  const unread = cited.filter((id) => !known.has(id));
  if (unread.length) {
    throw new Error(
      `These posts have not been read slide by slide, so nothing can be modelled on them yet: ${unread.join(", ")}.\n\n` +
        "Call read_slides on them and save_analysis with what you find, then plan again.",
    );
  }
  const scheduled = schedule(opts.entries, opts);
  const id = `plan_${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO plans VALUES (?,?,?,?,?,?,?)`).run(
    id,
    opts.runId ?? null,
    opts.playbookId ?? null,
    scheduled[0]!.date,
    opts.postsPerWeek ?? 5,
    JSON.stringify(scheduled),
    Date.now(),
  );
  return { id, scheduled };
}

export function latestPlan(db: DatabaseSync, runId?: string | null) {
  db.exec(PLAN_DDL);
  // Scoped by run_id directly: runScope filters on p.aweme_id, which plans have no column for.
  const row = (
    runId
      ? db.prepare(`SELECT * FROM plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId)
      : db.prepare(`SELECT * FROM plans ORDER BY created_at DESC LIMIT 1`).get()
  ) as any;
  if (!row) return null;
  const entries = JSON.parse(row.entries) as ScheduledEntry[];

  // Handles are resolved here rather than stored with the plan: an account can rename
  // itself, and the post id is the thing that stays true. A link built from a stale
  // stored handle would rot silently.
  const ids = [...new Set(entries.flatMap((e) => e.sourceAwemeIds ?? []))];
  const handles = new Map<string, string | null>(
    ids.length
      ? (
          db
            .prepare(
              `SELECT aweme_id, unique_id FROM posts WHERE aweme_id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(...ids) as any[]
        ).map((r) => [r.aweme_id as string, (r.unique_id as string) ?? null])
      : [],
  );

  return {
    id: row.id,
    runId: row.run_id,
    startsOn: row.starts_on,
    postsPerWeek: row.posts_per_week,
    entries: entries.map((e) => ({
      ...e,
      sources: (e.sourceAwemeIds ?? []).map((awemeId) => {
        const handle = handles.get(awemeId) ?? null;
        return {
          awemeId,
          handle,
          url: `https://www.tiktok.com/@${handle ?? "_"}/photo/${awemeId}`,
        };
      }),
    })) as ReadEntry[],
  };
}
