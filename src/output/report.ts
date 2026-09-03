/**
 * Build a self-contained HTML report from the library. Runs only when asked.
 *
 *   swipekit report [--posts 20] [--out report.html]
 *
 * Reads as an argument, not a data dump: the recommendation first, the patterns it rests on
 * second, the proof third, the raw library last. Someone who stops after the first screen
 * should still have the answer.
 *
 * Every account, post and sound links out to TikTok so you can go look at the real thing, and
 * every named format shows its hook plus its slide-by-slide skeleton — "what the slideshow
 * actually is" is the part worth knowing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fetchSlides } from "./slides.ts";
import { latestPlaybook } from "../analyze/playbook.ts";
import { confidenceLabel, planMarkdown, playbookMarkdown, slideBody, slugify } from "./markdown.ts";
import { latestPlan } from "../analyze/calendar.ts";
import { getRun, runScope } from "../store/runs.ts";
import { docPath, libPath } from "../store/paths.ts";

const THUMBS = libPath("thumbs");

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Turn a block of writing into readable paragraphs.
 *
 * Blank lines are honoured when the writer used them. When they didn't, we break on
 * sentence boundaries every couple of sentences instead of rendering a 120-word slab.
 * The instruction to write in paragraphs lives in the skill, but the report cannot
 * depend on it: the moment one write-up ignores it the page is a wall again, and the
 * reader is the one who pays.
 */
