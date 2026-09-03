import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runScope } from "../store/runs.ts";

/**
 * The synthesis layer.
 *
 * Collecting and ranking posts is the easy half. The half that's worth anything is
 * "given everything we know, what should I actually make?" — and that is reasoning over the
 * library, not another query. So: `evidencePack` assembles what we know into something small
 * enough to reason about, the calling agent writes the playbook, and `savePlaybook` stores it
 * so the report can lead with it.
 *
 * Library first. Every question is answered from the database, and only when coverage is
 * genuinely thin do we go back to TikTok — `coverage` says plainly which case we're in.
 */

export const PatternSchema = z.object({
  name: z.string().describe("Short human name for the pattern, e.g. 'Quantified flaw list'"),
  hookType: z.string(),
  structure: z.string(),
  evidence: z.string().describe("The numbers backing it: accounts, posts, view range"),
  whyItWorks: z.string().describe("The mechanism, one or two sentences"),
  adaptation: z.string().describe("How to apply it to the brief specifically — concrete, not generic"),
  slideSkeleton: z.array(z.string()).describe("Slide-by-slide, already rewritten for the brief"),
  assetsNeeded: z.array(z.string()),
  confidence: z.enum(["strong", "moderate", "thin"]).describe("Grounded in how many unrelated accounts"),
});

export const PlaybookSchema = z.object({
  brief: z.string().describe("What the caller said they're building, in their words"),
  verdict: z.string().describe("Lead paragraph: is this lane worth it, and what's the single takeaway"),
  patterns: z.array(PatternSchema).min(1),
  avoid: z.array(z.string()).default([]).describe("Patterns that perform but don't fit the brief, and why"),
  nextSteps: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]).describe("What the library can't answer yet"),
});

export type Playbook = z.infer<typeof PlaybookSchema>;

export const PLAYBOOK_DDL = `
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY, brief TEXT, verdict TEXT, patterns TEXT,
  avoid TEXT, next_steps TEXT, gaps TEXT, created_at INTEGER, run_id TEXT
);`;

/**
 * Everything needed to write a playbook, small enough to reason over: which formats recur
 * across unrelated accounts, the templates behind them, and an honest coverage read.
 */
export function evidencePack(db: DatabaseSync, opts: { minAccounts?: number; runId?: string | null } = {}) {
  db.exec(PLAYBOOK_DDL);
  const minAccounts = opts.minAccounts ?? 2;
  const scope = runScope(opts.runId);
  const all = (s: string, ...p: any[]) => db.prepare(s).all(...p) as any[];
  const one = (s: string, ...p: any[]) => db.prepare(s).get(...p) as any;

  // Group by hook type, not (hook, structure). The pair is too specific to clear a
  // multi-account bar on a young library, and it reported "no patterns" while the hook
  // level plainly had three unrelated accounts converging.
  const patterns = all(
    `SELECT a.hook_type,
            COUNT(*) posts, COUNT(DISTINCT p.sec_uid) accounts,
            CAST(AVG(p.play) AS INT) avg_views, MAX(p.play) best_views,
            MIN(p.followers) smallest_account,
            GROUP_CONCAT(DISTINCT a.structure) structures,
            GROUP_CONCAT(DISTINCT a.emotional_angle) angles,
            GROUP_CONCAT(DISTINCT p.unique_id) handles
     FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id
     WHERE 1=1 ${scope.sql}
     GROUP BY a.hook_type
     HAVING accounts >= ?
     ORDER BY accounts DESC, avg_views DESC`,
    ...scope.params,
    minAccounts,
  );

  // Templates carry the actual instructions; cap the text so the pack stays reasonable.
  const templates = all(
    `SELECT p.unique_id, p.play, p.followers, p.slide_count,
            a.hook_text, a.hook_type, a.structure, a.emotional_angle,
            a.visual_style, a.assets_needed, a.template, a.production_notes
     FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id
     WHERE 1=1 ${scope.sql}
     ORDER BY (CAST(p.play AS REAL) / MAX(p.followers,1)) DESC LIMIT 12`,
    ...scope.params,
  ).map((r) => ({
    handle: r.unique_id,
    views: r.play,
    followers: r.followers,
    vpf: r.followers ? Math.round(r.play / r.followers) : null,
    slides: r.slide_count,
    hook: r.hook_text,
    hookType: r.hook_type,
    structure: r.structure,
    emotionalAngle: r.emotional_angle,
    visualStyle: r.visual_style,
    assetsNeeded: r.assets_needed ? JSON.parse(r.assets_needed) : [],
    skeleton: r.template ? JSON.parse(r.template) : [],
    productionNotes: r.production_notes,
  }));

  const assetCounts = new Map<string, number>();
  for (const r of all(`SELECT assets_needed FROM analyses WHERE assets_needed IS NOT NULL`)) {
    for (const a of JSON.parse(r.assets_needed || "[]")) assetCounts.set(a, (assetCounts.get(a) ?? 0) + 1);
  }

  const t = {
    posts: one("SELECT COUNT(*) n FROM posts").n,
    slideshows: one("SELECT COUNT(*) n FROM posts WHERE is_photo=1").n,
    analysed: one("SELECT COUNT(*) n FROM analyses").n,
    proven: one(
      `SELECT COUNT(DISTINCT sec_uid) n FROM posts WHERE is_photo=1 AND play>=100000 AND followers<100000`,
    ).n,
    unnamedStrong: one(
      `SELECT COUNT(*) n FROM posts p LEFT JOIN analyses a ON a.aweme_id=p.aweme_id
       WHERE p.is_photo=1 AND a.aweme_id IS NULL AND p.play>=100000 AND p.slide_count>=4`,
    ).n,
    staleDays: one(`SELECT MIN((? - posted_at)/86400000) d FROM posts WHERE is_photo=1`, Date.now())?.d,
  };

  const notes: string[] = [];
  if (t.analysed < 5)
    notes.push(`Only ${t.analysed} formats named — patterns below are provisional. Read more slides.`);
  if (!patterns.length)
    notes.push("No hook type appears across multiple accounts yet; nothing here is a validated pattern.");
  if (t.unnamedStrong > 0)
    notes.push(
      `${t.unnamedStrong} strong slideshows are still unnamed — read_slides on them before concluding.`,
    );
  if (t.proven < 5)
    notes.push(`Only ${t.proven} small accounts with a 100K+ slideshow. Thin lane; widen with discover.`);

  return {
    totals: t,
    patterns,
    templates,
    assetDemand: [...assetCounts].sort((a, b) => b[1] - a[1]).map(([asset, posts]) => ({ asset, posts })),
    coverage: {
      sufficient: t.analysed >= 5 && patterns.length > 0,
      notes,
    },
  };
}

