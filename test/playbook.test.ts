import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { savePlaybook } from "../src/analyze/playbook.ts";
import { ANALYSIS_DDL } from "../src/analyze/taxonomy.ts";
import { seed, testDb } from "./helpers.ts";

const pb = (overrides: Partial<any> = {}) => ({
  brief: "a test product",
  verdict: "Enter the lane.",
  patterns: [
    {
      name: "A pattern",
      hookType: "tutorial_promise",
      structure: "listicle",
      evidence: "3 accounts, 3 posts, 100k-900k views",
      whyItWorks: "it works",
      adaptation: "do this",
      slideSkeleton: ["slide 1", "slide 2"],
      assetsNeeded: ["generic_imagery"],
      confidence: "strong" as const,
    },
  ],
  avoid: [],
  nextSteps: [],
  gaps: [],
  ...overrides,
});

/**
 * write_playbook was silently satisfiable with zero evidence: an agent could answer a
 * "write me a playbook" request in prose alone and never call the tool, and nothing forced
 * the difference between a playbook grounded in read posts and one that wasn't. This is
 * the guard that closes it — pinned here because it is pure logic with no browser involved,
 * unlike the session-lifecycle fixes that had to be verified by hand instead.
 */
describe("savePlaybook refuses to save ungrounded evidence", () => {
  it("refuses when nothing in the run has been read yet", () => {
    const db = testDb();
    seed(db, [{ id: "a", handle: "someone", daysOld: 3 }]);
    assert.throws(() => savePlaybook(db, pb()), /no posts in this run have been read/);
    db.close();
  });

  it("saves once at least one post has a real analysis behind it", () => {
    const db = testDb();
    seed(db, [{ id: "a", handle: "someone", daysOld: 3 }]);
    db.exec(ANALYSIS_DDL);
    db.prepare(`INSERT INTO analyses (aweme_id, hook_text, analyzed_at) VALUES (?,?,?)`).run(
      "a",
      "a real hook",
      Date.now(),
    );
    const id = savePlaybook(db, pb());
    assert.match(id, /^pb_/);
    db.close();
  });

  it("scopes the check to the run, so another run's analysed posts don't count", () => {
    const db = testDb();
    seed(db, [{ id: "other-run-post", handle: "elsewhere", daysOld: 3 }]);
    db.exec(ANALYSIS_DDL);
    db.prepare(`INSERT INTO analyses (aweme_id, hook_text, analyzed_at) VALUES (?,?,?)`).run(
      "other-run-post",
      "a real hook",
      Date.now(),
    );
    assert.throws(() => savePlaybook(db, pb(), "run_this_one_has_nothing"), /no posts in this run/);
    db.close();
  });
});