const paras = (text: string, per = 2) => {
  const blocks = String(text ?? "")
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const b of blocks) {
    // Split only where a sentence really ends: punctuation, then whitespace, then
    // something that starts a new one. Splitting on any period turns "0.38% save" into
    // two sentences and "@the.dog.care.guide" into four.
    const sentences = b.split(/(?<=[.!?])\s+(?=["“(@A-Z])/);
    if (sentences.length <= per + 1) {
      out.push(b);
      continue;
    }
    for (let i = 0; i < sentences.length; i += per) {
      out.push(
        sentences
          .slice(i, i + per)
          .join(" ")
          .trim(),
      );
    }
  }
  return out
    .filter(Boolean)
    .map((t) => `<p>${esc(t)}</p>`)
    .join("");
};

const DL_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2.5v8m0 0 3-3m-3 3-3-3M2.8 12.2v1.3h10.4v-1.3"/></svg>';

const COPY_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 2.5h-8v9"/></svg>';

const n = (x: number | null | undefined) =>
  x == null ? "—" : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x);

const exact = (x: number) => x.toLocaleString("en-US");
const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

const postUrl = (h: string, id: string) => `https://www.tiktok.com/@${h}/photo/${id}`;
const acctUrl = (h: string) => `https://www.tiktok.com/@${h}`;
const soundUrl = (id: string) => `https://www.tiktok.com/music/x-${id}`;

/** macOS ships sips, so thumbnails need no image dependency. */
function thumb(srcPath: string, id: string, i: number): string | null {
  mkdirSync(THUMBS, { recursive: true });
  const out = `${THUMBS}/${id}-${i}.jpg`;
  try {
    if (!existsSync(out)) execFileSync("sips", ["-Z", "300", srcPath, "--out", out], { stdio: "ignore" });
    return `data:image/jpeg;base64,${readFileSync(out).toString("base64")}`;
  } catch {
    return null;
  }
}

async function slideStrip(db: DatabaseSync, awemeId: string, max = 5): Promise<string[]> {
  const dir = libPath("posts", awemeId);
  const local: string[] = [];
  for (let i = 1; i <= max; i++) {
    const p = `${dir}/slide-${String(i).padStart(2, "0")}.jpg`;
    if (existsSync(p)) local.push(p);
  }
  if (!local.length) {
    const [got] = await fetchSlides(db, [awemeId], max);
    if (got && !got.error) {
      mkdirSync(dir, { recursive: true });
      got.images.forEach((im, k) => {
        const p = `${dir}/slide-${String(k + 1).padStart(2, "0")}.jpg`;
        writeFileSync(p, Buffer.from(im.data, "base64"));
        local.push(p);
      });
    }
  }
  return local.map((p, i) => thumb(p, awemeId, i)).filter(Boolean) as string[];
}

export async function buildReport(
  db: DatabaseSync,
  opts: { posts?: number; out?: string; runId?: string | null } = {},
): Promise<string> {
  const limit = opts.posts ?? 20;
  // Scoping is what keeps a report coherent: unscoped, it argues about one niche and shows
  // evidence from another, because the library holds every question ever asked.
  const runId = opts.runId ?? null;
  const run = runId ? getRun(db, runId) : null;
  const out = opts.out ?? docPath("report", run?.label);
  const sc = runScope(runId);
  const one = (s: string, ...p: any[]) => db.prepare(s).get(...p) as any;
  const all = (s: string, ...p: any[]) => db.prepare(s).all(...p) as any[];

  const t = {
    posts: one(`SELECT COUNT(*) n FROM posts p WHERE 1=1 ${sc.sql}`, ...sc.params).n,
    slideshows: one(`SELECT COUNT(*) n FROM posts p WHERE p.is_photo=1 ${sc.sql}`, ...sc.params).n,
    accounts: one(`SELECT COUNT(DISTINCT p.sec_uid) n FROM posts p WHERE 1=1 ${sc.sql}`, ...sc.params).n,
    batches: runId
      ? one(`SELECT COUNT(*) n FROM batches WHERE run_id = ?`, runId).n
      : one("SELECT COUNT(*) n FROM batches").n,
    analysed: one(
      `SELECT COUNT(*) n FROM analyses a JOIN posts p ON p.aweme_id=a.aweme_id WHERE 1=1 ${sc.sql}`,
      ...sc.params,
    ).n,
    proven: one(
      `SELECT COUNT(DISTINCT p.sec_uid) n FROM posts p
       WHERE p.is_photo=1 AND p.play>=100000 AND p.followers<100000 ${sc.sql}`,
      ...sc.params,
    ).n,
  };

  // Named formats first — a post you can read is worth more than one you can only rank.
  // Padding the section with unread posts produced a page that said "Format not named
  // yet" eleven times, which tells the reader nothing except that we stopped early.
  const top = all(
    `SELECT p.aweme_id, p.unique_id, p.play, p.collect, p.followers, p.slide_count,
            p.posted_at, p.caption, p.sound_id,
            a.hook_text, a.hook_type, a.structure, a.emotional_angle, a.cta_style,
            a.visual_style, a.assets_needed, a.template, a.production_notes
     FROM posts p LEFT JOIN analyses a ON a.aweme_id = p.aweme_id
     WHERE p.is_photo=1 AND p.play >= 50000 AND p.slide_count >= 3 ${sc.sql}
     ORDER BY (a.hook_text IS NULL), (CAST(p.play AS REAL) / MAX(p.followers,1)) DESC
     LIMIT ?`,
    ...sc.params,
    limit,
  ) as any[];

  // Keep every post whose slides someone actually read, then at most three unread ones as
  // a "go look at these next" tail. Beyond that the section stops being proof.
  const read = top.filter((p: any) => p.hook_text);
  const unread = top.filter((p: any) => !p.hook_text);
  const posts = read.length ? [...read, ...unread.slice(0, 3)] : unread;

  const accounts = all(
    `SELECT a.unique_id, a.followers, COUNT(p.aweme_id) posts, SUM(p.is_photo) photos,
            MAX(p.play) best, MAX(p.posted_at) newest
     FROM accounts a JOIN posts p ON p.sec_uid = a.sec_uid
     WHERE 1=1 ${sc.sql}
     GROUP BY a.sec_uid HAVING posts >= 8 ORDER BY best DESC LIMIT 15`,
    ...sc.params,
  );

  const sounds = all(
    `SELECT p.sound_id id, COUNT(*) posts, COUNT(DISTINCT p.sec_uid) accounts, MAX(p.posted_at) newest
     FROM posts p WHERE p.is_photo=1 AND p.sound_id NOT IN ('0','') ${sc.sql}
     GROUP BY p.sound_id HAVING accounts >= 2 ORDER BY accounts DESC LIMIT 8`,
    ...sc.params,
  );

  const batches = runId
    ? all(
        `SELECT kind, query, scanned, slideshows, ran_at FROM batches WHERE run_id = ? ORDER BY ran_at DESC`,
        runId,
      )
    : all(`SELECT kind, query, scanned, slideshows, ran_at FROM batches ORDER BY ran_at DESC`);

  const pb = latestPlaybook(db, runId);

  const strips = new Map<string, string[]>();
  for (const p of posts) strips.set(p.aweme_id, await slideStrip(db, p.aweme_id));

  const days = (x: number) => (x ? Math.floor((Date.now() - x) / 86_400_000) : null);
  const vpf = (p: any) => (p.followers ? p.play / p.followers : null);

  // Enum values from the taxonomy are machine names. Nobody reading this cares that it
  // is spelled text_over_photo, and printing it that way is most of what makes a page
  // feel like it was written for a database rather than a person.
  const human = (s: unknown) => String(s ?? "").replace(/_/g, " ");

  /**
   * A slide line fuses two different jobs: the words that go ON the slide, usually quoted,
   * and the art direction for it. Rendered as one run of text they compete, and you cannot
   * tell at a glance what to actually type into the design tool. Split them.
   */
  const splitSlide = (raw: string) => {
    const t = slideBody(raw);
    // A closing quote is one that is not followed by a letter or digit. Without that
    // guard the apostrophe in "THEY DON'T KNOW" ends the quote and the headline becomes
    // "THEY DON", which is exactly the kind of thing nobody notices until it ships.
    const pairs: [string, string][] = [
      ["'", "'"],
      ['"', '"'],
      ["\u2018", "\u2019"],
      ["\u201C", "\u201D"],
    ];
    for (const [open, close] of pairs) {
      if (!t.startsWith(open)) continue;
      const re = new RegExp(
        `^\\${open}([\\s\\S]+?)\\${close}(?![A-Za-z0-9])\\s*(?:[\u2014\u2013-]\\s*)?([\\s\\S]*)$`,
      );
      const m = t.match(re);
      if (m) return { headline: m[1].trim(), direction: m[2].trim() };
    }
    return { headline: "", direction: t };
  };

  const readPosts = posts.filter((p: any) => p.hook_text);

  const mdName = `${slugify(run?.label ?? "slideshow-research")}.md`;
  const plan = latestPlan(db, runId);
  const md = [playbookMarkdown(pb, run), planMarkdown(plan)].filter(Boolean).join("\n");

  const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${run ? esc(run.label) : "Slideshow library"} — what to post</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* Spec-sheet paper, ink, and two working colours: one means proven, one means don't.
   Colour is never decoration here; if something is pine it is because evidence backs it. */
:root{
  --paper:#FFFFFF; --card:#FFFFFF; --sunk:#F7F6F3;
  --ink:#37352F; --ink2:#787774; --ink3:#9B9A97;
  --rule:#E9E9E7; --rule2:#F1F1EF;
  --go:#0F7B6C; --go-soft:#DDEDEA;
  --stop:#E03E3E; --stop-soft:#FBE4E4;
  --shadow:0 1px 2px rgba(15,15,15,.06),0 2px 6px rgba(15,15,15,.04);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#191919; --card:#202020; --sunk:#252525;
  --ink:#D4D4D4; --ink2:#9B9B9B; --ink3:#7A7A7A;
  --rule:#2F2F2F; --rule2:#262626;
  --go:#4DAB9A; --go-soft:#1F332F;
  --stop:#FF7369; --stop-soft:#352622;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}}
:root[data-theme="dark"]{
  --paper:#191919; --card:#202020; --sunk:#252525;
  --ink:#D4D4D4; --ink2:#9B9B9B; --ink3:#7A7A7A;
  --rule:#2F2F2F; --rule2:#262626;
  --go:#4DAB9A; --go-soft:#1F332F;
  --stop:#FF7369; --stop-soft:#352622;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}
*{box-sizing:border-box}
:root{
  --sans:Roboto,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
body{margin:0;background:var(--paper);color:var(--ink);
  font:400 16.5px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px 96px}

/* Anything made of sentences is capped at a reading measure. */
.prose{max-width:60ch}
.prose p{margin:0 0 .8em}
.prose p:last-child{margin:0}


h1{font-size:clamp(30px,4.4vw,46px);font-weight:800;line-height:1.05;letter-spacing:-.02em;margin:0}
h2{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin:0;color:var(--ink2)}
h3{font-size:clamp(21px,2.4vw,27px);font-weight:700;letter-spacing:-.015em;line-height:1.15;margin:0}
a{color:inherit;text-decoration:none;border-bottom:1.5px solid var(--go)}
a:hover{background:var(--go-soft)}
.mono,.num-v{font-family:var(--mono);font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--go);outline-offset:3px;border-radius:4px}
/* ── Toolbar ───────────────────────────────────────────── */
.bar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--paper) 88%,transparent);
  backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);
  border-bottom:1px solid var(--rule)}
