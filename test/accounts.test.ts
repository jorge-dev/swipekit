import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountRows, findAccounts, needsScan, rankingBasis } from "../src/analyze/accounts.ts";
import { seed, testDb } from "./helpers.ts";

const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));

describe("accountRows filtering", () => {
  it("hides accounts that barely post slideshows, since that is the whole subject", () => {
    const db = testDb();
    seed(db, [
      ...many(8, (i) => ({ id: `v${i}`, handle: "videographer", video: true, daysOld: i })),
      { id: "one", handle: "videographer", daysOld: 9 },
    ]);
    assert.equal(accountRows(db).length, 0);
    assert.equal(accountRows(db, { minSlideshowPct: 0 }).length, 1, "the floor is overridable");
    db.close();
  });

  it("ignores accounts with only one post held, which cannot support a median", () => {
    const db = testDb();
    seed(db, [{ id: "solo", handle: "newbie" }]);
    assert.equal(accountRows(db, { minSlideshowPct: 0 }).length, 0);
    db.close();
  });

  it("counts only posts inside the window toward views30d", () => {
    const db = testDb();
    seed(db, [
      { id: "recent", handle: "poster", views: 100_000, daysOld: 5 },
      { id: "alsorecent", handle: "poster", views: 100_000, daysOld: 20 },
      { id: "ancient", handle: "poster", views: 9_000_000, daysOld: 400 },
    ]);
    const [row] = accountRows(db);
    assert.equal(row.views30d, 200_000, "a viral post from last year is not this month's traffic");
    assert.equal(row.posts30d, 2);
    db.close();
  });

  it("honours a custom window", () => {
    const db = testDb();
    seed(db, [
      { id: "a", handle: "poster", views: 100_000, daysOld: 5 },
      { id: "b", handle: "poster", views: 100_000, daysOld: 45 },
    ]);
    assert.equal(accountRows(db, { windowDays: 90 })[0].views30d, 200_000);
    db.close();
  });
});

/**
 * The repeatable gate exists because copying a one-hit account is the most expensive
 * mistake this tool can lead you into. It was originally a rate, which punished accounts
 * that post a lot, so these lock the count-plus-recency version in place.
 */
describe("the repeatable gate", () => {
  it("does not mark an account repeatable on a single lucky post", () => {
    const db = testDb();
    seed(db, [
      ...many(9, (i) => ({ id: `n${i}`, handle: "lucky", views: 5_000, daysOld: i * 7 })),
      {
        id: "hit",
        handle: "lucky",
        views: 4_000_000,
        daysOld: 30,
      },
    ]);
    const [row] = accountRows(db);
    assert.equal(row.bangers, 1);
    assert.equal(row.repeatable, false);
    db.close();
  });

  it("marks an account repeatable on three hits with one still recent", () => {
    const db = testDb();
    seed(db, [
      ...many(7, (i) => ({ id: `n${i}`, handle: "machine", views: 5_000, daysOld: i * 7 })),
      ...many(3, (i) => ({ id: `h${i}`, handle: "machine", views: 900_000, daysOld: 10 + i * 20 })),
    ]);
    const [row] = accountRows(db);
    assert.equal(row.bangers, 3);
    assert.equal(row.repeatable, true);
    db.close();
  });

  it("does not reward an account whose hits are all old", () => {
    const db = testDb();
    seed(db, [
      ...many(7, (i) => ({ id: `n${i}`, handle: "faded", views: 5_000, daysOld: 200 + i })),
      ...many(3, (i) => ({ id: `h${i}`, handle: "faded", views: 900_000, daysOld: 300 + i })),
    ]);
    const [row] = accountRows(db);
    assert.equal(row.bangers, 3);
    assert.equal(row.repeatable, false, "three hits, none inside 90 days, is a dead account");
    db.close();
  });

  it("does not punish a high-volume account for its low hit rate", () => {
    const db = testDb();
    seed(db, [
      ...many(60, (i) => ({ id: `n${i}`, handle: "prolific", views: 5_000, daysOld: i })),
      ...many(4, (i) => ({ id: `h${i}`, handle: "prolific", views: 900_000, daysOld: 5 + i * 10 })),
    ]);
    const [row] = accountRows(db);
    assert.equal(row.repeatable, true, "4 hits in 64 posts is a working system, not a bad rate");
    db.close();
  });

  it("applies an absolute floor so a tiny account cannot 3x its way to a banger", () => {
    const db = testDb();
    seed(db, [
      ...many(7, (i) => ({ id: `n${i}`, handle: "tiny", views: 300, daysOld: i * 3 })),
      ...many(3, (i) => ({ id: `h${i}`, handle: "tiny", views: 4_000, daysOld: 10 + i })),
    ]);
    assert.equal(accountRows(db)[0].bangers, 0, "4k views is not a banger at any baseline");
    db.close();
  });
});

describe("spike", () => {
  it("separates one lucky post from a consistent machine", () => {
    const db = testDb();
    seed(db, [
      ...many(9, (i) => ({ id: `l${i}`, handle: "lottery", views: 10_000, daysOld: i * 4 })),
      { id: "lhit", handle: "lottery", views: 2_000_000, daysOld: 12 },
      ...many(10, (i) => ({ id: `m${i}`, handle: "machine", views: 500_000, daysOld: i * 4 })),
    ]);
    const rows = accountRows(db, { limit: 10 });
    const lottery = rows.find((r) => r.handle === "lottery");
    const machine = rows.find((r) => r.handle === "machine");
    assert.ok(lottery && lottery.spike! > 50, "a 200x post should read as a lottery ticket");
    assert.equal(machine?.spike, 1, "every post at the same level means no spike at all");
    db.close();
  });
});

