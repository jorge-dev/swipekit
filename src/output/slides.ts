import type { DatabaseSync } from "node:sqlite";
import type { BrowserContext } from "playwright-core";
import { ANALYSIS_DDL, type Analysis } from "../analyze/taxonomy.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export type SlideFetch = {
  awemeId: string;
  handle: string;
  caption: string;
  views: number;
  followers: number | null;
  slideCount: number;
  images: { mimeType: string; data: string }[];
  error?: string;
};

/**
 * Fetch a post's slides as base64 for the host model to look at directly.
 *
 * This is the MCP-native path: the model driving these tools is already Claude, so the
 * server has no business buying its own inference. It hands over the pixels; the model in
 * the conversation reads them. No API key, no second bill, and the reasoning happens in a
 * model that already has the full research context.
 */
export async function fetchSlides(
  db: DatabaseSync,
  awemeIds: string[],
  maxSlides = 4,
): Promise<SlideFetch[]> {
  const out: SlideFetch[] = [];

  for (const id of awemeIds) {
    const post = db
      .prepare(
        `SELECT aweme_id, unique_id, caption, play, followers, slide_count, slide_urls
         FROM posts WHERE aweme_id = ?`,
      )
      .get(id) as any;

    const base = {
      awemeId: id,
      handle: post?.unique_id ?? "?",
      caption: String(post?.caption ?? "").slice(0, 400),
      views: post?.play ?? 0,
      followers: post?.followers ?? null,
      slideCount: post?.slide_count ?? 0,
      images: [] as { mimeType: string; data: string }[],
    };

    if (!post) {
      out.push({ ...base, error: "not in library" });
      continue;
    }

    const urls: string[] = JSON.parse(post.slide_urls || "[]");
    if (!urls.length) {
      out.push({ ...base, error: "no slides (video post?)" });
      continue;
    }

    for (const u of urls.slice(0, maxSlides)) {
      try {
        const r = await fetch(u, { headers: { Referer: "https://www.tiktok.com/", "User-Agent": UA } });
        if (!r.ok) continue;
        base.images.push({
          mimeType: "image/jpeg",
          data: Buffer.from(await r.arrayBuffer()).toString("base64"),
        });
      } catch {
        /* skip this slide */
      }
    }

    if (!base.images.length) {
      // Slide URLs carry an ~48h signature; past that they 403 and the post must be re-harvested.
      out.push({ ...base, error: "slide URLs expired — re-run discover/scan for this account" });
      continue;
    }

    out.push(base);
  }

  return out;
}

/**
 * Slide URLs carry a ~48h signature. Every earlier iteration of this tool hit the same
 * failure mode: read_slides or download_post reports "expired" on a post everyone still
 * wants to look at, and the caller has to notice and re-run scan_account by hand.
 *
 * This does that automatically: try the cheap fetch first, and only pay for a browser
 * re-scan of the owning account when the cheap path actually failed on expiry.
 */
export async function fetchSlidesWithRefresh(
  ctx: BrowserContext,
  db: DatabaseSync,
  awemeIds: string[],
  maxSlides: number,
  scanAccount: (
    ctx: BrowserContext,
    db: DatabaseSync,
    handle: string,
    opts: { target?: number; warmed?: boolean; maxAgeDays?: number },
  ) => Promise<unknown>,
  warmed: boolean,
): Promise<{ results: SlideFetch[]; rescanned: string[]; warmed: boolean }> {
  const first = await fetchSlides(db, awemeIds, maxSlides);
  const expired = first.filter((r) => r.error?.includes("expired"));
  if (!expired.length) return { results: first, rescanned: [], warmed };

  const handles = [...new Set(expired.map((r) => r.handle).filter((h) => h && h !== "?"))];
  for (const h of handles) {
    await scanAccount(ctx, db, h, { target: 60, warmed, maxAgeDays: 0 });
    warmed = true;
  }

  const retried = await fetchSlides(
    db,
    expired.map((r) => r.awemeId),
    maxSlides,
  );
  const byId = new Map(first.map((r) => [r.awemeId, r]));
  for (const r of retried) byId.set(r.awemeId, r);
  return { results: awemeIds.map((id) => byId.get(id)!), rescanned: handles, warmed };
}

export type SavedAnalysis = Analysis & { awemeId: string };

/** Persist the host model's verdict so a post is only ever read once. */
export function saveAnalyses(db: DatabaseSync, items: SavedAnalysis[], model = "host-model"): number {
  db.exec(ANALYSIS_DDL);
  const stmt = db.prepare(`INSERT OR REPLACE INTO analyses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const a of items) {
    stmt.run(
      a.awemeId,
      a.hookText,
      a.hookType,
      a.structure,
      a.emotionalAngle,
      a.ctaStyle,
      a.visualStyle,
      a.requiresOwnLikeness ? 1 : 0,
      a.requiresSpecificSubject ? 1 : 0,
      JSON.stringify(a.assetsNeeded),
      a.productionNotes,
      a.textDensity,
      JSON.stringify(a.reusableTemplate),
      model,
      Date.now(),
    );
    n++;
  }
  return n;
}

export function alreadyAnalyzed(db: DatabaseSync, awemeIds: string[]): Set<string> {
  db.exec(ANALYSIS_DDL);
  const out = new Set<string>();
  for (const id of awemeIds) {
    if (db.prepare(`SELECT 1 FROM analyses WHERE aweme_id = ?`).get(id)) out.add(id);
  }
  return out;
}
