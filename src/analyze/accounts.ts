import type { DatabaseSync } from "node:sqlite";
import { median } from "./metrics.ts";
import { runScope } from "../store/runs.ts";

const DAY = 86_400_000;

/**
 * Account-shaped rows — the thing an agent needs to write a comparison table.
 *
 * The headline number is views in a rolling window, not lifetime totals: "3M views in the
 * last 30 days" is what tells you an account is hot right now, and it's how people actually
 * phrase the filter. Everything here is computed from posts already in the library.
 */
export type AccountRow = {
  handle: string;
  url: string;
  followers: number | null;

  /** Rolling window, the headline. */
  views30d: number;
  posts30d: number;
  avgViews30d: number;
  postsPerWeek: number;

  slideshowPct: number;
  slidesPerPost: number | null;

  /** best ÷ median views. High = one lucky hit; near 1 = a steady machine. */
  spike: number | null;
  medianViews: number;
  bestViews: number;
  bestPostUrl: string | null;
  vpf: number | null;

  bangers: number;
  repeatable: boolean;
  daysSinceLastPost: number | null;

  postsCollected: number;
  /**
   * views30d / postsPerWeek only mean anything once we hold a real slice of the account.
   * From a search batch we usually have one or two posts, which makes cadence read as ~0.
   */
  reliable: boolean;
  /**
   * False when the oldest post we hold is newer than the window — the account posts faster
   * than we scanned, so views30d is a floor, not a total. Say so rather than quoting it flat.
   */
  windowCovered: boolean;
};

export type AccountFilters = {
  minViews30d?: number;
  minFollowers?: number;
  maxFollowers?: number;
  minSlideshowPct?: number;
  minPostsPerWeek?: number;
  requireRepeatable?: boolean;
  windowDays?: number;
  limit?: number;
  sortBy?: AccountSort;
  runId?: string | null;
};

export type AccountSort =
  | "auto"
  | "views30d"
  | "bestViews"
  | "medianViews"
  | "vpf"
  | "spike"
  | "followers"
  | "postsPerWeek";

/**
 * Rank on the window only when MOST of these accounts actually posted in it.
 *
 * Search-led discovery is why this is needed. TikTok search returns what performed, not what
 * is recent, so a fresh library is mostly evergreen posts and views30d is 0 for nearly
 * everyone. Every one of those ties at zero, and the ordering among them is then an accident
 * of which few posts happened to be new — measured on a real run, that pushed an account with
 * a 257k median below one with 564 views.
 *
 * A simple majority is the bar because anything lower still lets a mostly-tied column decide
 * the table. At exactly half, half the rows are still zeroes, so fall back.
 */
const WINDOW_COVERAGE_FLOOR = 0.5;

/** Fraction of rows that have any post inside the window at all. */
export const windowCoverage = (rows: AccountRow[]) =>
  rows.length ? rows.filter((r) => r.posts30d > 0).length / rows.length : 0;

/**
 * What to actually sort on. An explicit choice always wins; "auto" falls back to lifetime
 * best when the window is too empty to mean anything, so the ordering degrades visibly
 * rather than silently.
 */
export function rankingBasis(rows: AccountRow[], requested?: AccountSort): AccountSort {
  if (requested && requested !== "auto") return requested;
  return windowCoverage(rows) > WINDOW_COVERAGE_FLOOR ? "views30d" : "bestViews";
}

