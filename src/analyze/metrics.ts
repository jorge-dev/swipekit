import type { DatabaseSync } from "node:sqlite";

export type PostRow = {
  aweme_id: string;
  unique_id: string;
  posted_at: number;
  slide_count: number;
  caption: string;
  sound_id: string | null;
  play: number;
  digg: number;
  comment: number;
  share: number;
  collect: number;
  followers: number | null;
};

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** views ÷ followers. The format is carrying the post when this is high. */
export const vpf = (p: PostRow) => (p.followers ? p.play / p.followers : null);

export const engagement = (p: PostRow) => (p.play ? (p.digg + p.comment + p.share + p.collect) / p.play : 0);

/** Saves ÷ views. For slideshows this is the strongest signal — a save means "reference". */
export const saveRatio = (p: PostRow) => (p.play ? p.collect / p.play : 0);
export const commentRatio = (p: PostRow) => (p.play ? p.comment / p.play : 0);

/**
 * Views ÷ that account's own median views. This is what "what works" means: an 8x post
 * proves the FORMAT won, independent of account size.
 *
 * Needs enough posts from the same account to have a meaningful median — a search batch
 * usually has 1–2 posts per account, so this stays null until scan_account has run.
 */
export function outlierScores(db: DatabaseSync, minPosts = 5): Map<string, number> {
  const rows = db.prepare(`SELECT sec_uid, aweme_id, play FROM posts WHERE play > 0`).all() as any[];

  const byAccount = new Map<string, { id: string; play: number }[]>();
  for (const r of rows) {
    if (!byAccount.has(r.sec_uid)) byAccount.set(r.sec_uid, []);
    byAccount.get(r.sec_uid)!.push({ id: r.aweme_id, play: r.play });
  }

  const out = new Map<string, number>();
  for (const posts of byAccount.values()) {
    if (posts.length < minPosts) continue;
    const med = median(posts.map((p) => p.play));
    if (!med) continue;
    for (const p of posts) out.set(p.id, p.play / med);
  }
  return out;
}

export type Summary = {
  batchId: string;
  query: string;
  scanned: number;
  slideshows: number;
  photoShare: number;
  qualifyingAccounts: number;
  medianVPF: number | null;
  medianSaveRatio: number | null;
  slideCountMode: number | null;
  topSounds: { soundId: string; posts: number }[];
  note: string;
};

/**
 * Batch summaries are what tools RETURN. Raw posts stay in the database — returning 300
 * post objects to an agent burns its context before it can reason.
 */
export function summarize(
  db: DatabaseSync,
  batchId: string,
  query: string,
  filters: { maxFollowers?: number; minVPF?: number } = {},
): Summary {
  const maxFollowers = filters.maxFollowers ?? 100_000;
  const minVPF = filters.minVPF ?? 3;

  const rows = db
    .prepare(
      `SELECT p.* FROM posts p JOIN batch_posts b ON b.aweme_id = p.aweme_id
       WHERE b.batch_id = ?`,
    )
    .all(batchId) as PostRow[];

  const photos = rows.filter((r: any) => r.is_photo);
  const vpfs = photos.map(vpf).filter((v): v is number => v !== null);

  const qualifying = new Set(
    photos
      .filter((p) => p.followers && p.followers <= maxFollowers && (vpf(p) ?? 0) >= minVPF)
      .map((p) => p.unique_id),
  );

  const soundCounts = new Map<string, number>();
  for (const p of photos) {
    if (p.sound_id) soundCounts.set(p.sound_id, (soundCounts.get(p.sound_id) ?? 0) + 1);
  }
  const topSounds = [...soundCounts]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([soundId, posts]) => ({ soundId, posts }));

  const slideCounts = new Map<number, number>();
  for (const p of photos) slideCounts.set(p.slide_count, (slideCounts.get(p.slide_count) ?? 0) + 1);
  const slideCountMode = [...slideCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const notes: string[] = [];
  if (!photos.length) notes.push("No slideshows on this surface — try a search query, not a hashtag.");
  if (topSounds.length)
    notes.push(
      `${topSounds[0].posts} slideshows share sound ${topSounds[0].soundId} — likely a format cohort, worth track_sound.`,
    );
  if (qualifying.size && qualifying.size < 5) notes.push("Thin lane: fewer than 5 qualifying accounts.");

  return {
    batchId,
    query,
    scanned: rows.length,
    slideshows: photos.length,
    photoShare: rows.length ? +(photos.length / rows.length).toFixed(3) : 0,
    qualifyingAccounts: qualifying.size,
    medianVPF: vpfs.length ? +median(vpfs).toFixed(2) : null,
    medianSaveRatio: photos.length ? +median(photos.map(saveRatio)).toFixed(4) : null,
    slideCountMode,
    topSounds,
    note: notes.join(" ") || "ok",
  };
}
