#!/usr/bin/env node
/**
 * Wipes everything swipekit has written, so the next run starts exactly like a fresh
 * install would: no library, no reports, no Chrome profile, no solved captcha.
 *
 * Removes, in order:
 *   - the library dir the resolver currently picks — a repo-local ./library in a clone,
 *     $SWIPEKIT_HOME if set, otherwise ~/.swipekit/library
 *   - ~/.swipekit in full: the global library and the Chrome profile. Wiped even when
 *     the resolver above pointed elsewhere, so `npm run reset` from inside a clone that
 *     has its own ./library does not quietly leave the global library and its reports
 *     behind.
 *
 * Kills the live MCP server and its Chrome first rather than deleting out from under
 * them — a process holding either directory open mid-write is exactly how you get a
 * corrupted db or an orphaned profile lock. Derives every path from the real constants
 * in paths.ts and session.ts, so it cannot point at the wrong directory if that
 * resolution logic ever changes.
 *
 * It does not unregister the server from any agent — that entry lives in the client's
 * own config (`claude mcp add` and friends). It just relaunches against an empty
 * library the next time the client calls a tool.
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, sep } from "node:path";
import { LIBRARY_DIR } from "../store/paths.ts";
import { PROFILE_DIR } from "../collect/session.ts";

// ~/.swipekit, taken from PROFILE_DIR rather than rebuilt from homedir() here.
const SWIPEKIT_ROOT = dirname(PROFILE_DIR);

const kill = (pattern: string) => {
  try {
    execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
  } catch {
    // nothing matched — that's the common case, not an error
  }
};

const remove = (dir: string) => {
  console.log(`Removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });
};

// Every way the MCP server gets started: straight from source, from a global install
// or `npx`, and the `swipekit-mcp` bin by name. The HTTP transport (MCP_HTTP=1) is the
// same entry file, so killing the process frees its port too — nothing extra to clean.
console.log("Stopping the swipekit MCP server and its Chrome…");
kill("src/mcp.ts");
kill("dist/mcp.js");
kill("swipekit-mcp");
kill(`user-data-dir=${PROFILE_DIR}`);
await new Promise((r) => setTimeout(r, 1500)); // let the kills actually land before deleting

// The resolved library dir, unless it already sits inside ~/.swipekit — that case is
// covered by removing the root next, and deleting it twice would just log a phantom line.
if (LIBRARY_DIR !== SWIPEKIT_ROOT && !LIBRARY_DIR.startsWith(SWIPEKIT_ROOT + sep)) {
  remove(LIBRARY_DIR);
}
remove(SWIPEKIT_ROOT);

console.log("\nClean. The next search will hit TikTok's first-run captcha again, same as a new install.");
