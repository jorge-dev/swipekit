import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountPostCount, upsertPost } from "../src/store/db.ts";
import { currentRun, listRuns, requireRun, runScope, setCurrentRun, startRun } from "../src/store/runs.ts";
import { accountRows } from "../src/analyze/accounts.ts";
import { topPosts } from "../src/collect/discover.ts";
import { item, seed, testDb } from "./helpers.ts";

describe("open", () => {
  it("waits on a locked database instead of failing the call", () => {
    // Every stdio client is its own process with its own handle on one file, so two of them
    // writing at once is ordinary rather than exceptional. Without a busy timeout SQLite
    // throws immediately and the loser sees a failed tool call mid-research.
    const db = testDb();
    assert.equal((db.prepare("PRAGMA busy_timeout").get() as any).timeout, 5000);
    db.close();
  });
});

describe("upsertPost", () => {
  it("refreshes a post's stats instead of duplicating it", () => {
    const db = testDb();
    upsertPost(db, item({ id: "same", handle: "acct", views: 1_000 }));
    upsertPost(db, item({ id: "same", handle: "acct", views: 90_000 }));
    assert.equal(accountPostCount(db, "sec_acct"), 1);
    assert.equal((db.prepare("SELECT play FROM posts WHERE aweme_id='same'").get() as any).play, 90_000);
    db.close();
  });

  it("stores slide_count from the parsed urls, and 0 for a video", () => {
    const db = testDb();
    upsertPost(db, item({ id: "deck", slides: 7 }));
    upsertPost(db, item({ id: "clip", video: true }));
    const q = (id: string) =>
      db.prepare("SELECT is_photo, slide_count FROM posts WHERE aweme_id=?").get(id) as any;
    assert.deepEqual({ ...q("deck") }, { is_photo: 1, slide_count: 7 });
    assert.deepEqual({ ...q("clip") }, { is_photo: 0, slide_count: 0 });
    db.close();
  });

  it("keeps videos rather than dropping them at collection time", () => {
    const db = testDb();
    upsertPost(db, item({ id: "clip", video: true }));
    assert.equal((db.prepare("SELECT COUNT(*) n FROM posts").get() as any).n, 1);
    db.close();
  });

  it("refuses a payload with no id or author instead of writing a broken row", () => {
    const db = testDb();
    assert.equal(upsertPost(db, { id: "", author: { secUid: "x" } }), false);
    assert.equal(upsertPost(db, { id: "y", author: {} }), false);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM posts").get() as any).n, 0);
    db.close();
  });

  it("keeps a follower count it already had when a later payload omits it", () => {
    const db = testDb();
    upsertPost(db, item({ id: "a", handle: "acct", followers: 12_345 }));
    upsertPost(db, item({ id: "b", handle: "acct", followers: null }));
    const acct = db.prepare("SELECT followers FROM accounts WHERE sec_uid='sec_acct'").get() as any;
    assert.equal(acct.followers, 12_345);
    db.close();
  });
});

/**
 * Runs exist because an unscoped library mixes niches. A report that argues about one
 * subject while showing evidence from another is the exact failure this prevents.
 */
describe("run scoping", () => {
  it("builds no SQL clause when nothing is scoped", () => {
    assert.deepEqual(runScope(null), { sql: "", params: [] });
    assert.deepEqual(runScope(undefined), { sql: "", params: [] });
  });

  it("builds a parameterised clause when scoped", () => {
    const s = runScope("run_abc");
    assert.ok(s.sql.length > 0);
    assert.deepEqual(s.params, ["run_abc"]);
    assert.ok(!s.sql.includes("run_abc"), "the id goes in params, never interpolated into SQL");
  });

  it("tracks which run is current", () => {
    const db = testDb();
    assert.equal(currentRun(db), null);
    const a = startRun(db, "Looksmaxxing", "an app");
    assert.equal(currentRun(db), a);
    const b = startRun(db, "Habit trackers", "another app");
    assert.equal(currentRun(db), b, "starting a run makes it current");
    setCurrentRun(db, a);
    assert.equal(currentRun(db), a);
    assert.equal(listRuns(db).length, 2);
    db.close();
  });

  it("keeps one run's accounts out of another run's results", () => {
    const db = testDb();
    const looks = startRun(db, "Looksmaxxing");
    seed(
      db,
      [
        { id: "L1", handle: "glowup", daysOld: 3 },
        { id: "L2", handle: "glowup", daysOld: 10 },
      ],
      "batch_looks",
    );

    const habits = startRun(db, "Habit trackers");
    seed(
      db,
      [
        { id: "H1", handle: "studytok", daysOld: 3 },
        { id: "H2", handle: "studytok", daysOld: 10 },
      ],
      "batch_habits",
    );

    assert.deepEqual(
      accountRows(db, { runId: looks }).map((r) => r.handle),
      ["glowup"],
    );
    assert.deepEqual(
      accountRows(db, { runId: habits }).map((r) => r.handle),
      ["studytok"],
    );
    assert.equal(accountRows(db, { limit: 10 }).length, 2, "unscoped still sees the whole library");
    db.close();
  });

  it("refuses to collect with no run, since unscoped collection mixes every niche", () => {
    const db = testDb();
    // The dangerous part isn't just lost provenance: with no run, currentRun() returns null
    // and every scoped query reads null as "search everything", so tomorrow's motorcycle
    // question would quietly include today's dogs.
    assert.throws(() => requireRun(db), /No research run is active/);
    const id = startRun(db, "Puppy training app", "a training tracker");
    assert.equal(requireRun(db), id);
    db.close();
  });

  it("scopes ranked posts to a run, so one niche cannot show up as another's evidence", () => {
    const db = testDb();
    const looks = startRun(db, "Looksmaxxing");
    seed(db, [{ id: "L1", handle: "glowup", views: 900_000, daysOld: 3 }], "batch_looks");

    const habits = startRun(db, "Habit trackers");
    seed(db, [{ id: "H1", handle: "studytok", views: 900_000, daysOld: 3 }], "batch_habits");

    assert.deepEqual(
      topPosts(db, { runId: looks }).map((r) => r.handle),
      ["glowup"],
    );
    assert.deepEqual(
      topPosts(db, { runId: habits }).map((r) => r.handle),
      ["studytok"],
    );
    assert.equal(topPosts(db, { runId: null }).length, 2, "opting out still sees everything");
    db.close();
  });

  it("binds batch and asset params in the order the SQL uses them", () => {
    const db = testDb();
    seed(db, [{ id: "A", handle: "one", views: 900_000, daysOld: 3 }], "batch_a");
    seed(db, [{ id: "B", handle: "two", views: 900_000, daysOld: 3 }], "batch_b");
    // excludeAssets adds a JOIN placeholder ahead of the batch placeholder. If the two
    // are bound the wrong way round this returns the other batch instead of erroring.
    assert.deepEqual(
      topPosts(db, { batchId: "batch_a", excludeAssets: ["creator_likeness"] }).map((r) => r.handle),
      [],
      "no analysed posts, so the asset filter excludes everything in the batch",
    );
    assert.deepEqual(
      topPosts(db, { batchId: "batch_a" }).map((r) => r.handle),
      ["one"],
    );
    db.close();
  });
});
