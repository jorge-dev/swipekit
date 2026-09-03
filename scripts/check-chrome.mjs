#!/usr/bin/env node
/**
 * Runs on `npm install`, so a missing Chrome is a one-line notice at setup time instead of
 * a surprise the first time someone's agent calls a browser-driving tool.
 *
 * Never fails the install. This is advisory: someone might be about to install Chrome next,
 * or be setting this up on a machine that will get it later. A postinstall script that exits
 * non-zero breaks `npm install` outright, which is a worse experience than the thing it is
 * trying to prevent.
 *
 * Resolves the real path Playwright resolves rather than a hardcoded per-OS guess — that
 * table already exists inside Playwright and would only drift if duplicated here. A quick
 * headless launch-and-close is the only way to ask it "is channel chrome actually there"
 * without launching from openSession() itself later.
 */
import { chromium } from "playwright-core";

try {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  await browser.close();
} catch {
  console.log(
    "\n" +
      "  ⚠  swipekit needs real Google Chrome, and it isn't found on this machine.\n" +
      "     This project deliberately drives real Chrome rather than Playwright's bundled\n" +
      "     Chromium — Chromium's TLS fingerprint is distinguishable and gets a crawl\n" +
      "     soft-blocked before it starts.\n\n" +
      "     Install it before you run anything that opens the browser:\n" +
      "       Install Google Chrome from google.com/chrome (the real one, not Chromium)\n" +
      "       or from google.com/chrome\n",
  );
}