.bar-in{max-width:1080px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;gap:12px}
.bar .mark{font-family:var(--sans);font-size:13px;font-weight:700;letter-spacing:-.01em;
  margin-right:auto;display:flex;align-items:center;gap:8px}
.bar .mark i{width:7px;height:7px;border-radius:2px;background:var(--go);display:block}

/* One button style everywhere. 32px min target, visible focus, no hover-only affordances. */
.btn{font-family:var(--sans);font-size:12.5px;font-weight:600;color:var(--ink2);
  background:var(--card);border:1px solid var(--rule);border-radius:7px;padding:0 11px;height:32px;
  display:inline-flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;
  transition:background .12s,border-color .12s,color .12s}
.btn:hover{color:var(--ink);border-color:var(--ink3)}
.btn:active{transform:translateY(.5px)}
.btn svg{width:13px;height:13px;flex:0 0 auto}
.btn.is-done{color:var(--go);border-color:var(--go)}
.btn.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.btn.primary:hover{opacity:.86;color:var(--paper)}

/* Segmented theme control: three explicit states, because "system" is a real choice. */
.seg{display:inline-flex;background:var(--sunk);border:1px solid var(--rule);border-radius:8px;padding:2px;gap:2px}
.seg button{font-family:var(--sans);font-size:12px;font-weight:600;color:var(--ink3);background:none;
  border:0;border-radius:6px;height:26px;padding:0 10px;cursor:pointer;display:grid;place-items:center}
