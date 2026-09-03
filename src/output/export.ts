import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { latestPlaybook } from "../analyze/playbook.ts";
import { libPath } from "../store/paths.ts";
import { getRun, runScope } from "../store/runs.ts";
import { planMarkdown, playbookMarkdown, slugify } from "./markdown.ts";
import { latestPlan } from "../analyze/calendar.ts";
import { fetchSlides } from "./slides.ts";

/**
 * Export the plan as a folder of markdown plus the slide images, zipped.
 *
 * A downloaded .md cannot carry images. Relative paths break the moment the file moves,
 * and base64 data URIs are not rendered by most editors, Notion included. What Notion
 * does support is importing a .zip of markdown with an images folder beside it, resolving
 * the relative links on the way in. So that is the shape this writes.
 */
export async function exportBundle(
  db: DatabaseSync,
  opts: { runId?: string | null; out?: string; posts?: number } = {},
): Promise<{ zip: string; images: number; posts: number }> {
  const runId = opts.runId ?? null;
  const run = runId ? getRun(db, runId) : null;
  const pb = latestPlaybook(db, runId);
  if (!pb) throw new Error("No playbook for this run yet. Ask your agent to write one, then export.");

  const name = slugify(run?.label ?? "slideshow-research");
  const zip = resolve(opts.out ?? libPath(`${name}.zip`));
  const dir = libPath("export", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/images`, { recursive: true });

  const sc = runScope(runId);
  const proof = db
    .prepare(
      `SELECT p.aweme_id, p.unique_id, p.play, p.collect, p.followers, p.slide_count, p.caption,
              a.hook_text
       FROM posts p JOIN analyses a ON a.aweme_id = p.aweme_id
       WHERE p.is_photo=1 ${sc.sql}
       ORDER BY p.play DESC LIMIT ?`,
    )
    .all(...sc.params, opts.posts ?? 8) as any[];

  const L = [playbookMarkdown(pb, run), planMarkdown(latestPlan(db, runId))];
  let images = 0;

  if (proof.length) {
    L.push("", "## See it yourself", "", "Real posts these recommendations came from.", "");
    for (const p of proof) {
      L.push(
        `### @${p.unique_id}`,
        "",
        `${p.play.toLocaleString("en-US")} views · ${((p.collect / Math.max(p.play, 1)) * 100).toFixed(1)}% saved it · ` +
          `${(p.followers ?? 0).toLocaleString("en-US")} followers · ${p.slide_count} slides`,
        "",
        `https://www.tiktok.com/@${p.unique_id}/photo/${p.aweme_id}`,
        "",
      );
      if (p.hook_text) L.push(`> ${p.hook_text}`, "");

      // Prefer slides already on disk; only reach for the network when they are missing.
      const src = libPath("posts", p.aweme_id);
      const found: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const f = `${src}/slide-${String(i).padStart(2, "0")}.jpg`;
        if (existsSync(f)) found.push(f);
      }
      if (!found.length) {
        const [got] = await fetchSlides(db, [p.aweme_id], 5);
        if (got && !got.error) {
          mkdirSync(src, { recursive: true });
          got.images.forEach((im, k) => {
            const f = `${src}/slide-${String(k + 1).padStart(2, "0")}.jpg`;
            writeFileSync(f, Buffer.from(im.data, "base64"));
            found.push(f);
          });
        }
      }
      for (const f of found) {
        const rel = `images/${p.aweme_id}-${basename(f)}`;
        copyFileSync(f, `${dir}/${rel}`);
        L.push(`![Slide from @${p.unique_id}](${rel})`);
        images++;
      }
      L.push("");
    }
  }

  writeFileSync(`${dir}/${name}.md`, L.join("\n"));
  rmSync(zip, { force: true });
  // -r keeps the images/ folder structure, which is the whole point; -j would flatten it
  // and break every relative link in the markdown.
  execFileSync("zip", ["-qr", zip, "."], { cwd: dir, stdio: "ignore" });
  return { zip, images, posts: proof.length };
}
