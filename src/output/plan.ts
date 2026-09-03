import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ReadEntry, latestPlan } from "../analyze/calendar.ts";
import { latestPlaybook } from "../analyze/playbook.ts";
import { docPath } from "../store/paths.ts";
import { getRun } from "../store/runs.ts";

/**
 * The plan as a document you produce from, not a schedule you read.
 *
 * A calendar row tells someone to post on Tuesday and leaves them to invent the post. This
 * writes out every slide's finished text, the image prompt for each one, the caption and
 * the CTA, grouped by week and day, with each post linked back to the measured post it was
 * modelled on. The test is whether someone could build a week of content from this page
 * without asking another question.
 *
 * Its own file rather than another section of the report: the report argues that a lane is
 * worth entering, this is the production brief, and they get opened at different moments
 * by possibly different people.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const COPY_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 2.5h-8v9"/></svg>';

/** Everything a person needs to actually build one post, as plain text they can copy. */
function postAsText(e: ReadEntry): string {
  const L = [`${e.pattern} — ${e.topic}`, ""];
  e.slides.forEach((s, i) => {
    L.push(`SLIDE ${i + 1}`, s.text);
    if (s.imagePrompt) L.push(`  image: ${s.imagePrompt}`);
    if (s.note) L.push(`  note: ${s.note}`);
    L.push("");
  });
  if (e.caption) L.push("CAPTION", e.caption, "");
  if (e.cta) L.push("CTA", e.cta, "");
  return L.join("\n");
}

export async function buildPlanDoc(
  db: DatabaseSync,
  opts: { runId?: string | null; out?: string } = {},
): Promise<string> {
  const runId = opts.runId ?? null;
  const run = runId ? getRun(db, runId) : null;
  const plan = latestPlan(db, runId);
  if (!plan) {
    throw new Error(
      "No plan for this run yet. Write the playbook first, then save_plan with the posts, " +
        "then build this.",
    );
  }
  const pb = latestPlaybook(db, runId);
  const out = opts.out ?? docPath("plan", run?.label);
  const entries = plan.entries as ReadEntry[];

  // Group by date so several posts on one day read as one day's work.
  const byDate = new Map<string, ReadEntry[]>();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  const byWeek = new Map<number, string[]>();
  for (const [date, posts] of byDate) {
    const wk = posts[0]!.week;
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk)!.push(date);
  }

  const totalSlides = entries.reduce((n, e) => n + e.slides.length, 0);
  const patterns = [...new Set(entries.map((e) => e.pattern))];
  const days = byDate.size;

  const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(run?.label ?? "Content plan")} — the plan</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#FFFFFF; --card:#FFFFFF; --sunk:#F7F6F3;
  --ink:#37352F; --ink2:#787774; --ink3:#9B9A97;
  --rule:#E9E9E7; --go:#0F7B6C; --go-soft:#DDEDEA;
  --sans:Roboto,ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#191919; --card:#202020; --sunk:#252525;
  --ink:#D4D4D4; --ink2:#9B9B9B; --ink3:#7A7A7A;
  --rule:#2F2F2F; --go:#4DAB9A; --go-soft:#1F332F;
}}
:root[data-theme="dark"]{
  --paper:#191919; --card:#202020; --sunk:#252525;
  --ink:#D4D4D4; --ink2:#9B9B9B; --ink3:#7A7A7A;
  --rule:#2F2F2F; --go:#4DAB9A; --go-soft:#1F332F;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.6 var(--sans);
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:40px 24px 100px}
h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);
  margin:0;padding:0}
.sub{color:var(--ink2);margin:0 0 26px;max-width:62ch}
.bar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--paper) 90%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--rule)}
.bar-in{max-width:1000px;margin:0 auto;padding:10px 24px;display:flex;gap:12px;align-items:center}
.mark{font-weight:700;font-size:13px;margin-right:auto;display:flex;align-items:center;gap:8px}
.mark i{width:7px;height:7px;border-radius:2px;background:var(--go)}
.btn{font-family:var(--sans);font-size:12.5px;font-weight:500;color:var(--ink2);background:var(--card);
  border:1px solid var(--rule);border-radius:7px;padding:0 11px;height:32px;display:inline-flex;
  align-items:center;gap:7px;cursor:pointer;white-space:nowrap}