.seg button[aria-pressed="true"]{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.10)}
.seg svg{width:14px;height:14px}

/* Copy affordance sits with its block, stays reachable by keyboard, never hover-only. */
.blockhead{display:flex;align-items:center;gap:10px;margin:0 0 9px}
.blockhead h4{margin:0}
.btn.ghost{background:none;border-color:transparent;color:var(--ink3);height:28px;padding:0 8px;
  opacity:0;transition:opacity .12s,color .12s}
.fmt:hover .btn.ghost,.post:hover .btn.ghost,.btn.ghost:focus-visible{opacity:1}
@media(hover:none){.btn.ghost{opacity:1}}
.slide{position:relative}
.slide .btn.ghost{position:absolute;right:6px;bottom:6px;height:26px;padding:0 7px;background:var(--card);
  border-color:var(--rule)}
.copyable{display:inline-flex;align-items:center;gap:6px}

#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);z-index:60;
  background:var(--ink);color:var(--paper);font-family:var(--sans);font-size:13px;font-weight:600;
  padding:9px 15px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

tbody tr:hover{background:var(--card)}
@media print{.bar,.btn,.seg{display:none!important}details{open:true}}


.eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink2)}

/* ── Cover ─────────────────────────────────────────────── */
.cover{padding:56px 0 40px;border-bottom:2px solid var(--ink)}
.cover h1{margin:14px 0 0;max-width:19ch}
.answer{margin:30px 0 0;max-width:24ch;font-family:var(--sans);
  font-size:clamp(26px,3.4vw,38px);line-height:1.12;font-weight:700;letter-spacing:-.02em;color:var(--go)}
.answer b{display:block;font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink2);margin-bottom:10px}
.brief{margin:16px 0 0;max-width:56ch;font-size:15.5px;color:var(--ink2);line-height:1.5}
.brief span{display:block;font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink2);margin-bottom:5px}
.receipts{display:flex;flex-wrap:wrap;gap:0;margin:34px 0 0;border-top:1px solid var(--rule)}
.receipt{flex:1 1 150px;padding:14px 18px 2px 0;border-right:1px solid var(--rule);padding-right:22px;margin-right:22px}
.receipt:last-child{border-right:0}
.receipt .v{font-family:var(--sans);font-size:27px;font-weight:700;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.1}
.receipt .l{font-size:14px;color:var(--ink2);line-height:1.35;margin-top:3px}

/* ── Sections ──────────────────────────────────────────── */
section{margin-top:60px}
.shead{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid var(--rule);
  padding-bottom:9px;margin-bottom:26px}
.shead .hint{font-size:14px;color:var(--ink2);margin:0}

/* ── A format to make ──────────────────────────────────── */
.fmt{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:28px;margin-bottom:22px}
.fmt-top{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;justify-content:space-between}
.badge{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  padding:5px 10px;border-radius:20px;white-space:nowrap;background:var(--go-soft);color:var(--go)}
.badge.thin{background:var(--stop-soft);color:var(--stop)}
.lede-line{margin:14px 0 0;font-size:19px;line-height:1.5;max-width:60ch}
.block{margin-top:26px}
.block > h4,.blockhead h4{font-family:var(--sans);font-size:12.5px;font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink);margin:0 0 10px}

/* Signature: the deck you are being told to build, as actual slides. */
.deck{display:flex;gap:12px;overflow-x:auto;padding:2px 2px 12px;scroll-snap-type:x proximity}
.slide{flex:0 0 200px;aspect-ratio:9/16;scroll-snap-align:start;background:var(--card);
  border:1px solid var(--rule);border-radius:10px;padding:14px;display:flex;flex-direction:column;
  overflow:hidden}
