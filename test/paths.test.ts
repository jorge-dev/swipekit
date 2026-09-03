import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { describe, it } from "node:test";
import { docPath } from "../src/store/paths.ts";

describe("docPath names a document after the run it covers", () => {
  it("puts a run's report in reports/ under a dated, slugged name", () => {
    const p = docPath("report", "Period / cycle tracking app — EU demand");
    assert.equal(basename(dirname(p)), "reports");
    assert.match(basename(p), /^\d{4}-\d{2}-\d{2}-report-period-cycle-tracking-app-eu-demand\.html$/);
  });

  it("keeps two runs' reports apart, which is the whole point", () => {
    const a = docPath("report", "Room reset — TidySprint");
    const b = docPath("report", "Period tracker — EU");
    assert.notEqual(a, b);
  });

  it("distinguishes a plan from a report for the same run", () => {
    const run = "kids routines & parenting timer apps (TickTod)";
    assert.notEqual(docPath("plan", run), docPath("report", run));
  });

  it("folds diacritics to letters rather than dropping them", () => {
    assert.match(basename(docPath("report", "cykl miesiączkowy")), /cykl-miesiaczkowy/);
  });

  it("falls back to the flat filename when there is no run to name it after", () => {
    // An unscoped report covers the whole library, so there is only ever one of them.
    assert.equal(basename(docPath("report", null)), "report.html");
    assert.equal(basename(docPath("plan", undefined)), "plan.html");
  });

  it("survives a label that slugs to nothing", () => {
    assert.match(basename(docPath("report", "—— ///")), /-report-untitled\.html$/);
  });
});
