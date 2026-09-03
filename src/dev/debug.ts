/**
 * Observe what a TikTok surface actually does: every /api/ call, the final URL,
 * what's in the rehydration blob, and a screenshot.
 *
 *   npm run debug -- --url https://www.tiktok.com/tag/toddlermom
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dismissConsent, humanScroll, openSession, settle } from "../collect/session.ts";
import { libPath } from "../store/paths.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "https://www.tiktok.com/tag/toddlermom");
const rounds = Number(arg("rounds", "6"));

const ctx = await openSession();
const page = ctx.pages()[0] ?? (await ctx.newPage());

const reqs: { method: string; url: string }[] = [];
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.includes("/passport/") || u.includes("captcha")) {
    reqs.push({ method: r.method(), url: u.split("?")[0] + (u.includes("?") ? "?…" : "") });
  }
});

const responses: { status: number; url: string; bytes: number }[] = [];
page.on("response", async (r) => {
  const u = r.url();
  if (!u.includes("/api/")) return;
  let bytes = -1;
  try {
    bytes = (await r.body()).length;
  } catch {}
  responses.push({ status: r.status(), url: u.split("?")[0], bytes });
});

mkdirSync(libPath("debug"), { recursive: true });

console.log(`\n→ goto ${url}`);
const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
console.log(`   http ${resp?.status()}`);
await dismissConsent(page);
await settle(page, 3000, 5000);

console.log(`   final url : ${page.url()}`);
console.log(`   title     : ${await page.title()}`);

const state = await page.evaluate(() => {
  const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  let scopeKeys: string[] = [];
  const itemCounts: Record<string, number> = {};
  if (el?.textContent) {
    try {
      const scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__ ?? {};
      scopeKeys = Object.keys(scope);
      for (const k of scopeKeys) {
        const v: any = (scope as any)[k];
        for (const listKey of ["itemList", "items", "userList", "challengeInfo"]) {
          if (Array.isArray(v?.[listKey])) itemCounts[`${k}.${listKey}`] = v[listKey].length;
        }
      }
    } catch {}
  }
  return {
    hasBlob: Boolean(el),
    scopeKeys,
    itemCounts,
    bodyChars: document.body.innerText.length,
    firstText: document.body.innerText.slice(0, 400).replace(/\n{2,}/g, "\n"),
    captcha: Boolean(document.querySelector("[class*='captcha'], #captcha-verify-container")),
    loginModal: Boolean(document.querySelector("[id*='login'], [class*='login-modal']")),
    anchors: [...document.querySelectorAll("a[href*='/video/'], a[href*='/photo/']")].length,
  };
});

console.log(`\n   rehydration blob : ${state.hasBlob}`);
console.log(`   scope keys       : ${state.scopeKeys.join(", ") || "(none)"}`);
console.log(`   embedded lists   : ${JSON.stringify(state.itemCounts)}`);
console.log(`   post anchors     : ${state.anchors}`);
console.log(`   captcha / login  : ${state.captcha} / ${state.loginModal}`);
console.log(`   body text        : ${state.bodyChars} chars`);
console.log(`\n--- first text on page ---\n${state.firstText}\n---`);

console.log(`\n→ scrolling ${rounds} rounds…`);
for (let i = 0; i < rounds; i++) {
  await humanScroll(page);
  await settle(page, 1200, 2200);
}

const anchorsAfter = await page.evaluate(
  () => [...document.querySelectorAll("a[href*='/video/'], a[href*='/photo/']")].length,
);
console.log(`   post anchors after scroll: ${anchorsAfter}`);

console.log(`\n--- /api/ requests (${reqs.length}) ---`);
const uniq = [...new Set(reqs.map((r) => `${r.method} ${r.url}`))];
for (const u of uniq) console.log(`  ${u}`);

console.log(`\n--- /api/ responses (${responses.length}) ---`);
for (const r of responses.slice(0, 40)) console.log(`  ${r.status}  ${r.bytes}B  ${r.url}`);

const shot = libPath("debug", `shot-${Date.now()}.png`);
await page.screenshot({ path: shot, fullPage: false });
writeFileSync(
  libPath("debug", "state.json"),
  JSON.stringify({ url: page.url(), state, uniq, responses }, null, 2),
);
console.log(`\nscreenshot → ${shot}\n`);

await ctx.close();