.slide.first{border-color:var(--go);box-shadow:inset 0 0 0 1px var(--go)}
.slide.first .num{color:var(--go)}
.s-head{font-family:var(--sans);font-size:15px;font-weight:700;line-height:1.22;letter-spacing:-.01em;
  margin:0 0 9px;color:var(--ink)}
.s-dir{margin:0;font-size:13px;line-height:1.45;color:var(--ink2);overflow-y:auto}
.slide .num{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.09em;
  color:var(--ink2);margin-bottom:9px;text-transform:uppercase}
.needs{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
.tag{font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:4px;
  background:var(--sunk);color:var(--ink2)}

/* ── Don't do this ─────────────────────────────────────── */
.dont{border-left:3px solid var(--stop);padding:2px 0 2px 18px;margin-bottom:20px;max-width:64ch}

/* ── Plan ──────────────────────────────────────────────── */
ol.plan{list-style:none;counter-reset:s;margin:0;padding:0;max-width:64ch}
ol.plan li{counter-increment:s;position:relative;padding:0 0 18px 44px}
ol.plan li::before{content:counter(s);position:absolute;left:0;top:1px;width:28px;height:28px;
  display:grid;place-items:center;border-radius:50%;background:var(--go);color:var(--card);
  font-family:var(--sans);font-size:13px;font-weight:700}

/* ── Proof ─────────────────────────────────────────────── */
.post{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:22px;margin-bottom:18px}
.ptop{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;font-size:14px;color:var(--ink2)}
.ptop .who{font-family:var(--sans);font-size:17px;font-weight:700;color:var(--ink)}
.hook{font-family:var(--sans);font-size:clamp(18px,2vw,22px);font-weight:700;line-height:1.25;
  margin:12px 0 0;max-width:30ch;letter-spacing:-.01em}
.film{display:flex;gap:8px;overflow-x:auto;margin-top:14px;padding-bottom:8px}
.film img{height:250px;width:141px;object-fit:contain;background:var(--sunk);border-radius:6px;flex:0 0 auto}
.cap{font-size:14px;color:var(--ink2);margin:12px 0 0;max-width:64ch}
details{margin-top:12px}
summary{cursor:pointer;font-family:var(--sans);font-size:13px;font-weight:600;color:var(--ink2)}
summary:hover{color:var(--ink)}
details ol{margin:10px 0 0;padding-left:20px;font-size:15px;max-width:64ch}
details li{margin:5px 0}

/* ── Reference ─────────────────────────────────────────── */
.ref summary{font-size:13px;padding:12px 0;border-bottom:1px solid var(--rule2)}
.scroll{overflow-x:auto;margin-top:14px}
table{border-collapse:collapse;width:100%;font-size:14px;font-family:var(--sans)}
th{text-align:left;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);
  font-weight:600;padding:0 14px 8px 0;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:9px 14px 9px 0;border-bottom:1px solid var(--rule2);white-space:nowrap}
td.v{font-family:var(--mono);font-variant-numeric:tabular-nums}

.note{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--stop);
  border-radius:8px;padding:16px 18px;font-size:15px;max-width:64ch}
.note code{font-family:var(--mono);font-size:13px}
footer{margin-top:64px;padding-top:16px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink3);
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-family:var(--sans)}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
@media(max-width:640px){.receipt{border-right:0;margin-right:0;flex-basis:46%}.fmt{padding:20px}}
</style>

<div class="bar"><div class="bar-in">
  <span class="mark"><i></i>swipekit</span>
  ${
    md
      ? `<button class="btn" data-copy-el="#md-src">${COPY_ICON}Copy</button>
         <button class="btn primary" data-download="#md-src" data-filename="${esc(mdName)}">
           ${DL_ICON}Export .md</button>`
      : ""
  }
  <div class="seg" role="group" aria-label="Colour theme">
    <button data-theme-set="light" aria-pressed="false" title="Light" aria-label="Light theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg></button>
    <button data-theme-set="system" aria-pressed="true" title="Match system" aria-label="Match system theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20.5h8"/></svg></button>
    <button data-theme-set="dark" aria-pressed="false" title="Dark" aria-label="Dark theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg></button>
  </div>
</div></div>

<div class="wrap">

