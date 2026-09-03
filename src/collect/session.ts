import { chromium, type BrowserContext, type Page } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_DIR = join(homedir(), ".swipekit", "chrome-profile");

/**
 * A fixed local port so a second process can find the first one's browser. Chrome's own
 * profile lock only ever allows one owner — the second process used to discover this by
 * hanging for minutes inside launchPersistentContext with no explanation. Override with
 * SWIPEKIT_CDP_PORT on the rare machine where 9423 is already taken by something else.
 */
const CDP_PORT = Number(process.env.SWIPEKIT_CDP_PORT) || 9423;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const timeout = (ms: number, label: string) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms));

const rewriteMissingChromeError = (err: unknown): never => {
  // Rewriting the caught error rather than pre-checking a hardcoded path: Playwright
  // already knows the right install location per OS, and duplicating that table here
  // would just be a second copy to keep in sync.
  const msg = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist/.test(msg)) {
    throw new Error(
      "swipekit needs real Google Chrome installed, not just Playwright's bundled " +
        "Chromium. This project deliberately drives real Chrome for its TLS fingerprint " +
        "(Chromium's is distinguishable, and that is what gets a crawl soft-blocked before " +
        "it starts).\n\n" +
        "Fix, either way:\n" +
        "  npx playwright install chrome   (downloads real Chrome, not Chromium)\n" +
        "  or install Chrome yourself from google.com/chrome\n",
    );
  }
  throw err instanceof Error ? err : new Error(msg);
};

/** Someone else already has the profile open — reuse their browser instead of fighting it. */
async function attachToSibling(): Promise<BrowserContext | null> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    if (!ctx) return null; // unexpected shape — fall through and let launch fail honestly
    // stderr, not stdout: under the MCP stdio transport stdout is the JSON-RPC
    // channel and any stray text there corrupts the stream. stderr still reaches a
    // CLI user's terminal and the client's server-log pane.
    console.error("(reusing the Chrome another swipekit session already has open)");
    return ctx;
  } catch {
    return null; // the common case: nobody there. ~28ms when nothing is listening.
  }
}

async function launchPrimary(): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      // The debugging port is what makes attachToSibling possible for the next process
      // that needs this profile. Without it every additional session is a repeat of the
      // hang this whole function exists to prevent.
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        `--remote-debugging-port=${CDP_PORT}`,
      ],
    });
  } catch (err) {
    return rewriteMissingChromeError(err);
  }
}

/**
 * One persistent, logged-out, headful Chrome — shared across every process that asks for it.
 *
 * - channel:"chrome"    real Chrome => real TLS fingerprint (bundled Chromium's is distinguishable)
 * - headless:false      headless-shell is trivially detected; a visible window also lets us
 *                       hand a captcha back to the human instead of solving it
 * - persistent profile  cookies + msToken survive runs, so we look like a returning visitor
 *
 * We never log in. Everything we need is public and logged-out, and staying logged out is
 * the line between "public data" and "breach of the account's terms".
 *
 * Chrome only lets one process own the profile directory at a time. Two independent
 * swipekit sessions (two Claude Code windows, an agent plus a manual CLI call) used to
 * fight over that lock: the second one would call launchPersistentContext and just hang,
 * silently, for minutes — indistinguishable from a captcha or a network stall. There was
 * no error to act on.
 *
 * Now the second process checks for a sibling first (attachToSibling, over CDP, ~28ms when
 * there isn't one) and reuses its browser instead of trying to open a second one. Verified
 * this is safe to do: closing a context obtained this way does not close the other
 * process's real browser — it only detaches the local handle, confirmed by attaching from
 * a second process, closing that context, and checking the original session's page was
 * still alive and its state untouched afterward.
 *
 * A launch that still hangs — the narrow window where two processes start within
 * milliseconds of each other — now fails after 20s instead of running forever, retries the
 * attach once (the winner's port should be up by then), and only then raises a clear error
 * instead of leaving the caller staring at a stuck terminal.
 */
export async function openSession(): Promise<BrowserContext> {
  const sibling = await attachToSibling();
  if (sibling) return sibling;

  let ctx: BrowserContext;
  try {
    ctx = await Promise.race([launchPrimary(), timeout(20_000, "LAUNCH_TIMEOUT")]);
  } catch (err) {
    if (err instanceof Error && err.message === "LAUNCH_TIMEOUT") {
      const retry = await attachToSibling();
      if (retry) return retry;
      throw new Error(
        "Timed out opening Chrome for swipekit after 20s. Another swipekit session " +
          "may be starting one right now — wait a few seconds and try again.\n\n" +
          "If this keeps happening, check for a stuck Chrome window and close it, or run:\n" +
          `  pkill -f "user-data-dir=${PROFILE_DIR}"\n`,
      );
    }
    throw err;
  }

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return ctx;
}

