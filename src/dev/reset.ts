#!/usr/bin/env node
/**
 * Wipes the library and Chrome profile so the next run starts exactly like a fresh
 * install would: no accounts, no runs, no solved captcha.
 *
 * Kills live swipekit/Chrome processes first rather than deleting out from under
 * them — a process holding either directory open mid-write is exactly how you get a
 * corrupted db or an orphaned profile lock. Imports the real path constants instead
 * of re-deriving them, so this can never point at the wrong directory if the
 * resolution logic in paths.ts or session.ts ever changes.
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { LIBRARY_DIR } from "../store/paths.ts";
import { PROFILE_DIR } from "../collect/session.ts";

const kill = (pattern: string) => {
  try {
    execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
  } catch {
    // nothing matched — that's the common case, not an error
  }
};

console.log("Stopping any running swipekit server and its Chrome…");
kill("src/mcp.ts");
kill("dist/mcp.js");
kill(`user-data-dir=${PROFILE_DIR}`);
await new Promise((r) => setTimeout(r, 1500)); // let the kills actually land before deleting

console.log(`Removing ${LIBRARY_DIR}`);
rmSync(LIBRARY_DIR, { recursive: true, force: true });

console.log(`Removing ${PROFILE_DIR}`);
rmSync(PROFILE_DIR, { recursive: true, force: true });

console.log("\nClean. The next search will hit TikTok's first-run captcha again, same as a new install.");
