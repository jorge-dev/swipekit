import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fetchSlides, fetchSlidesWithRefresh, type SlideFetch } from "./slides.ts";
import type { BrowserContext } from "playwright-core";
import type { ScanAccountFn } from "../collect/scan.ts";
import { libPath } from "../store/paths.ts";

/**
 * "Every slide plus its data, in one zip." Uses the system `zip`, so no dependency.
 * Slide URLs carry a ~48h signature — anything older must be re-harvested first.
 */
/**
 * Lets an expired-URL post self-heal via a targeted re-scan instead of just reporting
 * "expired". Pass one whenever the caller already has a browser open.
 */
export type RefreshHook = {
  ctx: BrowserContext;
  scanAccount: ScanAccountFn;
  warmed: boolean;
};

export async function zipPost(
  db: DatabaseSync,
  awemeId: string,
  opts: {
    outDir?: string;
    maxSlides?: number;
    // Passing a browser lets an expired-URL post self-heal via a targeted re-scan instead
    // of just reporting "expired" — pass one whenever the caller has one open already.
    refresh?: RefreshHook;
  } = {},
): Promise<{ awemeId: string; zip?: string; slides?: number; error?: string }> {
  const outDir = opts.outDir ?? libPath("zips");
  const dir = libPath("posts", awemeId);

  const post = db
    .prepare(
      `SELECT p.*, a.hook_text, a.hook_type, a.structure, a.emotional_angle, a.cta_style,
              a.visual_style, a.assets_needed, a.template, a.production_notes
       FROM posts p LEFT JOIN analyses a ON a.aweme_id = p.aweme_id WHERE p.aweme_id = ?`,
    )
    .get(awemeId) as any;
  if (!post) return { awemeId, error: "not in library" };

  let got: SlideFetch;
  if (opts.refresh) {
    const r = await fetchSlidesWithRefresh(
      opts.refresh.ctx,
      db,
      [awemeId],
      opts.maxSlides ?? 20,
      opts.refresh.scanAccount,
      opts.refresh.warmed,
    );
    got = r.results[0];
  } else {
    got = (await fetchSlides(db, [awemeId], opts.maxSlides ?? 20))[0];
  }
  if (got?.error) return { awemeId, error: got.error };

  mkdirSync(dir, { recursive: true });
  for (const [i, im] of got.images.entries()) {
    writeFileSync(`${dir}/slide-${String(i + 1).padStart(2, "0")}.jpg`, Buffer.from(im.data, "base64"));
  }

  writeFileSync(
    `${dir}/metadata.json`,
    JSON.stringify(
      {
        awemeId,
        url: `https://www.tiktok.com/@${post.unique_id}/photo/${awemeId}`,
        handle: post.unique_id,
        followers: post.followers,
        postedAt: post.posted_at ? new Date(post.posted_at).toISOString() : null,
        caption: post.caption,
        hashtags: post.hashtags,
        soundId: post.sound_id,
        slideCount: post.slide_count,
        stats: {
          views: post.play,
          likes: post.digg,
          comments: post.comment,
          shares: post.share,
          saves: post.collect,
          viewsPerFollower: post.followers ? +(post.play / post.followers).toFixed(1) : null,
          saveRatio: post.play ? +(post.collect / post.play).toFixed(4) : null,
        },
        analysis: post.hook_text
          ? {
              hook: post.hook_text,
              hookType: post.hook_type,
              structure: post.structure,
              emotionalAngle: post.emotional_angle,
              ctaStyle: post.cta_style,
              visualStyle: post.visual_style,
              assetsNeeded: JSON.parse(post.assets_needed || "[]"),
              slideSkeleton: JSON.parse(post.template || "[]"),
              productionNotes: post.production_notes,
            }
          : null,
      },
      null,
      2,
    ),
  );

  mkdirSync(outDir, { recursive: true });
  const zip = resolve(`${outDir}/${post.unique_id}-${awemeId}.zip`);
  if (existsSync(zip)) rmSync(zip);
  execFileSync("zip", ["-jqr", zip, dir], { stdio: "ignore" });

  return { awemeId, zip, slides: got.images.length };
}

/** Top posts of one account, sorted however you like, each zipped with its data. */
export async function zipTopPosts(
  db: DatabaseSync,
  handle: string,
  opts: {
    n?: number;
    sortBy?: "views" | "likes" | "engagement" | "saves";
    outDir?: string;
    refresh?: RefreshHook;
  } = {},
) {
  const col =
    opts.sortBy === "likes"
      ? "p.digg"
      : opts.sortBy === "saves"
        ? "CAST(p.collect AS REAL)/MAX(p.play,1)"
        : opts.sortBy === "engagement"
          ? "CAST(p.digg+p.comment+p.share+p.collect AS REAL)/MAX(p.play,1)"
          : "p.play";

  const rows = db
    .prepare(
      `SELECT p.aweme_id FROM posts p WHERE p.unique_id = ? AND p.is_photo = 1
       ORDER BY ${col} DESC LIMIT ?`,
    )
    .all(handle.replace(/^@/, ""), opts.n ?? 5) as any[];

  if (!rows.length)
    return { handle, error: "no slideshows for that account in the library — scan_account first" };

  const out = [];
  for (const r of rows)
    out.push(await zipPost(db, r.aweme_id, { outDir: opts.outDir, refresh: opts.refresh }));
  return { handle, sortBy: opts.sortBy ?? "views", zips: out };
}
