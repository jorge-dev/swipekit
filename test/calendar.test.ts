import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestPlan, savePlan, schedule } from "../src/analyze/calendar.ts";
import { startRun } from "../src/store/runs.ts";
import { seed, testDb } from "./helpers.ts";
import { saveAnalyses } from "../src/output/slides.ts";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    pattern: "P",
    topic: `topic ${i + 1}`,
    slides: [{ text: "slide one" }],
    sourceAwemeIds: ["D1"],
  }));

/** savePlan refuses entries citing posts nobody read, so tests that reach it need one. */
function withAnalysis(db: any, awemeId: string) {
  seed(db, [{ id: awemeId, handle: "src", daysOld: 5 }], "batch_src");
  saveAnalyses(db, [
    {
      awemeId,
      hookText: "hook",
      hookType: "list_promise",
      structure: "listicle",
      emotionalAngle: "aspiration",
      ctaStyle: "none",
      visualStyle: "text_over_photo",
      assetsNeeded: ["design_tool"],
      requiresOwnLikeness: false,
      requiresSpecificSubject: false,
      productionNotes: "",
      textDensity: "medium",
      reusableTemplate: ["a"],
    },
  ] as any);
}

describe("schedule", () => {
  it("spreads posts across the week instead of stacking them", () => {
    const s = schedule(entries(5), { startsOn: "2026-09-01", postsPerWeek: 5 });
    // 5 a week over 7 days is roughly every other day, not five days in a row.
    assert.deepEqual(
      s.map((e) => e.date),
      ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-07"],
    );
  });

  it("does not accumulate drift on a fractional cadence", () => {
    // 2.5/wk over 20 posts is 8 weeks. Adding a rounded gap each time would drift days.
    const s = schedule(entries(20), { startsOn: "2026-09-01", postsPerWeek: 2.5 });
    const days = (Date.parse(s.at(-1)!.date) - Date.parse(s[0]!.date)) / 86_400_000;
    assert.equal(days, 53, "last post should land 19 gaps of 2.8 days out, not a drifted total");
  });

  it("numbers weeks from the start date", () => {
    const s = schedule(entries(10), { startsOn: "2026-09-01", postsPerWeek: 5 });
    assert.equal(s[0]!.week, 1);
    assert.equal(s.at(-1)!.week, 2);
  });

  it("names the weekday, since posting day is part of a plan", () => {
    const s = schedule(entries(1), { startsOn: "2026-09-01", postsPerWeek: 5 });
    assert.equal(s[0]!.weekday, "Tuesday");
  });

  it("keeps every entry, in order, and never double-books a date", () => {
    const s = schedule(entries(20), { startsOn: "2026-09-01", postsPerWeek: 5 });
    assert.equal(s.length, 20);
    assert.deepEqual(
      s.map((e) => e.topic),
      entries(20).map((e) => e.topic),
    );
    assert.equal(new Set(s.map((e) => e.date)).size, 20, "two posts landed on the same day");
  });

  it("defaults to 5 a week rather than throwing", () => {
    assert.equal(schedule(entries(5), { startsOn: "2026-09-01" }).length, 5);
    assert.equal(schedule(entries(5), { startsOn: "2026-09-01", postsPerWeek: 0 })[1]!.date, "2026-09-02");
  });

  it("stacks several posts on one day when postsPerDay is set", () => {
    const s = schedule(entries(6), { startsOn: "2026-09-01", postsPerDay: 3 });
    assert.deepEqual(
      s.map((e) => e.date),
      ["2026-09-01", "2026-09-01", "2026-09-01", "2026-09-02", "2026-09-02", "2026-09-02"],
    );
    assert.deepEqual(
      s.map((e) => e.day),
      [1, 1, 1, 2, 2, 2],
    );
  });

  it("numbers days from 1 so the document matches the prose", () => {
    const s = schedule(entries(3), { startsOn: "2026-09-01", postsPerWeek: 7 });
    assert.deepEqual(
      s.map((e) => e.day),
      [1, 2, 3],
    );
  });

  it("rejects a start date it cannot parse instead of scheduling into 1970", () => {
    assert.throws(() => schedule(entries(1), { startsOn: "next tuesday" }), /not a date/);
  });
});

describe("savePlan", () => {
  it("stores a plan against its run and reads it back scheduled", () => {
    const db = testDb();
    const run = startRun(db, "Ab workout app", "no-equipment ab app");
    withAnalysis(db, "S1");
    const { id } = savePlan(db, {
      entries: [
        {
          pattern: "Contrarian correction",
          topic: "sit-ups",
          slides: [
            { text: "STOP DOING SIT-UPS", imagePrompt: "flat pale blue, bold black condensed type" },
            { text: "Do this instead" },
          ],
          caption: "Save this.",
          sourceAwemeIds: ["S1"],
        },
        {
          pattern: "Timed system",
          topic: "10 minute core",
          slides: [{ text: "ABS IN 10" }],
          sourceAwemeIds: ["S1"],
        },
      ],
      runId: run,
      startsOn: "2026-09-01",
      postsPerWeek: 5,
    });
    const back = latestPlan(db, run)!;
    assert.equal(back.id, id);
    assert.equal(back.entries.length, 2);
    assert.equal(back.entries[0]!.date, "2026-09-01");
    assert.equal(back.entries[0]!.slides[0]!.text, "STOP DOING SIT-UPS");
    assert.equal(back.entries[0]!.slides[0]!.imagePrompt, "flat pale blue, bold black condensed type");
    assert.equal(back.entries[0]!.caption, "Save this.");
    db.close();
  });

  it("keeps one run's plan out of another's", () => {
    const db = testDb();
    const a = startRun(db, "Dogs", "");
    withAnalysis(db, "S1");
    savePlan(db, {
      entries: [{ pattern: "P", topic: "puppy crate", slides: [{ text: "x" }], sourceAwemeIds: ["S1"] }],
      runId: a,
      startsOn: "2026-09-01",
    });
    const b = startRun(db, "Motorcycles", "");
    assert.equal(latestPlan(db, b), null, "another run's plan showed up");
    assert.equal(latestPlan(db, a)!.entries[0]!.topic, "puppy crate");
    db.close();
  });

  it("refuses an empty plan", () => {
    const db = testDb();
    assert.throws(() => savePlan(db, { entries: [] }), /at least one entry/);
    db.close();
  });

  it("refuses a plan modelled on posts nobody read", () => {
    const db = testDb();
    // "S9" was never analysed, so there is nothing to have modelled this on.
    assert.throws(
      () =>
        savePlan(db, {
          entries: [{ pattern: "P", topic: "guess", slides: [{ text: "x" }], sourceAwemeIds: ["S9"] }],
        }),
      /have not been read slide by slide/,
    );
    db.close();
  });

  it("refuses a plan that cites nothing at all", () => {
    const db = testDb();
    assert.throws(
      () =>
        savePlan(db, {
          entries: [{ pattern: "P", topic: "guess", slides: [{ text: "x" }], sourceAwemeIds: [] }],
        }),
      /needs sourceAwemeIds/,
    );
    db.close();
  });
});
