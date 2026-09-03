#!/usr/bin/env node
/**
 * Summarise what an agent actually did in a Claude Code session: which swipekit tools
 * it called, in order, with the arguments that mattered and whether each one errored.
 *
 * The recurring question while developing this tool is "did it call read_slides, or did it
 * answer from captions alone" — and the honest way to settle that is the transcript, not a
 * pasted summary. Claude Code already records every tool call and result as JSONL, so this
 * just reads it.
 *
 *   npm run trace              # newest session for this repo
 *   npm run trace -- --all     # every tool, not just swipekit's
 *   npm run trace -- --file /path/to/session.jsonl
 *
 * Transcripts run to tens of megabytes, so this streams line by line rather than parsing
 * the whole file into memory.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const showAll = process.argv.includes("--all");

function newestTranscript(): string {
  // Claude Code slugifies the cwd to name the project directory.
  const slug = process.cwd().replace(/\//g, "-");
  const dir = join(homedir(), ".claude", "projects", slug);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No session transcripts in ${dir}`);
  return files[0]!;
}

const file = arg("file") ?? newestTranscript();
console.log(`transcript: ${file}\n`);

/** Tool results arrive in a later record than the call, matched by id. */
const pending = new Map<string, { name: string; input: any }>();
const calls: { name: string; input: any; isError: boolean; preview: string }[] = [];
let lastText = "";

const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of rl) {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    continue;
  }
  const content = d?.message?.content;
  if (!Array.isArray(content)) continue;

  for (const c of content) {
    if (c?.type === "tool_use") {
      pending.set(c.id, { name: c.name, input: c.input });
    } else if (c?.type === "tool_result") {
      const call = pending.get(c.tool_use_id);
      if (!call) continue;
      pending.delete(c.tool_use_id);
      const text = Array.isArray(c.content)
        ? c.content.map((x: any) => x?.text ?? `<${x?.type}>`).join(" ")
        : String(c.content ?? "");
      calls.push({
        name: call.name,
        input: call.input,
        isError: Boolean(c.is_error),
        preview: text.replace(/\s+/g, " ").slice(0, 160),
      });
    } else if (c?.type === "text" && c.text?.trim()) {
      lastText = c.text;
    }
  }
}

const shown = showAll ? calls : calls.filter((c) => c.name.includes("swipekit"));
console.log(
  `${shown.length} tool call${shown.length === 1 ? "" : "s"}${showAll ? "" : " (swipekit only)"}\n`,
);

for (const [i, c] of shown.entries()) {
  const short = c.name.replace("mcp__swipekit__", "");
  const args = JSON.stringify(c.input ?? {}).slice(0, 100);
  console.log(`${String(i + 1).padStart(2)}. ${c.isError ? "ERROR " : "      "}${short}  ${args}`);
  if (c.isError) console.log(`      ↳ ${c.preview}`);
}

// The counts that answer the question this script exists for.
const count = (n: string) => shown.filter((c) => c.name.endsWith(n)).length;
console.log(
  `\nread_slides ${count("read_slides")} · save_analysis ${count("save_analysis")} · ` +
    `write_playbook ${count("write_playbook")} · build_report ${count("build_report")} · ` +
    `errors ${shown.filter((c) => c.isError).length}`,
);

if (lastText) console.log(`\n--- final answer (${lastText.length} chars) ---\n${lastText.slice(0, 1500)}`);
