import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { libPath } from "./paths.ts";
import { isPhotoPost, slideUrls } from "../collect/payload.ts";
import { initRuns, runScope } from "./runs.ts";
import { ANALYSIS_DDL } from "../analyze/taxonomy.ts";

export const DB_PATH = libPath("swipekit.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  sec_uid     TEXT PRIMARY KEY,
  unique_id   TEXT,
  nickname    TEXT,
  followers   INTEGER,
  verified    INTEGER,
  first_seen  INTEGER,
  last_scanned INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  aweme_id    TEXT PRIMARY KEY,
  sec_uid     TEXT,
  unique_id   TEXT,
  posted_at   INTEGER,
  is_photo    INTEGER,
  slide_count INTEGER,
  caption     TEXT,
  hashtags    TEXT,
  sound_id    TEXT,
  play        INTEGER,
  digg        INTEGER,
  comment     INTEGER,
  share       INTEGER,
  collect     INTEGER,
  followers   INTEGER,   -- author followers AT FETCH TIME; vpf is meaningless without it
  slide_urls  TEXT,
  fetched_at  INTEGER
);

CREATE TABLE IF NOT EXISTS batches (
  id       TEXT PRIMARY KEY,
  kind     TEXT,
  query    TEXT,
  ran_at   INTEGER,
  scanned  INTEGER,
  slideshows INTEGER,
  run_id   TEXT
);

CREATE TABLE IF NOT EXISTS batch_posts (
  batch_id TEXT, aweme_id TEXT, PRIMARY KEY (batch_id, aweme_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(sec_uid);
CREATE INDEX IF NOT EXISTS idx_posts_photo   ON posts(is_photo, play DESC);
CREATE INDEX IF NOT EXISTS idx_posts_sound   ON posts(sound_id);

CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(
  aweme_id UNINDEXED, caption, hashtags, unique_id
);
`;

export function open(path = DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(resolve(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  // Every client that speaks stdio gets its own process and therefore its own handle on this
  // file. WAL lets them all read while one writes, but two writers still collide, and the
  // default behaviour is to throw SQLITE_BUSY instantly rather than wait. Five seconds is
  // far longer than any write here takes, so a collision becomes a pause nobody notices
  // instead of a failed tool call in the middle of someone's research.
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(SCHEMA);
  // The analyses table used to be created lazily by whatever first wrote to it, so a
  // library that had never analysed a post crashed on any query that reads it
  // (`top --exclude-assets` on a fresh install). Schema belongs here, once.
  db.exec(ANALYSIS_DDL);
  initRuns(db);
  return db;
}

const hashtagsOf = (item: any): string =>
  (item?.textExtra ?? [])
    .map((t: any) => t?.hashtagName)
    .filter(Boolean)
    .join(" ");

/** Idempotent: re-harvesting the same post refreshes its stats rather than duplicating it. */
export function upsertPost(db: DatabaseSync, item: any, batchId?: string): boolean {
  const id = String(item?.id ?? "");
  const secUid = item?.author?.secUid;
  if (!id || !secUid) return false;

  const now = Date.now();
  const photo = isPhotoPost(item);
  const urls = photo ? slideUrls(item) : [];
  const followers = item?.authorStats?.followerCount ?? null;

  db.prepare(
    `INSERT INTO accounts (sec_uid, unique_id, nickname, followers, verified, first_seen, last_scanned)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(sec_uid) DO UPDATE SET
       followers = COALESCE(excluded.followers, accounts.followers),
       unique_id = excluded.unique_id,
       last_scanned = excluded.last_scanned`,
  ).run(
    secUid,
    item.author.uniqueId ?? null,
    item.author.nickname ?? null,
    followers,
    item.author.verified ? 1 : 0,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO posts (aweme_id, sec_uid, unique_id, posted_at, is_photo, slide_count,
                        caption, hashtags, sound_id, play, digg, comment, share, collect,
                        followers, slide_urls, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(aweme_id) DO UPDATE SET
       play=excluded.play, digg=excluded.digg, comment=excluded.comment,
       share=excluded.share, collect=excluded.collect, followers=excluded.followers,
       slide_urls=excluded.slide_urls, fetched_at=excluded.fetched_at`,
  ).run(
    id,
    secUid,
    item.author.uniqueId ?? null,
    (item.createTime ?? 0) * 1000,
    photo ? 1 : 0,
    urls.length,
    item.desc ?? "",
    hashtagsOf(item),
    item?.music?.id ? String(item.music.id) : null,
    item?.stats?.playCount ?? 0,
    item?.stats?.diggCount ?? 0,
    item?.stats?.commentCount ?? 0,
    item?.stats?.shareCount ?? 0,
    item?.stats?.collectCount ?? 0,
    followers,
    JSON.stringify(urls),
    now,
  );

  db.prepare(`DELETE FROM post_fts WHERE aweme_id = ?`).run(id);
  db.prepare(`INSERT INTO post_fts (aweme_id, caption, hashtags, unique_id) VALUES (?,?,?,?)`).run(
    id,
    item.desc ?? "",
    hashtagsOf(item),
    item.author.uniqueId ?? "",
  );

  if (batchId) {
    db.prepare(`INSERT OR IGNORE INTO batch_posts (batch_id, aweme_id) VALUES (?,?)`).run(batchId, id);
  }
  return photo;
}

export function recordBatch(
  db: DatabaseSync,
  b: { id: string; kind: string; query: string; scanned: number; slideshows: number },
) {
  // Attribute every pull to the current run so reports can be scoped to one question.
  const runId =
    (db.prepare(`SELECT value FROM settings WHERE key='current_run'`).get() as any)?.value ?? null;
  db.prepare(
    `INSERT OR REPLACE INTO batches (id, kind, query, ran_at, scanned, slideshows, run_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(b.id, b.kind, b.query, Date.now(), b.scanned, b.slideshows, runId);
}

/** Posts we already have for an account — lets us skip re-scanning and compute medians. */
export function accountPostCount(db: DatabaseSync, secUid: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM posts WHERE sec_uid = ?`).get(secUid) as any)?.n ?? 0;
}

export type SearchHit = {
  uniqueId: string;
  awemeId: string;
  views: number;
  saves: number;
  followers: number | null;
  slides: number;
  hook: string;
};

/**
 * Full-text search over captions/hashtags/handles already collected — no browsing, no
 * network, milliseconds. This is the "ask about an account twice, run it once" half of the
 * tool: before scraping a topic, check whether it is already sitting in the library.
 */
export function searchLibrary(
  db: DatabaseSync,
  query: string,
  limit = 15,
  runId?: string | null,
): SearchHit[] {
  // Unscoped, searching "puppy" while researching motorcycles returns the dog account
  // collected last week. Measured, not hypothetical.
  const scope = runScope(runId);
  const rows = db
    .prepare(
      `SELECT p.unique_id uniqueId, p.aweme_id awemeId, p.play views, p.collect saves,
              p.followers, p.slide_count slides, substr(p.caption,1,160) hook
       FROM post_fts f JOIN posts p ON p.aweme_id = f.aweme_id
       WHERE post_fts MATCH ? AND p.is_photo = 1 ${scope.sql}
       ORDER BY p.play DESC LIMIT ?`,
    )
    .all(query, ...scope.params, limit) as any[] as SearchHit[];
  // The caption is grabbed wide, then clipped at a word so it does not end mid-hashtag.
  for (const r of rows) r.hook = clip(r.hook, 90);
  return rows;
}

/** Cut to at most `max` chars, on a space where possible, with a trailing ellipsis. */
function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
