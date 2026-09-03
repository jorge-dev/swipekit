import type { Page } from "playwright";
import { BlockedError, dismissConsent, humanScroll, isBlocked, settle, waitForCaptcha } from "./session.ts";

/**
 * Feed endpoints TikTok's own JS calls as you scroll. We don't call these — we listen for
 * them. The page supplies msToken / X-Bogus / signatures / cookies / cursor sequencing,
 * because it genuinely is the app making the request.
 */
const FEEDS = [
  "/api/search/general/full",
  "/api/search/item/full",
  "/api/search/user/full",
  "/api/post/item_list",
  "/api/challenge/item_list",
  "/api/music/item_list",
  "/api/recommend/item_list",
];

export type HarvestResult = {
  items: any[];
  sawEnd: boolean;
  scrolls: number;
  hits: { url: string; count: number }[];
};

export async function harvest(
  page: Page,
  url: string,
  opts: { target?: number; maxScrolls?: number } = {},
): Promise<HarvestResult> {
  const target = opts.target ?? 200;
  const maxScrolls = opts.maxScrolls ?? 120;

  const seen = new Map<string, any>();
  const hits = new Map<string, number>();
  const pending: Promise<void>[] = [];
  let sawEnd = false;

  const onResponse = (res: any) => {
    const u: string = res.url();
    const matched = FEEDS.find((f) => u.includes(f));
    if (!matched || res.status() !== 200) return;

    // Read the body now, but don't block the listener. We await these between scrolls.
    pending.push(
      (async () => {
        let body: any;
        try {
          body = await res.json();
        } catch {
          return; // empty body, redirect, or navigated away before we read it
        }

        const batch: any[] = body.itemList ?? body.item_list ?? body.data ?? body.user_list ?? [];
        if (!Array.isArray(batch)) return;

        let added = 0;
        for (const raw of batch) {
          // search endpoints wrap the post one level deeper than feed endpoints
          const item = raw.item ?? raw.aweme_info ?? raw;
          const id = item?.id ?? item?.aweme_id ?? raw?.user_info?.sec_uid;
          if (id && !seen.has(String(id))) {
            seen.set(String(id), item);
            added++;
          }
        }
        if (added) hits.set(matched, (hits.get(matched) ?? 0) + added);
        if (body.hasMore === false || body.has_more === 0) sawEnd = true;
      })(),
    );
  };

  page.on("response", onResponse);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await dismissConsent(page);
    await settle(page, 2000, 4000);

    // The gated response is a 200 with an empty body, so clear the captcha before we
    // start counting idle rounds — otherwise we'd silently report "no posts".
    if (!(await waitForCaptcha(page))) throw new BlockedError(`captcha at ${page.url()}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page, 2000, 3500);

    let idleRounds = 0;
    let scrolls = 0;

    for (; scrolls < maxScrolls; scrolls++) {
      await Promise.allSettled(pending.splice(0));
      if (seen.size >= target || sawEnd) break;
      if (await isBlocked(page)) {
        if (!(await waitForCaptcha(page))) throw new BlockedError(`captcha at ${page.url()}`);
      }

      const before = seen.size;
      await humanScroll(page);
      await settle(page, 900, 2200);
      await Promise.allSettled(pending.splice(0));

      // nothing new for 4 consecutive rounds => end of feed, or a silent soft-block
      idleRounds = seen.size === before ? idleRounds + 1 : 0;
      if (idleRounds >= 4) break;
    }

    await Promise.allSettled(pending.splice(0));

    return {
      items: [...seen.values()],
      sawEnd,
      scrolls,
      hits: [...hits].map(([url, count]) => ({ url, count })),
    };
  } finally {
    page.off("response", onResponse);
  }
}