export function accountRows(db: DatabaseSync, f: AccountFilters = {}): AccountRow[] {
  // This is a slideshow tool, so accounts that barely post slideshows are noise by default.
  // Overridable — pass 0 to see everything.
  const minSlideshowPct = f.minSlideshowPct ?? 0.5;
  const windowDays = f.windowDays ?? 30;
  const cutoff = Date.now() - windowDays * DAY;
  const limit = f.limit ?? 10;

  const scope = runScope(f.runId);
  const accounts = db
    .prepare(
      `SELECT a.sec_uid, a.unique_id, a.followers, COUNT(p.aweme_id) collected
       FROM accounts a JOIN posts p ON p.sec_uid = a.sec_uid
       WHERE 1=1 ${scope.sql}
       GROUP BY a.sec_uid HAVING collected >= 2`,
    )
    .all(...scope.params) as any[];

  const rows: AccountRow[] = [];

  for (const a of accounts) {
    const posts = db
      .prepare(
        `SELECT aweme_id, play, is_photo, slide_count, posted_at, followers
         FROM posts WHERE sec_uid = ? AND posted_at > 0 ORDER BY posted_at DESC`,
      )
      .all(a.sec_uid) as any[];
    if (!posts.length) continue;

    const inWindow = posts.filter((p) => p.posted_at >= cutoff);
    const views30d = inWindow.reduce((s, p) => s + (p.play || 0), 0);
    const photos = posts.filter((p) => p.is_photo);
    const plays = posts.map((p) => p.play).filter((x) => x > 0);
    const med = median(plays);
    const best = posts.reduce((m, p) => (p.play > (m?.play ?? -1) ? p : m), null as any);
    const followers = a.followers ?? posts.find((p) => p.followers)?.followers ?? null;

    // Same bar as scan.ts: meaningfully above the account's own baseline, and non-trivial
    // in absolute terms.
    const bangerBar = Math.max(50_000, med * 3);
    const bangerTimes = posts.filter((p) => p.play >= bangerBar).map((p) => p.posted_at);
    const repeatable = bangerTimes.length >= 3 && bangerTimes.some((t) => Date.now() - t < 90 * DAY);

    const oldest = posts[posts.length - 1].posted_at;

    rows.push({
      handle: a.unique_id,
      url: `https://www.tiktok.com/@${a.unique_id}`,
      followers,
      views30d,
      posts30d: inWindow.length,
      avgViews30d: inWindow.length ? Math.round(views30d / inWindow.length) : 0,
      postsPerWeek: +(inWindow.length / (windowDays / 7)).toFixed(1),
      slideshowPct: posts.length ? +(photos.length / posts.length).toFixed(2) : 0,
      slidesPerPost: photos.length
        ? +(photos.reduce((s, p) => s + (p.slide_count || 0), 0) / photos.length).toFixed(1)
        : null,
      spike: med ? +((best?.play ?? 0) / med).toFixed(1) : null,
      medianViews: Math.round(med),
      bestViews: best?.play ?? 0,
      bestPostUrl: best ? `https://www.tiktok.com/@${a.unique_id}/photo/${best.aweme_id}` : null,
      vpf: followers && med ? +(med / followers).toFixed(1) : null,
      bangers: bangerTimes.length,
      repeatable,
      daysSinceLastPost: Math.floor((Date.now() - posts[0].posted_at) / DAY),
      postsCollected: posts.length,
      reliable: posts.length >= 8 && oldest <= cutoff,
      windowCovered: oldest <= cutoff,
    });
  }

  const keep = rows.filter(
    (r) =>
      (f.minViews30d == null || r.views30d >= f.minViews30d) &&
      (f.minFollowers == null || (r.followers ?? 0) >= f.minFollowers) &&
      (f.maxFollowers == null || (r.followers ?? Infinity) <= f.maxFollowers) &&
      r.slideshowPct >= minSlideshowPct &&
      (f.minPostsPerWeek == null || r.postsPerWeek >= f.minPostsPerWeek) &&
      (!f.requireRepeatable || r.repeatable),
  );

  const basis = rankingBasis(keep, f.sortBy);
  const key = (r: AccountRow) =>
    basis === "vpf"
      ? (r.vpf ?? -1)
      : basis === "spike"
        ? (r.spike ?? -1)
        : basis === "followers"
          ? (r.followers ?? -1)
          : basis === "postsPerWeek"
            ? r.postsPerWeek
            : basis === "bestViews"
              ? r.bestViews
              : basis === "medianViews"
                ? r.medianViews
                : r.views30d;

  return keep.sort((a, b) => key(b) - key(a)).slice(0, limit);
}

/**
 * find_accounts, with the reasoning the caller needs attached.
 *
 * accountRows stays an array because plenty of callers just want rows. This adds what the
 * agent has to be told: what the ordering was actually based on, and — when nothing came
 * back — whether that is because the library is empty or because a filter did it. Those
 * need different advice, and telling someone to "run discover first" when they just did is
 * the unhelpful version.
 */
export function findAccounts(db: DatabaseSync, f: AccountFilters = {}) {
  const rows = accountRows(db, f);
  if (rows.length) {
    return {
      rows,
      needsScan: needsScan(rows),
      sortedBy: rankingBasis(rows, f.sortBy),
      windowEmpty: windowCoverage(rows) <= WINDOW_COVERAGE_FLOOR,
      emptyBecause: null,
      candidates: rows.length,
    };
  }

  // Nothing matched. Re-ask without the caller's filters to tell "we hold nothing" apart
  // from "your filters excluded everything we hold".
  const candidates = accountRows(db, {
    runId: f.runId,
    minSlideshowPct: f.minSlideshowPct,
    windowDays: f.windowDays,
    limit: 500,
  });
  const windowEmpty = windowCoverage(candidates) <= WINDOW_COVERAGE_FLOOR;
  return {
    rows,
    needsScan: [],
    sortedBy: null,
    windowEmpty,
    emptyBecause: !candidates.length
      ? ("no-accounts" as const)
      : f.minViews30d != null && windowEmpty
        ? ("window-filter" as const)
        : ("filters" as const),
    candidates: candidates.length,
  };
}

/**
 * Accounts that need a scan_account before their window numbers can be trusted. Takes the
 * rows actually being shown, so it names the ones in front of the user rather than a generic
 * backlog.
 */
export function needsScan(rows: AccountRow[]): string[] {
  return rows.filter((r) => !r.reliable).map((r) => r.handle);
}