export function savePlaybook(db: DatabaseSync, pb: Playbook, runId?: string | null): string {
  db.exec(PLAYBOOK_DDL);
  const run =
    runId ?? (db.prepare(`SELECT value FROM settings WHERE key='current_run'`).get() as any)?.value ?? null;

  // A playbook whose patterns cite no post anyone actually looked at is indistinguishable
  // from one the model made up. This is the same failure evidence_pack's coverage notes
  // warn about, made impossible to skip past silently: the write is refused, not just
  // discouraged, because nothing downstream (the report, the export) can tell the
  // difference between "grounded" and "sounded right" once it is saved.
  const scope = runScope(run);
  const analysed = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM analyses a JOIN posts p ON p.aweme_id = a.aweme_id WHERE 1=1 ${scope.sql}`,
      )
      .get(...scope.params) as any
  ).n;
  if (analysed === 0) {
    throw new Error(
      "Can't save a playbook: no posts in this run have been read yet, so there is nothing " +
        "real behind it. Call read_slides on the top few posts, then save_analysis for each, " +
        "then write_playbook again.",
    );
  }

  const id = `pb_${Date.now().toString(36)}`;
  db.prepare(
    `INSERT INTO playbooks (id, brief, verdict, patterns, avoid, next_steps, gaps, created_at, run_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    pb.brief,
    pb.verdict,
    JSON.stringify(pb.patterns),
    JSON.stringify(pb.avoid ?? []),
    JSON.stringify(pb.nextSteps ?? []),
    JSON.stringify(pb.gaps ?? []),
    Date.now(),
    run,
  );
  return id;
}

/** Scoped to a run when given one — a report must not lead with another question's answer. */
function rowToPlaybook(r: any): Playbook & { id: string; runId: string | null; createdAt: number } {
  return {
    id: r.id,
    runId: r.run_id ?? null,
    brief: r.brief,
    verdict: r.verdict,
    patterns: JSON.parse(r.patterns || "[]"),
    avoid: JSON.parse(r.avoid || "[]"),
    nextSteps: JSON.parse(r.next_steps || "[]"),
    gaps: JSON.parse(r.gaps || "[]"),
    createdAt: r.created_at,
  };
}

export function latestPlaybook(
  db: DatabaseSync,
  runId?: string | null,
): (Playbook & { id: string; runId: string | null; createdAt: number }) | null {
  db.exec(PLAYBOOK_DDL);
  const r = (
    runId
      ? db.prepare(`SELECT * FROM playbooks WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId)
      : db.prepare(`SELECT * FROM playbooks ORDER BY created_at DESC LIMIT 1`).get()
  ) as any;
  return r ? rowToPlaybook(r) : null;
}

/** Once you've written playbooks for several niches, this is how you get one back without regenerating it. */
export function listPlaybooks(db: DatabaseSync, runId?: string | null) {
  db.exec(PLAYBOOK_DDL);
  const rows = (
    runId
      ? db
          .prepare(
            `SELECT id, brief, run_id, created_at FROM playbooks WHERE run_id = ? ORDER BY created_at DESC`,
          )
          .all(runId)
      : db.prepare(`SELECT id, brief, run_id, created_at FROM playbooks ORDER BY created_at DESC`).all()
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id ?? null,
    brief: String(r.brief || "").slice(0, 140),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export function getPlaybook(
  db: DatabaseSync,
  id: string,
): (Playbook & { id: string; runId: string | null; createdAt: number }) | null {
  db.exec(PLAYBOOK_DDL);
  const r = db.prepare(`SELECT * FROM playbooks WHERE id = ?`).get(id) as any;
  return r ? rowToPlaybook(r) : null;
}