.btn:hover{color:var(--ink)}
.btn svg{width:13px;height:13px}
.btn.is-done{color:var(--go);border-color:var(--go)}
.stats{display:flex;flex-wrap:wrap;gap:26px;padding:18px 0 22px;border-top:1px solid var(--rule);
  border-bottom:1px solid var(--rule);margin-bottom:34px}
.stat b{display:block;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.stat span{font-size:13px;color:var(--ink2)}
.week{margin-top:44px}
.week-h{display:flex;align-items:baseline;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:8px}
.week-h h2{font-size:20px;letter-spacing:-.01em;text-transform:none;color:var(--ink)}
.week-h span{font-size:13px;color:var(--ink2);margin-left:auto}
.day{margin-top:26px;padding-top:20px;border-top:1px solid var(--rule)}
.day:first-of-type{border-top:0}
.day-h{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.day-n{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--paper);background:var(--ink);
  border-radius:5px;padding:3px 8px}
.day-date{font-weight:700}
.day-wd{color:var(--ink2);font-size:14px}
.post{background:var(--sunk);border:1px solid var(--rule);border-radius:10px;padding:18px 20px;
  margin-bottom:14px}
.post-h{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.pattern{display:inline-block;background:var(--go-soft);color:var(--go);font-size:12px;font-weight:500;
  padding:3px 9px;border-radius:20px}
.topic{font-size:19px;font-weight:700;letter-spacing:-.01em;margin:8px 0 2px}
.from{font-size:13px;color:var(--ink2);margin:0 0 16px}
.from a{color:var(--ink2)}
.slides{display:grid;gap:10px;margin:0 0 16px}
.slide{display:grid;grid-template-columns:64px 1fr;gap:14px;align-items:start;background:var(--card);
  border:1px solid var(--rule);border-radius:8px;padding:13px 15px}
.slide-n{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--ink3);letter-spacing:.06em;
  text-transform:uppercase;padding-top:3px}
.slide-text{font-size:16px;font-weight:500;white-space:pre-wrap;margin:0 0 8px}
.prompt{font-size:13.5px;color:var(--ink2);background:var(--sunk);border-left:2px solid var(--go);
  border-radius:0 5px 5px 0;padding:8px 11px;margin:8px 0 0}
.prompt b{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink3);font-weight:500;display:block;margin-bottom:3px}
.snote{font-size:13px;color:var(--ink3);margin:6px 0 0;font-style:italic}
.field{margin-top:12px}
.field b{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink3);font-weight:500;display:block;margin-bottom:4px}
.field p{margin:0;font-size:15px;white-space:pre-wrap}
a{color:var(--go)}
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);z-index:60;
  background:var(--ink);color:var(--paper);font-size:13px;font-weight:500;padding:9px 15px;
  border-radius:8px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
:focus-visible{outline:2px solid var(--go);outline-offset:3px;border-radius:4px}
@media print{.bar,.btn{display:none!important}.post{break-inside:avoid}}
@media (max-width:620px){.slide{grid-template-columns:1fr;gap:6px}}
</style>

<div class="bar"><div class="bar-in">
  <span class="mark"><i></i>swipekit</span>
  <button class="btn" data-copy-el="#all-src">${COPY_ICON}Copy the whole plan</button>
</div></div>

<div class="wrap">
<h1>${esc(run?.label ?? "Content plan")}</h1>
<p class="sub">${
    pb ? `Built from the playbook for this research. ` : ""
  }Every slide is written out. Nothing here needs inventing before you can make it.</p>

