#!/usr/bin/env node
/**
 * Wipes everything swipekit has written, back to a fresh install: no library, no
 * reports, no Chrome profile, no solved captcha.
 *
 * Interactive by default. It shows what it is about to remove, offers to tar the
 * library up first (the Chrome profile is just cache and a solved captcha, not worth
 * keeping), and only deletes after a yes.
 *
 *   npm run reset
 *   npm run reset -- --yes --no-backup
 *   npm run reset -- --backup --backup-dir ~/somewhere
 *
 * Removes:
 *   - the library dir the resolver currently picks (a repo-local ./library in a clone,
 *     $SWIPEKIT_HOME if set, otherwise ~/.swipekit/library)
 *   - ~/.swipekit in full: the global library and the Chrome profile, even when the
 *     resolver above pointed elsewhere, so a run from inside a clone with its own
 *     ./library does not leave the global library and its reports behind
 *
 * Kills the MCP server and its Chrome first rather than deleting out from under them —
 * a process holding a directory open mid-write is how you get a corrupted db or an
 * orphaned profile lock. Every path comes from the real constants in paths.ts and
 * session.ts, so it cannot point at the wrong directory if that logic changes.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { LIBRARY_DIR } from "../store/paths.ts";
import { PROFILE_DIR } from "../collect/session.ts";

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flagValue = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (has("-h") || has("--help")) {
  console.log(
    [
      "Usage: npm run reset -- [options]",
      "",
      "Wipes the swipekit library and Chrome profile back to a fresh install.",
      "",
      "Options:",
      "  -y, --yes             skip the confirmation prompts",
      "      --backup          back up the library first (default: ask)",
      "      --no-backup       do not back up",
      "      --backup-dir <p>  where the backup .tgz goes (default: ~/.swipekit-backups)",
      "  -h, --help            show this",
    ].join("\n"),
  );
  process.exit(0);
}

// ~/.swipekit, taken from PROFILE_DIR rather than rebuilt from homedir() here.
const SWIPEKIT_ROOT = dirname(PROFILE_DIR);
const skipPrompts = has("-y") || has("--yes");
const backupDir = flagValue("--backup-dir") ?? join(homedir(), ".swipekit-backups");

// The directories to delete, de-duplicated: drop the resolved library dir when it
// already sits inside ~/.swipekit, since removing the root covers it. Then keep only
// the ones that actually exist.
const targets = [
  LIBRARY_DIR !== SWIPEKIT_ROOT && !LIBRARY_DIR.startsWith(SWIPEKIT_ROOT + sep) ? LIBRARY_DIR : null,
  SWIPEKIT_ROOT,
].filter((dir): dir is string => dir != null && existsSync(dir));

if (targets.length === 0) {
  console.log("Already clean. Nothing to remove.");
  process.exit(0);
}

const sizeOf = (path: string) => {
  try {
    return (
      execSync(`du -sh ${JSON.stringify(path)}`, { encoding: "utf8" })
        .split("\t")[0]
        ?.trim() ?? "?"
    );
  } catch {
    return "?";
  }
};

console.log("\nThis wipes swipekit back to a fresh install.\n");
console.log("Will remove:");
for (const dir of targets) console.log(`  ${dir}   ${sizeOf(dir)}`);
console.log(
  "\nThe library holds your collected posts, accounts and rendered reports.\n" +
    "The Chrome profile under it is cache and a solved captcha, not worth keeping.\n",
);

const ask = async (question: string, fallback: boolean) => {
  if (!process.stdin.isTTY) {
    console.error("Not a terminal. Re-run with --yes (plus --backup or --no-backup) to proceed.");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "") return fallback;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

// Honour --backup / --no-backup, otherwise ask. With --yes and neither flag, don't
// back up: a script that opted out of the prompts gets the plain behaviour.
const wantBackup = has("--backup")
  ? true
  : has("--no-backup")
    ? false
    : skipPrompts
      ? false
      : await ask("Back up the library first? [Y/n] ", true);

if (wantBackup) {
  if (!existsSync(LIBRARY_DIR)) {
    console.log("No library to back up, skipping.\n");
  } else {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const out = join(backupDir, `swipekit-library-${stamp}.tgz`);
    const parent = JSON.stringify(dirname(LIBRARY_DIR));
    execSync(`tar -czf ${JSON.stringify(out)} -C ${parent} ${JSON.stringify(basename(LIBRARY_DIR))}`);
    console.log(`Backed up to ${out}   ${sizeOf(out)}\n`);
  }
}

if (!(skipPrompts || (await ask("Delete now? [y/N] ", false)))) {
  console.log("Nothing was removed.");
  process.exit(0);
}

const kill = (pattern: string) => {
  try {
    execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
  } catch {
    // nothing matched — that's the common case, not an error
  }
};

// Every way the MCP server gets started: straight from source, from a global install
// or `npx`, and the `swipekit-mcp` bin by name. The HTTP transport (MCP_HTTP=1) is the
// same entry file, so killing the process frees its port too — nothing extra to clean.
console.log("\nStopping the swipekit MCP server and its Chrome…");
kill("src/mcp.ts");
kill("dist/mcp.js");
kill("swipekit-mcp");
kill(`user-data-dir=${PROFILE_DIR}`);
await new Promise((r) => setTimeout(r, 1500)); // let the kills actually land before deleting

for (const dir of targets) {
  console.log(`Removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nClean. The next search will hit TikTok's first-run captcha again, same as a new install.");
