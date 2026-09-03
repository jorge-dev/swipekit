import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountRows } from "../src/analyze/accounts.ts";
import { evidencePack } from "../src/analyze/playbook.ts";
import { formatRollup } from "../src/analyze/taxonomy.ts";
import { topPosts } from "../src/collect/discover.ts";
import { soundCandidates } from "../src/collect/sound.ts";
import { searchLibrary } from "../src/store/db.ts";
import { startRun } from "../src/store/runs.ts";
import { saveAnalyses } from "../src/output/slides.ts";
import { seed, testDb } from "./helpers.ts";

/**
 * The promise runs exist to keep: research one niche today and another tomorrow, and
 * tomorrow's answer must not quietly contain today's data.
 *
 * Every read surface an agent can reach gets checked against the same two-run library, so
 * a newly added surface that forgets to scope shows up here rather than in someone's
 * report. "Dogs" and "motorcycles" are deliberately unrelated: any overlap is a leak, not
 * a judgement call about relevance.
 */
function twoNiches() {
  const db = testDb();

  const dogs = startRun(db, "Puppy training app", "an app for new puppy owners");
  seed(
    db,
    [
      {
        id: "D1",
        handle: "puppyguide",
        caption: "puppy potty training in 7 days",
        sound: "dog_sound",
        daysOld: 3,
      },
      {
        id: "D2",
        handle: "puppyguide",
        caption: "crate training your puppy",
        sound: "dog_sound",
        daysOld: 9,
      },
      { id: "D3", handle: "dogdaily", caption: "puppy leash tips", sound: "dog_sound", daysOld: 5 },
    ],
    "batch_dogs",
  );

  const motos = startRun(db, "Motorcycle gear app", "an app for riders");
  seed(
    db,
    [
      {
        id: "M1",
        handle: "ridergear",
        caption: "motorcycle helmet safety guide",
        sound: "moto_sound",
        daysOld: 3,
      },
      { id: "M2", handle: "ridergear", caption: "best motorcycle gloves", sound: "moto_sound", daysOld: 9 },
      {
        id: "M3",
        handle: "motodaily",
        caption: "motorcycle chain maintenance",
        sound: "moto_sound",
        daysOld: 5,
      },
    ],
    "batch_motos",
  );

  return { db, dogs, motos };
}

const dogHandles = ["puppyguide", "dogdaily"];
const motoHandles = ["ridergear", "motodaily"];

describe("run scoping keeps niches apart", () => {
  it("find_accounts returns only the scoped run's accounts", () => {
    const { db, dogs, motos } = twoNiches();
    const inDogs = accountRows(db, { runId: dogs, limit: 50 }).map((r) => r.handle);
    const inMotos = accountRows(db, { runId: motos, limit: 50 }).map((r) => r.handle);
    assert.ok(inDogs.length > 0, "the dogs run should return something at all");
    assert.deepEqual(
      inDogs.filter((h) => motoHandles.includes(h)),
      [],
      "motorcycles leaked into dogs",
    );
    assert.deepEqual(
      inMotos.filter((h) => dogHandles.includes(h)),
      [],
      "dogs leaked into motorcycles",
    );
    db.close();
  });

  it("top_posts returns only the scoped run's posts", () => {
    const { db, dogs, motos } = twoNiches();
    const inDogs = topPosts(db, { runId: dogs, minViews: 0, limit: 50 }).map((r) => r.handle);
    const inMotos = topPosts(db, { runId: motos, minViews: 0, limit: 50 }).map((r) => r.handle);
    assert.ok(inDogs.length > 0);
    assert.deepEqual(
      inDogs.filter((h) => motoHandles.includes(h)),
      [],
    );
    assert.deepEqual(
      inMotos.filter((h) => dogHandles.includes(h)),
      [],
    );
    db.close();
  });

  it("search_library only matches inside the scoped run", () => {
    const { db, dogs } = twoNiches();
    // "motorcycle" exists in the library, but not in this run, so scoping must exclude it.
    const hits = searchLibrary(db, "motorcycle", 50, dogs).map((r) => r.uniqueId);
    assert.deepEqual(hits, [], "a term from another niche returned rows inside this run");
    db.close();
  });

  it("sound_candidates only reports sounds from the scoped run", () => {
    const { db, dogs } = twoNiches();
    const sounds = soundCandidates(db, 50, dogs).map((s) => s.soundId);
    assert.ok(!sounds.includes("moto_sound"), "another run's sound was offered as a candidate");
    db.close();
  });

  it("format_rollup only counts analyses from the scoped run", () => {
    const { db, dogs } = twoNiches();
    const analysis = (awemeId: string) => ({
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
      reusableTemplate: ["a", "b"],
    });
    // Two accounts per niche, so each niche alone clears the "more than one account" bar.
    saveAnalyses(db, [analysis("D1"), analysis("D3"), analysis("M1"), analysis("M3")] as any);

    const rolled = formatRollup(db, { runId: dogs });
    const accounts = (rolled.byHookType as any[]).reduce((n, r) => n + r.accounts, 0);
    assert.equal(accounts, 2, "rollup counted accounts from the other run");
    db.close();
  });

  it("evidence_pack draws only on the scoped run", () => {
    const { db, dogs } = twoNiches();
    const pack = evidencePack(db, { runId: dogs }) as any;
    const blob = JSON.stringify(pack);
    for (const h of motoHandles) {
      assert.ok(!blob.includes(h), `evidence pack mentioned ${h} from another run`);
    }
    db.close();
  });
});

describe("formatRollup asset demand", () => {
  const analysis = (awemeId: string, assetsNeeded: string[]) => ({
    awemeId,
    hookText: "hook",
    hookType: "list_promise",
    structure: "listicle",
    emotionalAngle: "aspiration",
    ctaStyle: "none",
    visualStyle: "text_over_photo",
    assetsNeeded,
    requiresOwnLikeness: false,
    requiresSpecificSubject: false,
    productionNotes: "",
    textDensity: "medium",
    reusableTemplate: ["a", "b"],
  });

  it("counts how many formats need each input, instead of echoing the stored JSON back", () => {
    const db = testDb();
    seed(db, [
      { id: "p1", handle: "one" },
      { id: "p2", handle: "one" },
      { id: "p3", handle: "two" },
      { id: "p4", handle: "two" },
    ]);
    saveAnalyses(db, [
      analysis("p1", ["generic_imagery"]),
      analysis("p2", ["generic_imagery", "design_tool"]),
      analysis("p3", ["generic_imagery"]),
      analysis("p4", ["creator_likeness"]),
    ] as any);

    // The question this answers is "how many of these need a camera pointed at me?" —
    // which a list of raw ["generic_imagery"] strings left the caller to tally by hand.
    assert.deepEqual(formatRollup(db).assetDemand, [
      { asset: "generic_imagery", posts: 3 },
      { asset: "design_tool", posts: 1 },
      { asset: "creator_likeness", posts: 1 },
    ]);
    db.close();
  });
});
