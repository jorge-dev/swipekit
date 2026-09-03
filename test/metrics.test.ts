import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commentRatio,
  engagement,
  median,
  outlierScores,
  saveRatio,
  summarize,
  vpf,
} from "../src/analyze/metrics.ts";
import type { PostRow } from "../src/analyze/metrics.ts";
import { seed, testDb } from "./helpers.ts";
import { topPosts } from "../src/collect/discover.ts";

const post = (o: Partial<PostRow>) =>
  ({ play: 0, digg: 0, comment: 0, share: 0, collect: 0, followers: null, ...o }) as PostRow;

describe("median", () => {
  it("averages the middle pair on an even count", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("takes the middle on an odd count", () => {
    assert.equal(median([5, 1, 3]), 3);
  });

  it("returns 0 for an empty list instead of NaN", () => {
    assert.equal(median([]), 0);
  });
});

describe("per-post ratios", () => {
  it("gives views per follower, the number that actually transfers", () => {
    assert.equal(vpf(post({ play: 300_000, followers: 8_000 })), 37.5);
  });

  it("returns null rather than dividing by zero followers", () => {
    assert.equal(vpf(post({ play: 300_000, followers: 0 })), null);
    assert.equal(vpf(post({ play: 300_000, followers: null })), null);
  });

  it("treats a save as its own signal, not folded into likes", () => {
    assert.equal(saveRatio(post({ play: 100_000, collect: 7_000 })), 0.07);
    assert.equal(commentRatio(post({ play: 100_000, comment: 250 })), 0.0025);
  });

  it("sums all four interactions for engagement", () => {
    assert.equal(engagement(post({ play: 1_000, digg: 100, comment: 10, share: 5, collect: 85 })), 0.2);
  });

  it("returns 0 on a post with no views instead of NaN", () => {
    assert.equal(saveRatio(post({ play: 0, collect: 10 })), 0);
    assert.equal(engagement(post({ play: 0, digg: 10 })), 0);
  });
});

describe("summarize", () => {
  it("counts videos in scanned but not in slideshows", () => {
    const db = testDb();
    seed(db, [{ id: "a" }, { id: "b" }, { id: "c", video: true }], "batch1");
    const s = summarize(db, "batch1", "test query");
    assert.equal(s.scanned, 3);
    assert.equal(s.slideshows, 2);
    assert.equal(s.photoShare, 0.667);
    db.close();
  });

  it("counts qualifying accounts once each, not once per post", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a", handle: "small", followers: 5_000, views: 500_000 },
        { id: "b", handle: "small", followers: 5_000, views: 400_000 },
        { id: "c", handle: "big", followers: 900_000, views: 900_000 },
      ],
      "batch1",
    );
    const s = summarize(db, "batch1", "q");
    assert.equal(s.qualifyingAccounts, 1, "the 900k-follower account is not a format to copy");
    db.close();
  });

  it("only reports a sound once more than one post shares it", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a", handle: "one", sound: "shared" },
        { id: "b", handle: "two", sound: "shared" },
        { id: "c", handle: "three", sound: "lonely" },
      ],
      "batch1",
    );
    const s = summarize(db, "batch1", "q");
    assert.deepEqual(s.topSounds, [{ soundId: "shared", posts: 2 }]);
    db.close();
  });

  it("reports the modal slide count, not the average", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a", slides: 6 },
        { id: "b", slides: 6 },
        { id: "c", slides: 20 },
      ],
      "batch1",
    );
    assert.equal(summarize(db, "batch1", "q").slideCountMode, 6);
    db.close();
  });

  it("says so plainly when a surface returned no slideshows", () => {
    const db = testDb();
    seed(db, [{ id: "a", video: true }], "batch1");
    const s = summarize(db, "batch1", "q");
    assert.equal(s.slideshows, 0);
    assert.match(s.note, /no slideshows/i);
    db.close();
  });

  it("returns zeroes rather than throwing on an unknown batch", () => {
    const db = testDb();
    const s = summarize(db, "does-not-exist", "q");
    assert.equal(s.scanned, 0);
    assert.equal(s.photoShare, 0);
    db.close();
  });
});

describe("outlierScores", () => {
  it("scores a post against its own account's median, not the global one", () => {
    const db = testDb();
    seed(db, [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, handle: "quiet", views: 10_000 })),
      { id: "hit", handle: "quiet", views: 100_000 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, handle: "loud", views: 1_000_000 })),
    ]);
    const scores = outlierScores(db);
    assert.ok((scores.get("hit") ?? 0) > 5, "a 10x post on a quiet account is an outlier");
    assert.ok((scores.get("l0") ?? 99) < 2, "a steady million-view account has no outliers");
    db.close();
  });

  it("skips accounts with too few posts to have a meaningful median", () => {
    const db = testDb();
    seed(db, [
      { id: "a", handle: "thin", views: 900_000 },
      { id: "b", handle: "thin", views: 1_000 },
    ]);
    assert.equal(outlierScores(db, 5).size, 0);
    db.close();
  });
});

describe("outlier falls back to the niche when an account is too thin", () => {
  const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));

  it("measures against the account's own median once we hold enough of it", () => {
    const db = testDb();
    seed(db, [
      ...many(5, (i) => ({ id: `n${i}`, handle: "known", views: 100_000, daysOld: i + 1 })),
      { id: "hit", handle: "known", views: 900_000, daysOld: 2 },
    ]);
    const hit = topPosts(db, { limit: 20 }).find((r) => r.id === "hit")!;
    assert.equal(hit.outlierBasis, "account");
    assert.ok(hit.outlier! > 5, "9x its own median is the finding");
    db.close();
  });

  it("still scores a post from an account we barely hold, and says the basis is weaker", () => {
    const db = testDb();
    seed(db, [
      ...many(5, (i) => ({ id: `n${i}`, handle: "known", views: 100_000, daysOld: i + 1 })),
      // Two posts is what a search batch gives you — not enough for a median of its own.
      { id: "thin1", handle: "stranger", views: 800_000, daysOld: 3 },
      { id: "thin2", handle: "stranger", views: 60_000, daysOld: 4 },
    ]);
    const rows = topPosts(db, { limit: 20 });
    const thin = rows.find((r) => r.id === "thin1")!;
    assert.equal(thin.outlierBasis, "niche", "measured against the run, not against its author");
    assert.ok(thin.outlier! > 1, "it beat the niche baseline, which is worth ranking on");
    db.close();
  });

  it("does not bury a thin-account post beneath every scanned one", () => {
    const db = testDb();
    seed(db, [
      ...many(5, (i) => ({ id: `n${i}`, handle: "known", views: 100_000, daysOld: i + 1 })),
      { id: "huge", handle: "stranger", views: 2_000_000, daysOld: 3 },
      { id: "also", handle: "stranger", views: 70_000, daysOld: 4 },
    ]);
    // Before the fallback this sorted to last, because a null outlier scored -1.
    assert.equal(topPosts(db, { sortBy: "outlier", limit: 20 })[0].id, "huge");
    db.close();
  });
});
