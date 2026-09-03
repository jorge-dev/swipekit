import type { BrowserContext } from "playwright";
import type { DatabaseSync } from "node:sqlite";
import { harvest } from "./harvest.ts";
import { recordBatch, upsertPost } from "../store/db.ts";
import { runScope } from "../store/runs.ts";
import { summarize, type Summary } from "../analyze/metrics.ts";
import { warmup } from "./session.ts";

const slug = () => Math.random().toString(36).slice(2, 8);

/**
 * Slideshow trends propagate through SOUNDS. A format spreads as a sound + slide-count +
 * hook-shape package, so pulling every post on one sound returns a format cohort: the set
 * of accounts running the same skeleton in the same window.
 *
 * This is the move a human researcher almost never makes by hand — it's tedious, and it's
 * the highest-yield thing the tool does.
 */
export async function trackSound(
  ctx: BrowserContext,
  db: DatabaseSync,
  soundId: string,
  opts: { target?: number; warmed?: boolean } = {},
): Promise<
  Summary & {
    soundId: string;
    distinctAccounts: number;
    independentAccounts: number;
    duplicateCaptionAccounts: number;
    clusters: { caption: string; accounts: number; handles: string[] }[];
    topHashtags: { tag: string; posts: number }[];
    topicalCoherence: number;
    mixedTopic: boolean;
    isCohort: boolean;
  }
> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!opts.warmed) await warmup(page);

  const batchId = `s_${slug()}`;
  // Any slug works; TikTok resolves the music page off the trailing id.
  const url = `https://www.tiktok.com/music/x-${soundId}`;
  const { items } = await harvest(page, url, { target: opts.target ?? 120 });

  let slideshows = 0;
  for (const item of items) if (upsertPost(db, item, batchId)) slideshows++;
  recordBatch(db, {
    id: batchId,
    kind: "sound",
    query: soundId,
    scanned: items.length,
    slideshows,
  });

  const base = summarize(db, batchId, `sound:${soundId}`);
  const ops = operatorClusters(db, batchId);
  const topic = topicalCoherence(db, batchId);
  const distinctAccounts = new Set(items.filter((i: any) => i?.imagePost).map((i: any) => i?.author?.secUid))
    .size;

  return {
    ...base,
    soundId,
    distinctAccounts,
    ...ops,
    ...topic,
    // Independence AND topical coherence: 60 accounts that are 5 operators is 5 data points,
    // and a generally-trending sound is not a format at all.
    isCohort: slideshows >= 4 && ops.independentAccounts >= 3 && !topic.mixedTopic,
  };
}

/**
 * Distinct accounts is NOT distinct operators. One person running 20 accounts posting the
 * same caption, sound and slide count is the standard slideshow playbook — so a cohort can
 * look 60 accounts wide and actually be five operators.
 *
 * Clustering on the normalised caption separates "many people converged on this format"
 * (trustworthy) from "one person cloned themselves" (still a working format, but the
 * account count is not evidence of independent validation).
 */
export function operatorClusters(db: DatabaseSync, batchId: string) {
  const rows = db
    .prepare(
      `SELECT p.unique_id, p.caption FROM posts p
       JOIN batch_posts bp ON bp.aweme_id = p.aweme_id
       WHERE bp.batch_id = ? AND p.is_photo = 1 AND LENGTH(p.caption) > 15`,
    )
    .all(batchId) as any[];

  const norm = (c: string) =>
    c
      .toLowerCase()
      .replace(/#\S+/g, "")
      .replace(/[^a-z ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

  const byCaption = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = norm(r.caption);
    if (k.length < 15) continue;
    if (!byCaption.has(k)) byCaption.set(k, new Set());
    byCaption.get(k)!.add(r.unique_id);
  }

  const grouped = [...byCaption].filter(([, accts]) => accts.size > 1).sort((a, b) => b[1].size - a[1].size);

  // Count over the full sets; `handles` is truncated for display only, so counting from it
  // would silently undercount any cluster wider than 5 accounts.
  const clustered = new Set(grouped.flatMap(([, accts]) => [...accts]));

  const clusters = grouped.map(([caption, accts]) => ({
    caption: caption.slice(0, 50),
    accounts: accts.size,
    handles: [...accts].slice(0, 5),
  }));
  const allAccounts = new Set(rows.map((r) => r.unique_id));

  return {
    clusters,
    duplicateCaptionAccounts: clustered.size,
    // Accounts not sharing a verbatim caption with anyone else — the honest independence count.
    independentAccounts: allAccounts.size - clustered.size,
  };
}

/**
 * A sound cohort is an AUDIO cohort, not necessarily a format cohort. Verified case: sound
 * 7635803634156636936 carries both looksmaxxing guides and an unrelated "#25max cheesepizza"
 * meme. Hashtag overlap is a cheap topical-coherence check — if the top tag covers only a
 * small share of the cohort, the sound is trending generally and the cohort needs filtering
 * before you read anything into it.
 */
export function topicalCoherence(db: DatabaseSync, batchId: string) {
  const rows = db
    .prepare(
      `SELECT p.hashtags FROM posts p JOIN batch_posts bp ON bp.aweme_id = p.aweme_id
       WHERE bp.batch_id = ? AND p.is_photo = 1`,
    )
    .all(batchId) as any[];

  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of new Set(
      String(r.hashtags || "")
        .split(/\s+/)
        .filter(Boolean),
    )) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const share = rows.length && top[0] ? +(top[0][1] / rows.length).toFixed(2) : 0;

  return {
    topHashtags: top.map(([tag, posts]) => ({ tag, posts })),
    topicalCoherence: share,
    mixedTopic: share < 0.35,
  };
}

export type CohortRow = {
  soundId: string;
  posts: number;
  accounts: number;
  medianViews: number;
  newestDays: number | null;
  tracked: boolean;
};

/**
 * Sounds worth calling trackSound on: already seen on slideshows from more than one
 * account, and not already pulled.
 */
export function soundCandidates(db: DatabaseSync, limit = 10, runId?: string | null): CohortRow[] {
  const scope = runScope(runId);
  const rows = db
    .prepare(
      `SELECT p.sound_id                                  AS soundId,
              COUNT(*)                                    AS posts,
              COUNT(DISTINCT p.sec_uid)                   AS accounts,
              CAST(AVG(p.play) AS INT)                    AS medianViews,
              MAX(p.posted_at)                            AS newest,
              EXISTS(SELECT 1 FROM batches b
                     WHERE b.kind = 'sound' AND b.query = p.sound_id) AS tracked
       FROM posts p
       WHERE p.is_photo = 1 AND p.sound_id IS NOT NULL AND p.sound_id != '0' ${scope.sql}
       GROUP BY p.sound_id
       HAVING accounts >= 2
       ORDER BY accounts DESC, posts DESC
       LIMIT ?`,
    )
    .all(...scope.params, limit) as any[];

  return rows.map((r) => ({
    soundId: r.soundId,
    posts: r.posts,
    accounts: r.accounts,
    medianViews: r.medianViews,
    newestDays: r.newest ? Math.floor((Date.now() - r.newest) / 86_400_000) : null,
    tracked: !!r.tracked,
  }));
}
