import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * A run is one research question — a niche, a brief, one sitting.
 *
 * Without this the library is a single undifferentiated pile, and a report ends up arguing
 * about one product while showing evidence from an unrelated niche. Everything that pulls
 * data (searches, sound pulls, account scans) belongs to a run, so a report or playbook can
 * be scoped to the question it answers.
 *
 * Posts themselves stay global and deduplicated — the same post can be evidence in several
 * runs. `batch_posts` is what ties them to one.
 */
export const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, label TEXT, brief TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

export function initRuns(db: DatabaseSync) {
  db.exec(RUNS_DDL);
  // batches and playbooks predate runs; add the column if it isn't there yet.
  for (const t of ["batches", "playbooks"]) {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN run_id TEXT`);
    } catch {
      /* already present, or the table doesn't exist yet */
    }
  }
}

export function startRun(db: DatabaseSync, label: string, brief = ""): string {
  initRuns(db);
  // Timestamp alone collides when two runs start inside the same millisecond, which a
  // script does easily, and the collision surfaced as a raw UNIQUE constraint error.
  const id = `run_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  db.prepare(`INSERT INTO runs VALUES (?,?,?,?)`).run(id, label, brief, Date.now());
  db.prepare(`INSERT OR REPLACE INTO settings VALUES ('current_run', ?)`).run(id);
  return id;
}

export function currentRun(db: DatabaseSync): string | null {
  initRuns(db);
  return (db.prepare(`SELECT value FROM settings WHERE key='current_run'`).get() as any)?.value ?? null;
}

/**
 * Every collecting tool calls this before writing anything to the library.
 *
 * Without a run, collected posts land with run_id = null and — worse — `currentRun`
 * returns null, which every scoped query reads as "no filter, search everything". So a
 * library with no run doesn't just lose provenance, it actively mixes niches: ask about
 * dogs today and motorcycles tomorrow, and tomorrow's answer quietly includes today's
 * dogs. That is the exact leak runs exist to prevent, so collecting without one is
 * refused rather than merely discouraged.
 *
 * Throws with instructions aimed at the agent rather than eliciting input over MCP:
 * elicitation requires the client to declare support for it, and this has to behave the
 * same in Claude Code, Codex and Cursor. The agent is already talking to the user; asking
 * is its job, not the server's.
 */
export function requireRun(db: DatabaseSync): string {
  const run = currentRun(db);
  if (run) return run;
  throw new Error(
    "No research run is active, and collecting without one would mix this niche into " +
      "every other question the library has ever been asked.\n\n" +
      "Ask the user what they're building before collecting: the product or app name, and " +
      "one line on what it does and who it's for. That's what makes the recommendation " +
      "specific to them instead of generic advice. If they'd rather not say, that's fine — " +
      "name the run after the topic they asked about and leave the brief empty.\n\n" +
      "Then call start_run with a label and brief, and retry this.",
  );
}

export function setCurrentRun(db: DatabaseSync, runId: string) {
  initRuns(db);
  db.prepare(`INSERT OR REPLACE INTO settings VALUES ('current_run', ?)`).run(runId);
}

export function listRuns(db: DatabaseSync) {
  initRuns(db);
  const cur = currentRun(db);
  return (
    db
      .prepare(
        `SELECT r.id, r.label, r.brief, r.created_at,
                (SELECT COUNT(*) FROM batches b WHERE b.run_id = r.id) batches,
                (SELECT COUNT(DISTINCT bp.aweme_id) FROM batches b
                   JOIN batch_posts bp ON bp.batch_id = b.id WHERE b.run_id = r.id) posts
         FROM runs r ORDER BY r.created_at DESC`,
      )
      .all() as any[]
  ).map((r) => ({ ...r, current: r.id === cur }));
}

export function getRun(db: DatabaseSync, runId: string) {
  initRuns(db);
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as any;
}

/**
 * SQL fragment restricting posts to a run. Returns null when unscoped, so callers can keep
 * one query shape for both cases.
 */
export function runScope(runId: string | null | undefined): { sql: string; params: any[] } {
  if (!runId) return { sql: "", params: [] };
  return {
    sql: ` AND p.aweme_id IN (
             SELECT bp.aweme_id FROM batch_posts bp
             JOIN batches b ON b.id = bp.batch_id WHERE b.run_id = ?)`,
    params: [runId],
  };
}

/**
 * What we already know about a handle or keyword, before deciding to browse.
 *
 * "Library first" only holds if a caller can actually check what's already covered — without
 * this, discover/scan_account tool descriptions say "check the library" but there was no tool
 * that could answer "have I already researched this?" across runs.
 */
export function findPriorResearch(db: DatabaseSync, opts: { handle?: string; keyword?: string }) {
  initRuns(db);
  const out: {
    accountCoverage: {
      handle: string;
      runId: string | null;
      runLabel: string | null;
      postsHeld: number;
      lastFetched: string | null;
    }[];
    relatedRuns: {
      runId: string;
      label: string;
      brief: string;
      matchingBatches: number;
      createdAt: string;
    }[];
  } = { accountCoverage: [], relatedRuns: [] };

  if (opts.handle) {
    const clean = opts.handle.replace(/^@/, "");
    out.accountCoverage = (
      db
        .prepare(
          `SELECT p.unique_id handle, b.run_id runId, r.label runLabel,
                  COUNT(*) postsHeld, MAX(p.fetched_at) lastFetched
           FROM posts p
           LEFT JOIN batch_posts bp ON bp.aweme_id = p.aweme_id
           LEFT JOIN batches b ON b.id = bp.batch_id
           LEFT JOIN runs r ON r.id = b.run_id
           WHERE p.unique_id = ?
           GROUP BY b.run_id`,
        )
        .all(clean) as any[]
    ).map((r) => ({
      handle: r.handle,
      runId: r.runId,
      runLabel: r.runLabel,
      postsHeld: r.postsHeld,
      lastFetched: r.lastFetched ? new Date(r.lastFetched).toISOString() : null,
    }));
  }

  if (opts.keyword) {
    out.relatedRuns = (
      db
        .prepare(
          `SELECT r.id runId, r.label, r.brief, r.created_at createdAt,
                  COUNT(DISTINCT b.id) matchingBatches
           FROM runs r JOIN batches b ON b.run_id = r.id
           WHERE r.label LIKE ? OR r.brief LIKE ? OR b.query LIKE ?
           GROUP BY r.id ORDER BY r.created_at DESC`,
        )
        .all(`%${opts.keyword}%`, `%${opts.keyword}%`, `%${opts.keyword}%`) as any[]
    ).map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
  }

  return out;
}
