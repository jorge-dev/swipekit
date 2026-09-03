import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the library lives, in precedence order:
 *
 *   1. $SWIPEKIT_HOME, for anyone keeping several libraries apart.
 *   2. ./library, if one already exists here. Keeps working inside a clone of the repo.
 *   3. ~/.swipekit/library, the default once the CLI is installed globally.
 *
 * Rule 3 is what makes a global install behave. Without it, running the CLI from any
 * other directory would quietly start a fresh empty library there instead of finding
 * the one you have been filling up.
 *
 * Resolved once at startup rather than per call, so a command that changes directory
 * partway through cannot end up writing half its output somewhere else.
 */
function resolveLibraryDir(): string {
  const env = process.env.SWIPEKIT_HOME;
  if (env) return resolve(env);
  const local = resolve("library");
  if (existsSync(local)) return local;
  return join(homedir(), ".swipekit", "library");
}

export const LIBRARY_DIR = resolveLibraryDir();

/** Build a path inside the library. Always use this instead of a bare "library/..." string. */
export const libPath = (...parts: string[]) => join(LIBRARY_DIR, ...parts);

/** Fold a run label down to something safe and readable in a filename. */
function slugify(label: string): string {
  return (
    label
      // NFD then drop combining marks, so "miesiączkowy" slugs to "miesiaczkowy"
      // rather than losing the letter to the non-alphanumeric sweep below.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "untitled"
  );
}

/**
 * Where a rendered report or plan goes.
 *
 * One fixed filename per kind meant every build silently overwrote the last one, so a
 * library holding five runs could only ever show you the most recent render. Naming the
 * file after the run it came from is what makes the output survive the next question.
 *
 * Unscoped renders — a report over the whole library — keep the old flat filename, since
 * there is no run to name them after and there is only ever one such document.
 */
export function docPath(kind: "report" | "plan", runLabel?: string | null): string {
  if (!runLabel) return libPath(`${kind}.html`);
  const date = new Date().toISOString().slice(0, 10);
  return libPath("reports", `${date}-${kind}-${slugify(runLabel)}.html`);
}
