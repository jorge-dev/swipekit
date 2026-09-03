import type { BrowserContext } from "playwright";
import type { DatabaseSync } from "node:sqlite";
import { harvest } from "./harvest.ts";
import { recordBatch, upsertPost } from "../store/db.ts";
import { median, saveRatio, type PostRow } from "../analyze/metrics.ts";
import { settle, warmup } from "./session.ts";

const DAY = 86_400_000;

export type AccountReport = {
  handle: string;
  followers: number | null;
  postsScanned: number;
  slideshows: number;
  photoShare: number;

  /** The gate that matters: several consistent bangers, not one lucky hit. */
  bangers: number;
  bangerRate: number;
  repeatable: boolean;

  medianViews: number;
  medianVPF: number | null;
  medianSaveRatio: number;
  medianCommentRatio: number;

  postsLast30d: number;
  daysSinceLastPost: number | null;
  cadencePerWeek: number;
  consistency: number;

  topSounds: { soundId: string; posts: number }[];
  modalSlideCount: number | null;
  verdict: string;
};

/**
 * Scan one account's posts and decide whether its format is repeatable.
 *
 * The rule this encodes (from how practitioners actually do this manually): never copy a
 * format off a profile with a single viral hit — that was luck. An account earns "repeatable"
 * only by clearing the banger bar several times.
 */
/**
 * Derived from the function itself so callers that take it as a parameter can never
 * drift from the real signature. `zipPost` passing the wrong arity was a silent `as any`
 * before this existed.
 */
export type ScanAccountFn = typeof scanAccount;

export async function scanAccount(
  ctx: BrowserContext,
  db: DatabaseSync,
  handle: string,
  opts: { target?: number; warmed?: boolean; maxAgeDays?: number } = {},
): Promise<AccountReport & { cached?: boolean }> {
  const clean = handle.replace(/^@/, "");
  const maxAgeDays = opts.maxAgeDays ?? 7;

  // Already scanned recently and deep enough? Answer from the library.
  if (maxAgeDays > 0) {
    const have = db
      .prepare(`SELECT COUNT(*) n, MAX(fetched_at) fetched FROM posts WHERE unique_id = ?`)
      .get(clean) as any;
    if (have?.n >= 20 && have.fetched > Date.now() - maxAgeDays * 86_400_000) {
      const rows = db
        .prepare(`SELECT * FROM posts WHERE unique_id = ? ORDER BY posted_at DESC`)
        .all(clean) as any[];
      return { ...report(clean, rows), cached: true };
    }
  }

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!opts.warmed) await warmup(page);
  const { items } = await harvest(page, `https://www.tiktok.com/@${clean}`, {
    target: opts.target ?? 60,
  });
  // Scans are attributed to the run as well, or a report scoped to a run would miss the
  // very accounts it was told to study.
  const batchId = `a_${Math.random().toString(36).slice(2, 8)}`;
  let slideshows = 0;
  for (const item of items) if (upsertPost(db, item, batchId)) slideshows++;
  recordBatch(db, { id: batchId, kind: "account", query: clean, scanned: items.length, slideshows });

  const rows = db
    .prepare(`SELECT * FROM posts WHERE unique_id = ? ORDER BY posted_at DESC`)
    .all(clean) as (PostRow & { is_photo: number; posted_at: number })[];

  return { ...report(clean, rows), cached: false };
}