/**
 * Window state, over CDP.
 *
 * Watching it scroll is genuinely useful, so the window stays visible while it works.
 * What is not useful is a full-size Chrome sitting in front of everything after the work
 * finished. Under MCP the context is deliberately kept alive between tool calls to keep
 * the profile warm and avoid re-triggering the captcha, so closing it is the wrong fix.
 * Minimising it is the right one: the process lives, your screen does not pay for it.
 *
 * CDP rather than AppleScript because this targets one window by id. Telling macOS to
 * hide "Google Chrome" would hide the user's own browser too, which shares the bundle.
 *
 * Every call is best-effort. Failing to move a window must never fail a crawl.
 */
type WindowHandle = { session: import("playwright").CDPSession; windowId: number };
const windowHandles = new WeakMap<BrowserContext, WindowHandle>();

async function windowHandle(ctx: BrowserContext): Promise<WindowHandle | null> {
  const cached = windowHandles.get(ctx);
  if (cached) return cached;
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const session = await ctx.newCDPSession(page);
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as any;
    const handle = { session, windowId };
    windowHandles.set(ctx, handle);
    return handle;
  } catch {
    return null;
  }
}

async function setWindowState(ctx: BrowserContext, windowState: "normal" | "minimized") {
  const h = await windowHandle(ctx);
  if (!h) return;
  try {
    await h.session.send("Browser.setWindowBounds", { windowId: h.windowId, bounds: { windowState } } as any);
  } catch {
    // Window already gone, or the browser is closing. Nothing to do.
  }
}

/** Bring the window back so you can watch it work. */
export const showBrowser = (ctx: BrowserContext) => setWindowState(ctx, "normal");

/** Get it off the screen while it has nothing to do. */
export const hideBrowser = (ctx: BrowserContext) => setWindowState(ctx, "minimized");

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const settle = (p: Page, a: number, b: number) => p.waitForTimeout(rand(a, b));

/** Break one scroll into several wheel ticks with jitter — constant deltas are the obvious tell. */
export async function humanScroll(page: Page) {
  const ticks = Math.floor(rand(3, 7));
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, rand(280, 620));
    await page.waitForTimeout(rand(40, 140));
  }
  if (Math.random() < 0.15) {
    await page.mouse.wheel(0, -rand(150, 400));
    await page.waitForTimeout(rand(200, 600));
  }
  if (Math.random() < 0.25) {
    await page.mouse.move(rand(200, 1000), rand(200, 700), { steps: Math.floor(rand(5, 15)) });
  }
  if (Math.random() < 0.06) {
    await page.waitForTimeout(rand(3000, 9000));
  }
}

export class BlockedError extends Error {}

export async function isBlocked(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const sel =
        "#captcha-verify-container, [class*='captcha_verify'], [class*='captcha-verify']," +
        "[class*='secsdk-captcha'], [id*='captcha_container']";
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.offsetParent !== null) return true;
      return /drag the slider|fit the puzzle|verify to continue/i.test(
        document.body.innerText.slice(0, 2000),
      );
    })
    .catch(() => false);
}

/**
 * Hand the captcha back to the human. We deliberately do not auto-solve — solver services
 * are a different risk posture, and at personal scale a captcha is rare enough to just do.
 * This is the entire reason we run headful.
 */
export async function waitForCaptcha(page: Page, maxMs = 240_000): Promise<boolean> {
  if (!(await isBlocked(page))) return true;

  // The one moment a human is genuinely needed, so this is the one moment worth stealing
  // focus for. Previously the message went to a terminal that Chrome was covering.
  await showBrowser(page.context());
  // stderr for the same reason as attachToSibling. The Chrome window is raised above,
  // so the human sees the slider even when this line only lands in a log pane.
  console.error("\n⚠  CAPTCHA — solve it in the Chrome window. Waiting up to 4 min…");
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(2000);
    if (!(await isBlocked(page))) {
      console.error("✓  cleared — resuming\n");
      await page.waitForTimeout(2000);
      return true;
    }
  }
  console.error("✗  still blocked after 4 min\n");
  return false;
}

/**
 * A cold profile hitting a hashtag listing as its very first request is a bot signature.
 * Land on the homepage, settle, scroll a little — then go where we're going. Because the
 * profile is persistent this only really costs us on the first run.
 */
export async function warmup(page: Page) {
  await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissConsent(page);
  await settle(page, 2500, 4500);
  await waitForCaptcha(page);
  await humanScroll(page);
  await settle(page, 1500, 3000);
}

/**
 * Decline non-essential cookies if the banner appears. Practically necessary (it blocks
 * scrolling) and it's the right default.
 */
export async function dismissConsent(page: Page) {
  const decline = page
    .locator(
      "button:has-text('Decline all'), button:has-text('Decline optional'), " +
        "button:has-text('Reject all'), [data-e2e='decline-all']",
    )
    .first();
  try {
    if (await decline.isVisible({ timeout: 3000 })) {
      await decline.click({ timeout: 3000 });
      await page.waitForTimeout(600);
    }
  } catch {
    /* no banner, or already dismissed */
  }
}
