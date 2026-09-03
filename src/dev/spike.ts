/**
 * Phase 0 spike — the only question that matters:
 * can we scroll a real TikTok surface and harvest slideshow posts with their image URLs?
 *
 *   npm run spike -- --tag toddlermom --target 60
 *
 * If this prints slide URLs, every remaining piece is ordinary application code.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { harvest } from "../collect/harvest.ts";
import { isPhotoPost, slideUrls } from "../collect/payload.ts";
import { BlockedError, openSession, warmup } from "../collect/session.ts";
import { libPath } from "../store/paths.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tag = arg("tag", "toddlermom");
const target = Number(arg("target", "60"));
const url = arg("url", "") || `https://www.tiktok.com/tag/${tag}`;

const ctx = await openSession();
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log(`\n→ warming profile on tiktok.com…`);
  await warmup(page);

  console.log(`\n→ ${url}   (target ${target} posts)\n`);
  const t0 = Date.now();
  const { items, scrolls, sawEnd, hits } = await harvest(page, url, { target });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const photos = items.filter(isPhotoPost);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`scrolls        ${scrolls}   (${secs}s, end-of-feed: ${sawEnd})`);
  console.log(`posts          ${items.length}`);
  console.log(
    `slideshows     ${photos.length}` +
      (items.length ? `   (${Math.round((photos.length / items.length) * 100)}% photoShare)` : ""),
  );
  for (const h of hits) console.log(`  via ${h.url}  ${h.count}`);
  console.log("=".repeat(64));

  if (!items.length) {
    console.log("\nNo posts harvested. Either the page never loaded a feed endpoint,");
    console.log("or we were soft-blocked. Check the visible browser window.\n");
  }

  for (const p of photos.slice(0, 5)) {
    const slides = slideUrls(p);
    console.log(`\n@${p.author?.uniqueId}  ${p.authorStats?.followerCount ?? "?"} followers`);
    console.log(`  views ${p.stats?.playCount}  saves ${p.stats?.collectCount}  slides ${slides.length}`);
    console.log(`  vpf   ${(p.stats?.playCount / (p.authorStats?.followerCount || 1)).toFixed(1)}`);
    console.log(`  sound ${p.music?.id ?? "-"}`);
    console.log(`  post  https://www.tiktok.com/@${p.author?.uniqueId}/photo/${p.id}`);
    console.log(`  slide ${slides[0] ?? "(none)"}`);
  }

  mkdirSync("library", { recursive: true });
  const out = libPath(`spike-${tag}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ tag, url, items }, null, 2));
  console.log(`\nraw → ${out}\n`);
} catch (e) {
  if (e instanceof BlockedError) {
    console.log(`\n⚠ ${e.message}`);
    console.log("Solve it in the open Chrome window, then re-run. Do not retry in a loop.\n");
  } else throw e;
} finally {
  await ctx.close();
}