describe("the reliable flag", () => {
  it("marks an account unreliable when the library does not cover the window", () => {
    const db = testDb();
    seed(
      db,
      many(10, (i) => ({ id: `p${i}`, handle: "fresh", daysOld: i })),
    );
    const [row] = accountRows(db);
    assert.equal(row.reliable, false, "10 posts all from this month says nothing about the window");
    assert.deepEqual(needsScan([row]), ["fresh"]);
    db.close();
  });

  it("marks it reliable once there are enough posts reaching past the window", () => {
    const db = testDb();
    seed(
      db,
      many(10, (i) => ({ id: `p${i}`, handle: "known", daysOld: i * 7 })),
    );
    const [row] = accountRows(db);
    assert.equal(row.reliable, true);
    assert.deepEqual(needsScan([row]), []);
    db.close();
  });

  it("marks it unreliable on too few posts even when they span the window", () => {
    const db = testDb();
    seed(db, [
      { id: "a", handle: "sparse", daysOld: 1 },
      { id: "b", handle: "sparse", daysOld: 200 },
    ]);
    assert.equal(accountRows(db)[0].reliable, false);
    db.close();
  });
});

describe("sorting and limits", () => {
  it("ranks by the requested field", () => {
    const db = testDb();
    seed(db, [
      ...many(3, (i) => ({ id: `s${i}`, handle: "smallfry", followers: 1_000, views: 200_000, daysOld: i })),
      ...many(3, (i) => ({ id: `b${i}`, handle: "bigfish", followers: 500_000, views: 300_000, daysOld: i })),
    ]);
    assert.equal(accountRows(db, { sortBy: "views30d" })[0].handle, "bigfish");
    assert.equal(accountRows(db, { sortBy: "vpf" })[0].handle, "smallfry", "vpf is what transfers");
    assert.equal(accountRows(db, { sortBy: "followers" })[0].handle, "bigfish");
    db.close();
  });

  it("respects the limit", () => {
    const db = testDb();
    seed(
      db,
      many(12, (i) => ({ id: `p${i}`, handle: `acct${i % 6}`, daysOld: i })),
    );
    assert.equal(accountRows(db, { limit: 3 }).length, 3);
    db.close();
  });
});

describe("ranking when the window is empty", () => {
  // Search returns what performed, not what is recent, so a fresh library is mostly
  // evergreen posts and views30d is 0 for nearly everyone. Ranking on it then sorts by the
  // accident of which few posts happened to be new. Measured on a real run: an account with
  // a 257k median sat below one with 564 views.
  const staleGiantAndFreshMinnow = (db: ReturnType<typeof testDb>) =>
    seed(db, [
      ...many(3, (i) => ({ id: `g${i}`, handle: "giant", views: 250_000, daysOld: 300 + i })),
      ...many(3, (i) => ({ id: `m${i}`, handle: "minnow", views: 564, daysOld: i + 1 })),
    ]);

  it("falls back to lifetime best rather than burying the account that actually performed", () => {
    const db = testDb();
    staleGiantAndFreshMinnow(db);
    assert.equal(
      accountRows(db)[0].handle,
      "giant",
      "only one account has posts in the window, so the window is not a ranking",
    );
    db.close();
  });

  it("still honours an explicit sort, even a useless one", () => {
    const db = testDb();
    staleGiantAndFreshMinnow(db);
    assert.equal(accountRows(db, { sortBy: "views30d" })[0].handle, "minnow");
    db.close();
  });

  it("ranks on the window once enough accounts actually have posts in it", () => {
    const db = testDb();
    seed(db, [
      ...many(3, (i) => ({ id: `a${i}`, handle: "busy", views: 90_000, daysOld: i + 1 })),
      ...many(3, (i) => ({ id: `b${i}`, handle: "quiet", views: 10_000, daysOld: i + 1 })),
    ]);
    const rows = accountRows(db);
    assert.equal(rankingBasis(rows), "views30d");
    assert.equal(rows[0].handle, "busy");
    db.close();
  });
});

describe("findAccounts explains an empty table", () => {
  it("blames the window filter rather than telling the caller to go and collect again", () => {
    const db = testDb();
    seed(
      db,
      many(4, (i) => ({ id: `g${i}`, handle: "giant", views: 250_000, daysOld: 300 + i })),
    );
    const out = findAccounts(db, { minViews30d: 100_000 });
    assert.equal(out.rows.length, 0);
    assert.equal(out.emptyBecause, "window-filter");
    assert.equal(out.candidates, 1, "the library does hold this account — the filter removed it");
    db.close();
  });

  it("says so plainly when there is genuinely nothing yet", () => {
    const db = testDb();
    assert.equal(findAccounts(db).emptyBecause, "no-accounts");
    db.close();
  });

  it("reports which basis it ranked on, so the agent can caveat it", () => {
    const db = testDb();
    seed(
      db,
      many(4, (i) => ({ id: `g${i}`, handle: "giant", views: 250_000, daysOld: 300 + i })),
    );
    const out = findAccounts(db);
    assert.equal(out.sortedBy, "bestViews");
    assert.equal(out.windowEmpty, true);
    db.close();
  });
});
