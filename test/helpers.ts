import type { DatabaseSync } from "node:sqlite";
import { isPhotoPost } from "../src/collect/payload.ts";
import { open, recordBatch, upsertPost } from "../src/store/db.ts";

export const DAY = 86_400_000;

/** Fixed clock so "posted 10 days ago" means the same thing on every run. */
export const NOW = Date.now();
export const daysAgo = (n: number) => NOW - n * DAY;

let seq = 0;

type PostSpec = {
  handle?: string;
  secUid?: string;
  followers?: number | null;
  views?: number;
  saves?: number;
  comments?: number;
  likes?: number;
  shares?: number;
  daysOld?: number;
  slides?: number;
  video?: boolean;
  sound?: string;
  caption?: string;
  id?: string;
};

/**
 * Build the raw TikTok item shape rather than inserting rows directly. Tests then exercise
 * the same parsing path production uses, so a change to TikTok's payload shape breaks a
 * test instead of quietly producing empty columns.
 */
export function item(spec: PostSpec = {}) {
  const handle = spec.handle ?? "someone";
  const slides = spec.slides ?? 6;
  const isVideo = spec.video ?? false;

  const base: any = {
    id: spec.id ?? `post_${++seq}`,
    createTime: Math.floor(daysAgo(spec.daysOld ?? 10) / 1000),
    desc: spec.caption ?? "a caption",
    author: {
      uniqueId: handle,
      secUid: spec.secUid ?? `sec_${handle}`,
      nickname: handle,
      verified: false,
    },
    authorStats: { followerCount: spec.followers === undefined ? 10_000 : spec.followers },
    music: { id: spec.sound ?? "sound_default" },
    stats: {
      playCount: spec.views ?? 100_000,
      diggCount: spec.likes ?? 1_000,
      commentCount: spec.comments ?? 50,
      shareCount: spec.shares ?? 20,
      collectCount: spec.saves ?? 2_000,
    },
  };

  if (!isVideo) {
    base.imagePost = {
      images: Array.from({ length: slides }, (_, i) => ({
        imageURL: { urlList: [`https://example.test/${base.id}/${i}.jpg`] },
      })),
    };
  }
  return base;
}

/** A throwaway library. `:memory:` means no file is written and no test can see another's data. */
export function testDb(): DatabaseSync {
  return open(":memory:");
}

export function seed(db: DatabaseSync, specs: PostSpec[], batchId?: string) {
  const items = specs.map(item);
  for (const i of items) upsertPost(db, i, batchId);
  if (batchId) {
    recordBatch(db, {
      id: batchId,
      kind: "search",
      query: "test query",
      scanned: items.length,
      slideshows: items.filter(isPhotoPost).length,
    });
  }
  return items;
}