<div class="stats">
  <span class="stat"><b>${entries.length}</b><span>posts</span></span>
  <span class="stat"><b>${days}</b><span>posting days</span></span>
  <span class="stat"><b>${totalSlides}</b><span>slides to make</span></span>
  <span class="stat"><b>${patterns.length}</b><span>patterns in rotation</span></span>
  <span class="stat"><b>${plan.postsPerWeek}</b><span>posts a week</span></span>
</div>

${[...byWeek.entries()]
  .map(([wk, dates]) => {
    const posts = dates.flatMap((d) => byDate.get(d)!);
    return `<section class="week">
  <div class="week-h"><h2>Week ${wk}</h2>
    <span>${posts.length} post${posts.length === 1 ? "" : "s"} · ${dates.length} day${dates.length === 1 ? "" : "s"}</span>
  </div>
  ${dates
    .map((date) => {
      const dayPosts = byDate.get(date)!;
      const first = dayPosts[0]!;
      return `<div class="day">
    <div class="day-h">
      <span class="day-n">Day ${first.day}</span>
      <span class="day-date">${esc(date)}</span>
      <span class="day-wd">${esc(first.weekday)}</span>
      ${dayPosts.length > 1 ? `<span class="day-wd">· ${dayPosts.length} posts</span>` : ""}
    </div>
    ${dayPosts
      .map(
        (e) => `<article class="post">
      <div class="post-h"><span class="pattern">${esc(e.pattern)}</span>
        <button class="btn" style="margin-left:auto" data-copy-label="Post copied"
          data-copy="${esc(postAsText(e))}">${COPY_ICON}Copy this post</button>
      </div>
      <p class="topic">${esc(e.topic)}</p>
      <p class="from">Modelled on ${e.sources
        .map(
          (src) =>
            `<a href="${esc(src.url)}" target="_blank" rel="noopener">@${esc(src.handle ?? "post")}</a>`,
        )
        .join(", ")}</p>
      <div class="slides">${e.slides
        .map(
          (s, i) => `<div class="slide">
          <div class="slide-n">Slide ${i + 1}</div>
          <div>
            <p class="slide-text">${esc(s.text)}</p>
            ${s.imagePrompt ? `<p class="prompt"><b>Image prompt</b>${esc(s.imagePrompt)}</p>` : ""}
            ${s.note ? `<p class="snote">${esc(s.note)}</p>` : ""}
          </div>
        </div>`,
        )
        .join("")}</div>
      ${e.caption ? `<div class="field"><b>Caption</b><p>${esc(e.caption)}</p></div>` : ""}
      ${e.cta ? `<div class="field"><b>Call to action</b><p>${esc(e.cta)}</p></div>` : ""}
      ${e.note ? `<div class="field"><b>Before you make it</b><p>${esc(e.note)}</p></div>` : ""}
    </article>`,
      )
      .join("")}
  </div>`;
    })
    .join("")}
</section>`;
  })
  .join("")}

<textarea id="all-src" hidden aria-hidden="true">${esc(
    entries.map((e) => `=== Day ${e.day} · ${e.date} ===\n${postAsText(e)}`).join("\n"),
  )}</textarea>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(() => {
  const toast = document.getElementById("toast");
  let timer;
  const say = (m) => {
    toast.textContent = m;
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove("show"), 1600);
  };
  const write = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    // file:// has no secure context, so the clipboard API rejects. A plan you cannot copy
    // out of is a plan you retype.
    const t = document.createElement("textarea");
    t.value = text; t.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy"); t.remove();
    return ok;
  };
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy],[data-copy-el]");
    if (!b) return;
    const src = b.dataset.copyEl ? document.querySelector(b.dataset.copyEl)?.value : b.dataset.copy;
    if (!src) return;
    const ok = await write(src);
    say(ok ? (b.dataset.copyLabel || "Copied") : "Press Cmd+C to copy");
    if (ok) { b.classList.add("is-done"); setTimeout(() => b.classList.remove("is-done"), 1200); }
  });
})();
</script>
</div>`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return out;
}