export function report(handle: string, rows: any[]): AccountReport {
  const now = Date.now();
  const plays = rows.map((r) => r.play).filter((n) => n > 0);
  const medViews = median(plays);
  const followers = rows.find((r) => r.followers)?.followers ?? null;
  const photos = rows.filter((r) => r.is_photo);

  // A banger has to clear BOTH bars: meaningfully above this account's own baseline, and
  // a floor in absolute terms. 3x of a 400-view median is not a banger.
  const bangerBar = Math.max(50_000, medViews * 3);
  const bangers = rows.filter((r) => r.play >= bangerBar).length;
  const bangerRate = rows.length ? bangers / rows.length : 0;

  const dated = rows
    .map((r) => r.posted_at)
    .filter((t: number) => t > 0)
    .sort((a, b) => b - a);
  const postsLast30d = dated.filter((t) => now - t < 30 * DAY).length;
  const daysSinceLastPost = dated.length ? Math.floor((now - dated[0]) / DAY) : null;

  // Recent cadence, not a lifetime average: an account's rate over its whole history says
  // nothing about whether it's active now.
  const last56 = dated.filter((t) => now - t < 56 * DAY);
  const cadencePerWeek = +(last56.length / 8).toFixed(2);

  // Weeks-covered, not stdev-of-gaps. Gap variance collapses to 0 for anyone who posts in
  // bursts (several in a day, then a pause), which is most creators — it failed to
  // discriminate at all. "What fraction of the last 8 weeks did they show up?" does.
  const weeksHit = new Set(last56.map((t) => Math.floor((now - t) / (7 * DAY))));
  const consistency = +(weeksHit.size / 8).toFixed(2);

  const soundCounts = new Map<string, number>();
  for (const p of photos) if (p.sound_id) soundCounts.set(p.sound_id, (soundCounts.get(p.sound_id) ?? 0) + 1);

  const slideCounts = new Map<number, number>();
  for (const p of photos) slideCounts.set(p.slide_count, (slideCounts.get(p.slide_count) ?? 0) + 1);

  // Gate on COUNT + RECENCY, not rate. A rate gate punishes accounts for posting more:
  // 3 bangers in 38 posts (8%) is a working format, 3 in 12 (25%) is the same format with
  // less output. What actually separates luck from a pattern is hitting it several times
  // and still hitting it now.
  const bangerTimes = rows.filter((r) => r.play >= bangerBar).map((r) => r.posted_at);
  const recentBanger = bangerTimes.some((t: number) => t > 0 && now - t < 90 * DAY);
  const repeatable = bangers >= 3 && recentBanger;

  const why: string[] = [];
  if (bangers <= 1) why.push("one-hit profile — that was luck, not a format; do not clone it");
  else if (bangers === 2) why.push("only 2 bangers — borderline, scan more posts before trusting it");
  else if (!recentBanger) why.push(`${bangers} bangers but none in 90d — the format may be spent`);
  else
    why.push(`${bangers} bangers across ${rows.length} posts, most recent within 90d — repeatable pattern`);
  if (daysSinceLastPost !== null && daysSinceLastPost > 60)
    why.push(`stale: last post ${daysSinceLastPost}d ago`);
  if (photos.length && photos.length / rows.length < 0.3) why.push("mostly video, not a slideshow account");

  return {
    handle,
    followers,
    postsScanned: rows.length,
    slideshows: photos.length,
    photoShare: rows.length ? +(photos.length / rows.length).toFixed(2) : 0,
    bangers,
    bangerRate: +bangerRate.toFixed(2),
    repeatable,
    medianViews: Math.round(medViews),
    medianVPF: followers ? +(medViews / followers).toFixed(2) : null,
    medianSaveRatio: +median(rows.map(saveRatio)).toFixed(4),
    medianCommentRatio: +median(rows.map((r) => (r.play ? r.comment / r.play : 0))).toFixed(4),
    postsLast30d,
    daysSinceLastPost,
    cadencePerWeek,
    consistency,
    topSounds: [...soundCounts]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([soundId, posts]) => ({ soundId, posts })),
    modalSlideCount: [...slideCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    verdict: why.join("; ") || "ok",
  };
}

/** Scan several accounts in one browser session, pacing between profiles. */
export async function scanAccounts(
  ctx: BrowserContext,
  db: DatabaseSync,
  handles: string[],
  opts: { target?: number; warmed?: boolean; maxAgeDays?: number } = {},
): Promise<AccountReport[]> {
  const out: AccountReport[] = [];
  let warmed = opts.warmed ?? false;
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  for (const [i, h] of handles.entries()) {
    const r = await scanAccount(ctx, db, h, {
      target: opts.target,
      warmed,
      maxAgeDays: opts.maxAgeDays,
    });
    out.push(r);
    if (!(r as any).cached) warmed = true;
    // No need to pace between accounts we answered from the library.
    if (i < handles.length - 1 && !(r as any).cached) await settle(page, 5000, 12000);
  }
  return out;
}
