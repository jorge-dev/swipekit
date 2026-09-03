/**
 * The plan as markdown, for anywhere that isn't this page: Notion, a doc, a git repo.
 *
 * Kept apart from the HTML renderer because two things need it now. The report inlines it
 * so the page can copy and download without a round trip, and `swipekit export` writes
 * it to disk alongside the slide images.
 */

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "research";

/** "Slide 3: 'DO THE THING'" under a heading that already says 3 is the label twice. */
export const slideBody = (s: string) => String(s).replace(/^\s*slide\s*\d+\s*[:.–-]\s*/i, "");

export const confidenceLabel = (c: string) =>
  c === "strong" ? "Strong evidence" : c === "moderate" ? "Some evidence" : "Thin evidence";

export function planMarkdown(plan: { postsPerWeek: number; entries: any[] } | null): string {
  if (!plan?.entries?.length) return "";
  const L = [
    "## The next 30 days",
    "",
    `${plan.entries.length} posts at ~${plan.postsPerWeek}/week.`,
    "",
    "| Date | Day | Pattern | Topic | Hook | Modelled on |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const e of plan.entries) {
    const from = (e.sources ?? []).map((src: any) => `[@${src.handle ?? "post"}](${src.url})`).join(" ");
    L.push(
      `| ${e.date} | ${String(e.weekday).slice(0, 3)} | ${e.pattern} | ${e.topic} | ${e.hook ?? ""} | ${from} |`,
    );
  }
  L.push("");
  return L.join("\n");
}

export function playbookMarkdown(pb: any, run: { label?: string; brief?: string } | null): string {
  if (!pb) return "";
  const L: string[] = [`# ${run?.label ?? "Slideshow research"}`, ""];
  if (run?.brief) L.push(`> ${run.brief}`, "");
  L.push(String(pb.verdict), "");

  for (const x of pb.patterns) {
    L.push(`## ${x.name}`, "", `*${confidenceLabel(x.confidence)}*`, "", String(x.whyItWorks), "");
    L.push("### Build this", "");
    (x.slideSkeleton ?? []).forEach((l: string, i: number) => {
      L.push(`${i + 1}. ${slideBody(l)}`);
    });
    L.push("", "### Make it yours", "", String(x.adaptation), "");
    L.push("### Who already proved it", "", String(x.evidence), "");
  }

  if (pb.avoid?.length) L.push("## Don't do this", "", ...pb.avoid.map((a: string) => `- ${a}`), "");
  if (pb.nextSteps?.length)
    L.push("## Do this next", "", ...pb.nextSteps.map((a: string) => `- [ ] ${a}`), "");
  if (pb.gaps?.length) L.push("## What we still don't know", "", ...pb.gaps.map((g: string) => `- ${g}`), "");

  return L.join("\n");
}
