import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { runScope } from "../store/runs.ts";

/**
 * Host-agnostic by construction: nothing here calls a vendor API. The agent driving the
 * MCP tools does the reading, whichever client that is — Claude Code, Codex, Cursor,
 * Claude Desktop. read_slides hands over pixels; save_analysis stores the verdict.
 *
 * Closed taxonomy, deliberately. Prose doesn't aggregate — enums let us later ask
 * "which hook type has the highest median outlier score in the library?", which is the
 * question the whole tool exists to answer.
 */
export const AnalysisSchema = z.object({
  hookText: z.string().describe("Verbatim text on slide 1"),
  hookType: z.enum([
    "curiosity_gap",
    "contrarian",
    "list_promise",
    "before_after",
    "confession",
    "callout",
    "stat_shock",
    "pov",
    "tutorial_promise",
    "ranked_tier",
  ]),
  structure: z.enum([
    "listicle",
    "story_arc",
    "problem_solution",
    "comparison",
    "tier_ranking",
    "day_in_life",
    "mistake_reveal",
    "reference_sheet",
  ]),
  emotionalAngle: z.enum([
    "relief",
    "validation",
    "fomo",
    "outrage",
    "aspiration",
    "guilt",
    "nostalgia",
    "superiority",
    "reassurance",
  ]),
  ctaStyle: z
    .enum([
      "none",
      "save_prompt",
      "soft_mention",
      "product_last_slide",
      "comment_bait",
      "follow_bait",
      "link_in_bio",
    ])
    .describe(
      "save_prompt = the slide itself asks to be saved or shared, drawn on as an affordance " +
        "rather than left to the caption. Worth its own value because saves are the win " +
        "condition for a utility product, and the posts that ask on-slide measurably out-save " +
        "the ones that don't.",
    ),

  // --- production requirements: DESCRIBE what the format needs, never judge who can make it.
  // Whoever is asking decides what they can supply; the tool only reports the inputs.
  visualStyle: z
    .enum(["designed_graphic", "text_over_photo", "photo_only", "screenshot", "mixed"])
    .describe(
      "designed_graphic = laid out in a design tool. text_over_photo = photographic background " +
        "with type on top. photo_only = photography carries it. mixed = varies across slides.",
    ),
  assetsNeeded: z
    .array(
      z.enum([
        "design_tool", // layout, type, shapes
        "generic_imagery", // stock or AI-generated — anything not tied to a specific real subject
        "specific_subject", // a particular real person, place, product or moment, photographed
        "creator_likeness", // the poster's own face or body
        "screen_capture", // app screenshots, chats, dashboards
        "video_frames", // stills pulled from footage
      ]),
    )
    .describe("Every input the format needs. Callers filter on this; do not judge feasibility."),
  requiresOwnLikeness: z.boolean().describe("Does it need the poster's own face or body?"),
  requiresSpecificSubject: z
    .boolean()
    .describe("Does it need a particular real person/place/thing, as opposed to any suitable image?"),
  productionNotes: z.string().describe("One line describing what it takes to make, neutrally"),

  textDensity: z.enum(["minimal", "medium", "heavy"]),
  reusableTemplate: z.array(z.string()).describe("Slide-by-slide skeleton, topic removed"),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

export const ANALYSIS_DDL = `
CREATE TABLE IF NOT EXISTS analyses (
  aweme_id TEXT PRIMARY KEY,
  hook_text TEXT, hook_type TEXT, structure TEXT, emotional_angle TEXT, cta_style TEXT,
  visual_style TEXT, requires_own_likeness INTEGER, requires_specific_subject INTEGER,
  assets_needed TEXT, production_notes TEXT,
  text_density TEXT, template TEXT, model TEXT, analyzed_at INTEGER
);`;

/**
 * Which formats actually recur — across UNRELATED accounts.
 * One account doing something well is a person, not a format.
 */
/**
 * `excludeAssets` lets the caller express their own constraints ("I have no camera", "I
 * won't use my own face") without the tool ever assuming them.
 */
export function formatRollup(
  db: DatabaseSync,
  opts: { excludeAssets?: string[]; runId?: string | null } = {},
) {
  db.exec(ANALYSIS_DDL);
  const ex = opts.excludeAssets ?? [];
  const scope = runScope(opts.runId);
  // WHERE 1=1 so the asset filter and the run scope can both append without either
  // needing to know whether it is first.
  const where = `WHERE 1=1 ${ex.map(() => "AND a.assets_needed NOT LIKE ?").join(" ")}${scope.sql}`;
  const params = [...ex.map((a) => `%"${a}"%`), ...scope.params];
  return {
    byHookType: db
      .prepare(
        `SELECT a.hook_type hook_type, COUNT(*) posts, COUNT(DISTINCT p.sec_uid) accounts,
              CAST(AVG(p.play) AS INT) avg_views
       FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id ${where}
       GROUP BY a.hook_type HAVING accounts > 1 ORDER BY accounts DESC, avg_views DESC`,
      )
      .all(...params),
    byStructure: db
      .prepare(
        `SELECT a.structure structure, COUNT(*) posts, COUNT(DISTINCT p.sec_uid) accounts
       FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id ${where}
       GROUP BY a.structure HAVING accounts > 1 ORDER BY accounts DESC`,
      )
      .all(...params),
    visualStyles: db
      .prepare(
        `SELECT a.visual_style visual_style, COUNT(*) n
         FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id
         WHERE 1=1 ${scope.sql}
         GROUP BY a.visual_style ORDER BY n DESC`,
      )
      .all(...scope.params),
    // Counted per asset, not per post. The column holds a JSON array, so returning the rows
    // raw handed the caller ["generic_imagery"] three times over and left them to tally it.
    // What the question actually is — "how many of these formats need a camera?" — is this.
    assetDemand: countAssets(
      db
        .prepare(
          `SELECT a.assets_needed assets_needed
           FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id
           WHERE a.assets_needed IS NOT NULL ${scope.sql}`,
        )
        .all(...scope.params) as { assets_needed: string }[],
    ),
  };
}

function countAssets(rows: { assets_needed: string }[]) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.assets_needed);
    } catch {
      continue; // a malformed row should not take the whole rollup down
    }
    if (!Array.isArray(parsed)) continue;
    for (const a of parsed) {
      if (typeof a === "string") counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([asset, posts]) => ({ asset, posts })).sort((a, b) => b.posts - a.posts);
}