<div class="cover">
  <p class="eyebrow">What to post · ${new Date().toISOString().slice(0, 10)}</p>
  <h1>${run ? esc(run.label) : "The whole library"}</h1>
  ${run?.brief ? `<p class="brief"><span>You asked</span>${esc(run.brief)}</p>` : ""}
  ${
    pb
      ? `<p class="answer"><b>The answer</b>${esc(String(pb.verdict).split(/(?<=[.!?])\s+/)[0])}</p>`
      : `<p class="answer"><b>Not answered yet</b>Nobody has written up what to make from this research.</p>`
  }
  <div class="receipts">
    <div class="receipt"><div class="v">${exact(t.slideshows)}</div>
      <div class="l">slideshows collected and measured</div></div>
    <div class="receipt"><div class="v">${exact(t.accounts)}</div>
      <div class="l">accounts seen posting them</div></div>
    <div class="receipt"><div class="v">${exact(t.proven)}</div>
      <div class="l">small accounts that pulled 100k+ views</div></div>
    <div class="receipt"><div class="v">${exact(t.analysed)}</div>
      <div class="l">posts read slide by slide</div></div>
  </div>
</div>
${
  pb
    ? `
<section>
  <div class="shead"><h2>Why</h2><p class="hint">The reasoning behind the answer above.</p></div>
  <div class="prose" style="font-size:18px">${paras(
    String(pb.verdict)
      .split(/(?<=[.!?])\s+/)
      .slice(1)
      .join(" "),
  )}</div>
</section>

<section>
  <div class="shead"><h2>What to post</h2>
    <p class="hint">${pb.patterns.length} format${pb.patterns.length === 1 ? "" : "s"} other accounts already proved. Build the slides exactly as laid out.</p></div>
  ${pb.patterns
    .map(
      (x: any) => `<article class="fmt">
    <div class="fmt-top">
      <h3>${esc(x.name)}</h3>
      <span class="badge ${x.confidence === "thin" ? "thin" : ""}">${confidenceLabel(x.confidence)}</span>
    </div>
    <div class="prose lede-line">${paras(x.whyItWorks)}</div>

    <div class="block">
      <div class="blockhead"><h4>Build this</h4>
        <button class="btn ghost" data-copy-label="Deck copied"
          data-copy="${esc((x.slideSkeleton ?? []).map((l: string, i: number) => `${i + 1}. ${slideBody(l)}`).join("\n"))}">
          ${COPY_ICON}Copy all ${(x.slideSkeleton ?? []).length} slides</button>
      </div>
      <div class="deck">${(x.slideSkeleton ?? [])
        .map((l: string, i: number) => {
          const { headline, direction } = splitSlide(l);
          return `<div class="slide${i === 0 ? " first" : ""}">
             <div class="num">Slide ${i + 1}${i === 0 ? " · the hook" : ""}</div>
             ${headline ? `<p class="s-head">${esc(headline)}</p>` : ""}
             ${direction ? `<p class="s-dir">${esc(direction)}</p>` : ""}
             <button class="btn ghost" aria-label="Copy slide ${i + 1}" data-copy-label="Slide ${i + 1} copied"
               data-copy="${esc(slideBody(l))}">${COPY_ICON}</button></div>`;
        })
        .join("")}</div>
      <div class="needs">${(x.assetsNeeded ?? [])
        .map((a: string) => `<span class="tag">${esc(human(a))}</span>`)
        .join("")}</div>
    </div>

    <div class="block">
      <h4>Make it yours</h4>
      <div class="prose">${paras(x.adaptation)}</div>
    </div>

    <div class="block">
      <h4>Who already proved it</h4>
      <div class="prose">${paras(x.evidence)}</div>
    </div>
  </article>`,
    )
    .join("")}
</section>
${
  pb.avoid?.length
    ? `<section>
  <div class="shead"><h2>Don't do this</h2>
    <p class="hint">These get views. They will cost you more than they return.</p></div>
  ${pb.avoid.map((a: string) => `<div class="dont prose">${paras(a)}</div>`).join("")}
</section>`
    : ""
}
${
  pb.nextSteps?.length
    ? `<section>
  <div class="shead"><h2>Do this next</h2><p class="hint">In order.</p>
    <button class="btn" style="margin-left:auto" data-copy-label="Checklist copied"
      data-copy="${esc(pb.nextSteps.map((a: string) => `- [ ] ${a}`).join("\n"))}">${COPY_ICON}Copy as checklist</button>
  </div>
  <ol class="plan">${pb.nextSteps.map((a: string) => `<li>${esc(a)}</li>`).join("")}</ol>
</section>`
    : ""
}
${
  plan?.entries?.length
    ? `<section>
  <div class="shead"><h2>The next ${plan.entries.length} posts</h2>
    <p class="hint">~${plan.postsPerWeek} a week, starting ${esc(plan.startsOn)}.</p>
    <button class="btn" style="margin-left:auto" data-copy-label="Schedule copied"
      data-copy="${esc(plan.entries.map((e: any) => `${e.date} (${String(e.weekday).slice(0, 3)}) ${e.pattern}: ${e.topic}${e.hook ? ` — "${e.hook}"` : ""}`).join("\n"))}">${COPY_ICON}Copy the schedule</button>
  </div>
  <div class="scroll"><table>
    <thead><tr><th>Date</th><th>Day</th><th>Pattern</th><th>Topic</th><th>Slide 1</th><th>Modelled on</th></tr></thead>
    <tbody>${plan.entries
      .map(
        (e: any) => `<tr>
      <td class="mono">${esc(e.date)}</td>
      <td style="color:var(--ink2)">${esc(String(e.weekday).slice(0, 3))}</td>
      <td>${esc(e.pattern)}</td>
      <td>${esc(e.topic)}</td>
      <td>${e.hook ? `<strong>${esc(e.hook)}</strong>` : "&mdash;"}</td>
      <td>${(e.sources ?? [])
        .map(
          (src: any) =>
            `<a href="${esc(src.url)}" target="_blank" rel="noopener">@${esc(src.handle ?? "post")}</a>`,
        )
        .join("<br>")}</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div>
</section>`
    : ""
}`
    : `<section><div class="note">No write-up yet. The numbers below are real, but nobody has
        turned them into a plan. Ask your agent to write the playbook, then rebuild this page.</div></section>`
}

${
  readPosts.length
    ? `<section>
  <div class="shead"><h2>See it yourself</h2>
    <p class="hint">Real posts, real slides, with the numbers. Check the recommendation against them.</p></div>
  ${readPosts
    .map((p: any) => {
      const url = postUrl(p.unique_id, p.aweme_id);
      const tiles = (strips.get(p.aweme_id) ?? [])
        .map(
          (src, i) =>
            `<a href="${url}" target="_blank" rel="noopener"><img src="${src}" alt="Slide ${i + 1}" loading="lazy"></a>`,
        )
        .join("");
      const tpl: string[] = p.template ? JSON.parse(p.template) : [];
      const v = vpf(p);
      return `<article class="post">
    <div class="ptop">
      <a class="who" href="${acctUrl(p.unique_id)}" target="_blank" rel="noopener">@${esc(p.unique_id)}</a>
      <span><b class="num-v">${n(p.play)}</b> views</span>
      <span><b class="num-v">${pct(p.collect / Math.max(p.play, 1), 1)}</b> saved it</span>
      <span><b class="num-v">${n(p.followers)}</b> followers</span>
      ${v ? `<span>reached <b class="num-v">${v.toFixed(0)}x</b> its follower count</span>` : ""}
      <span>${p.slide_count} slides</span>
      <span>${days(p.posted_at) ?? "?"} days ago</span>
      <a href="${url}" target="_blank" rel="noopener">open on TikTok</a>
    </div>
    ${
      p.hook_text
        ? `<p class="hook">${esc(p.hook_text)}
             <button class="btn ghost" data-copy-label="Hook copied" aria-label="Copy this hook"
               data-copy="${esc(p.hook_text)}">${COPY_ICON}</button></p>`
        : ""
    }
    <div class="film">${tiles}</div>
    <div class="needs">
      <span class="tag">${esc(human(p.hook_type))}</span>
      <span class="tag">${esc(human(p.structure))}</span>
      <span class="tag">${esc(human(p.visual_style))}</span>
      ${(p.assets_needed ? JSON.parse(p.assets_needed) : [])
        .map((a: string) => `<span class="tag">needs ${esc(human(a))}</span>`)
        .join("")}
    </div>
    ${
      tpl.length
        ? `<details><summary>How this one is built, slide by slide</summary>
           <ol>${tpl.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
           ${p.production_notes ? `<p class="cap">${esc(p.production_notes)}</p>` : ""}</details>`
        : ""
    }
    <p class="cap">${esc(String(p.caption).slice(0, 200))}
      <button class="btn ghost" data-copy-label="Caption copied" aria-label="Copy this caption"
        data-copy="${esc(p.caption)}">${COPY_ICON}</button></p>
  </article>`;
    })
    .join("")}
</section>`
    : `<section><div class="note">No posts have been read slide by slide yet, so there is nothing
        to show you here. Ask your agent to read the top posts, then rebuild this page.</div></section>`
}
${
  pb?.gaps?.length
    ? `<section>
  <div class="shead"><h2>What we still don't know</h2>
    <p class="hint">Be careful making decisions that depend on these.</p></div>
  <div class="prose">${pb.gaps.map((g: string) => `<p>${esc(g)}</p>`).join("")}</div>
</section>`
    : ""
}

<section class="ref">
  <div class="shead"><h2>The raw numbers</h2>
    <p class="hint">Everything the recommendation was built from.</p></div>

  <details><summary>Accounts we measured (${accounts.length})</summary>
  <div class="scroll"><table>
    <thead><tr><th>Account</th><th>Followers</th><th>Posts we have</th><th>How many are slideshows</th><th>Best post</th><th>Last posted</th></tr></thead>
    <tbody>${accounts
      .map(
        (a) => `<tr>
      <td><a href="${acctUrl(a.unique_id)}" target="_blank" rel="noopener">@${esc(a.unique_id)}</a></td>
      <td class="v">${n(a.followers)}</td><td class="v">${a.posts}</td>
      <td class="v">${a.photos} (${Math.round((a.photos / a.posts) * 100)}%)</td>
      <td class="v">${n(a.best)}</td><td class="v">${days(a.newest) ?? "?"}d ago</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div></details>
${
  sounds.length
    ? `  <details><summary>Sounds more than one account is using (${sounds.length})</summary>
  <div class="scroll"><table>
    <thead><tr><th>Sound</th><th>Accounts using it</th><th>Slideshows</th><th>Most recent</th></tr></thead>
    <tbody>${sounds
      .map(
        (s) => `<tr>
      <td><a class="mono" href="${soundUrl(s.id)}" target="_blank" rel="noopener">${esc(s.id)}</a></td>
      <td class="v">${s.accounts}</td><td class="v">${s.posts}</td><td class="v">${days(s.newest) ?? "?"}d ago</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div></details>`
    : ""
}
  <details><summary>What we searched (${batches.length})</summary>
  <div class="scroll"><table>
    <thead><tr><th>Search</th><th>Posts looked at</th><th>Slideshows</th><th>Share</th><th>When</th></tr></thead>
    <tbody>${batches
      .map(
        (b) => `<tr>
      <td>${b.kind === "sound" ? `<a class="mono" href="${soundUrl(b.query)}" target="_blank" rel="noopener">${esc(b.query)}</a>` : esc(b.query)}</td>
      <td class="v">${b.scanned}</td><td class="v">${b.slideshows}</td>
      <td class="v">${b.scanned ? `${Math.round((b.slideshows / b.scanned) * 100)}%` : "—"}</td>
      <td class="v">${days(b.ran_at) ?? 0}d ago</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div></details>
</section>

<footer><span>Built by swipekit from ${exact(t.posts)} posts</span><span>${new Date().toISOString().slice(0, 10)}</span></footer>
<div id="toast" role="status" aria-live="polite"></div>
${md ? `<textarea id="md-src" hidden aria-hidden="true">${esc(md)}</textarea>` : ""}
<script>
(() => {
  const root = document.documentElement;
  const seg = document.querySelectorAll("[data-theme-set]");

  // Three states, not two: "system" is a real preference and gets its own button rather
  // than being the thing you land on by never touching the control.
  const apply = (mode) => {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    seg.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === mode)));
    try { localStorage.setItem("sp-theme", mode); } catch {}
  };
  let saved = "system";
  try { saved = localStorage.getItem("sp-theme") || "system"; } catch {}
  apply(saved);
  seg.forEach((b) => b.addEventListener("click", () => apply(b.dataset.themeSet)));

  const toast = document.getElementById("toast");
  let timer;
  const say = (msg) => {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove("show"), 1600);
  };

  const write = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // file:// without a secure context has no clipboard API, and a report you cannot
      // copy from is a report that failed at its job.
      const t = document.createElement("textarea");
      t.value = text;
      t.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand("copy");
      t.remove();
      return ok;
    }
  };

  document.addEventListener("click", (e) => {
    const dl = e.target.closest("[data-download]");
    if (!dl) return;
    const text = document.querySelector(dl.dataset.download)?.value ?? "";
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = dl.dataset.filename || "research.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    say("Downloaded " + a.download);
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy],[data-copy-el]");
    if (!btn) return;
    const src = btn.dataset.copyEl ? document.querySelector(btn.dataset.copyEl)?.value : btn.dataset.copy;
    if (!src) return;
    const ok = await write(src);
    say(ok ? (btn.dataset.copyLabel || "Copied") : "Press Cmd+C to copy");
    if (!ok) return;
    btn.classList.add("is-done");
    setTimeout(() => btn.classList.remove("is-done"), 1200);
  });
})();
</script>
</div>`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return out;
}
