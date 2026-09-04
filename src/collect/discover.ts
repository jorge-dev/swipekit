import type { BrowserContext } from "playwright-core";
import type { DatabaseSync } from "node:sqlite";
import { harvest } from "./harvest.ts";
import { recordBatch, upsertPost } from "../store/db.ts";
import { runScope } from "../store/runs.ts";
import {
  commentRatio,
  median,
  outlierScores,
  saveRatio,
  summarize,
  vpf,
  type PostRow,
  type Summary,
} from "../analyze/metrics.ts";
import { settle, warmup } from "./session.ts";

const slug = () => Math.random().toString(36).slice(2, 8);

const DAY = 86_400_000;

/**
 * Have we already answered this query recently? Browsing is slow, rate-limited and burns
 * tokens on results we already hold, so the default is to reuse.
 */
export function cachedBatch(
  db: DatabaseSync,
  kind: string,
  query: string,
  maxAgeDays: number,
): { id: string; ran_at: number; scanned: number; slideshows: number } | null {
  return (
    (db
      .prepare(
        `SELECT id, ran_at, scanned, slideshows FROM batches
         WHERE kind = ? AND query = ? AND ran_at > ?
         ORDER BY ran_at DESC LIMIT 1`,
      )
      .get(kind, query, Date.now() - maxAgeDays * DAY) as any) ?? null
  );
}

/**
 * Search-led discovery.
 *
 * Phase 0 measured hashtag feeds at 0% photoShare (0/59 on #toddlermom) against 8% for
 * search (4/52) — TikTok's challenge feed returns a video-skewed slice. Search is the
 * slideshow surface; hashtags are for expanding from an account you already found.
 */
export async function discover(
  ctx: BrowserContext,
  db: DatabaseSync,
  opts: {
    queries: string[];
    target?: number;
    warmed?: boolean;
    /** Reuse a batch for the same query newer than this. 0 forces a fresh pull. */
    maxAgeDays?: number;
    filters?: { maxFollowers?: number; minVPF?: number };
  },
): Promise<(Summary & { cached?: boolean; ranDaysAgo?: number })[]> {
  const target = opts.target ?? 120;
  const maxAgeDays = opts.maxAgeDays ?? 7;

  // Answer from the library wherever we can, and only open a browser if something is
  // actually missing.
  const plan = opts.queries.map((q) => ({
    q,
    hit: maxAgeDays > 0 ? cachedBatch(db, "search", q, maxAgeDays) : null,
  }));
  const summaries: (Summary & { cached?: boolean; ranDaysAgo?: number })[] = [];
  const toFetch = plan.filter((p) => !p.hit);

  for (const { q, hit } of plan) {
    if (!hit) continue;
    summaries.push({
      ...summarize(db, hit.id, q, opts.filters),
      cached: true,
      ranDaysAgo: Math.floor((Date.now() - hit.ran_at) / DAY),
    });
  }
  if (!toFetch.length) return summaries;

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!opts.warmed) await warmup(page);

  for (const [i, { q }] of toFetch.entries()) {
    const batchId = `b_${slug()}`;
    const url = `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`;

    const { items } = await harvest(page, url, { target });

    let slideshows = 0;
    for (const item of items) if (upsertPost(db, item, batchId)) slideshows++;
    recordBatch(db, { id: batchId, kind: "search", query: q, scanned: items.length, slideshows });

    summaries.push({ ...summarize(db, batchId, q, opts.filters), cached: false });

    // pacing between surfaces, not just between scrolls
    if (i < toFetch.length - 1) await settle(page, 4000, 11000);
  }

  return summaries;
}

export type TopRow = {
  id: string;
  handle: string;
  followers: number | null;
  views: number;
  vpf: number | null;
  saveRatio: number;
  commentRatio: number;
  outlier: number | null;
  /**
   * What the outlier was measured against. "account" is the real thing — this post versus
   * its own account's median, which is what proves the FORMAT won. "niche" means we hold too
   * few posts from that account to have a median, so it is measured against the run's own
   * posts instead: still useful for ranking, but it says the post beat the niche rather than
   * its author. Say which when you quote it, and scan_account to upgrade it.
   */
  outlierBasis: "account" | "niche" | null;
  ageDays: number | null;
  slides: number;
  soundId: string | null;
  url: string;
  hook: string;
};

/** Compact rows only — never the raw post objects. */
export function topPosts(
  db: DatabaseSync,
  opts: {
    batchId?: string;
    sortBy?: "outlier" | "vpf" | "views" | "saves" | "comments";
    limit?: number;
    maxFollowers?: number;
    minViews?: number;
    maxAgeDays?: number;
    excludeAssets?: string[];
    photoOnly?: boolean;
    runId?: string | null;
  } = {},
): TopRow[] {
  // A views floor is load-bearing: without it an 83-follower account with 10k views
  // scores vpf 123 and outranks everything. High VPF on tiny absolute reach is noise,
  // not a format that works.
  const {
    batchId,
    sortBy = "vpf",
    limit = 12,
    maxFollowers,
    minViews = 50_000,
    maxAgeDays = 180,
    excludeAssets = [],
    photoOnly = true,
    runId = null,
  } = opts;

  const where: string[] = [];
  const params: any[] = [];
  if (photoOnly) where.push("p.is_photo = 1");
  if (maxFollowers) {
    where.push("p.followers <= ?");
    params.push(maxFollowers);
  }
  if (minViews) {
    where.push("p.play >= ?");
    params.push(minViews);
  }
  // Recency is a first-order signal — a format that worked two years ago may be dead.
  if (maxAgeDays) {
    where.push("p.posted_at > ?");
    params.push(Date.now() - maxAgeDays * 86_400_000);
  }

  // Asset requirements live in analyses, so only analysed posts can be filtered on them.
  // The caller states its own constraints; the tool never assumes them.
  const join = excludeAssets.length
    ? `JOIN analyses an ON an.aweme_id = p.aweme_id AND ` +
      excludeAssets.map(() => "an.assets_needed NOT LIKE ?").join(" AND ")
    : "";
  const joinParams = excludeAssets.map((a) => `%"${a}"%`);

  // Scope to one research question unless the caller explicitly asked for everything.
  // An unscoped ranking mixes niches, which is how a report ends up arguing about one
  // subject while showing evidence from another.
  const scope = runScope(runId);

  // Params are assembled in the order their placeholders appear in the SQL: the JOIN
  // comes before the WHERE, so joinParams lead. Getting this backwards silently ranks
  // the wrong rows rather than erroring.
  const sql = batchId
    ? `SELECT p.* FROM posts p JOIN batch_posts b ON b.aweme_id = p.aweme_id ${join}
       WHERE b.batch_id = ? ${where.length ? `AND ${where.join(" AND ")}` : ""}${scope.sql}`
    : `SELECT p.* FROM posts p ${join}
       WHERE 1=1 ${where.length ? `AND ${where.join(" AND ")}` : ""}${scope.sql}`;

  const bound = batchId
    ? [...joinParams, batchId, ...params, ...scope.params]
    : [...joinParams, ...params, ...scope.params];

  const rows = db.prepare(sql).all(...bound) as any[];
  const outliers = outlierScores(db);

  /**
   * Fallback baseline for posts whose account we hold too little of.
   *
   * After a search-led discover that is nearly every post, and leaving them null meant
   * sortBy:"outlier" — the ranking AGENTS.md says to always prefer — silently sank them
   * below the handful of scanned accounts. Measuring against the median of the candidate
   * set keeps them on the same scale and rankable; outlierBasis says which it is, so the
   * weaker measurement is visible instead of passing as the real one.
   */
  const nicheMedian = median(rows.map((r) => r.play).filter((p: number) => p > 0));

  const scored = rows.map((r: PostRow & { slide_urls: string }) => {
    const own = outliers.get(r.aweme_id);
    const basis: TopRow["outlierBasis"] =
      own != null ? "account" : nicheMedian > 0 && r.play > 0 ? "niche" : null;
    const score = own ?? (basis === "niche" ? r.play / nicheMedian : null);
    return {
      id: r.aweme_id,
      handle: r.unique_id,
      followers: r.followers,
      views: r.play,
      vpf: vpf(r) === null ? null : +vpf(r)!.toFixed(1),
      saveRatio: +saveRatio(r).toFixed(4),
      commentRatio: +commentRatio(r).toFixed(4),
      outlier: score == null ? null : +score.toFixed(1),
      outlierBasis: basis,
      ageDays: r.posted_at ? Math.floor((Date.now() - r.posted_at) / 86_400_000) : null,
      slides: r.slide_count,
      soundId: r.sound_id,
      url: `https://www.tiktok.com/@${r.unique_id}/photo/${r.aweme_id}`,
      hook: (r.caption ?? "").split("#")[0].trim().slice(0, 90),
    };
  });

  const key = (t: TopRow) =>
    sortBy === "comments"
      ? t.commentRatio
      : sortBy === "outlier"
        ? (t.outlier ?? -1)
        : sortBy === "views"
          ? t.views
          : sortBy === "saves"
            ? t.saveRatio
            : (t.vpf ?? -1);

  return scored.sort((a, b) => key(b) - key(a)).slice(0, limit);
}
