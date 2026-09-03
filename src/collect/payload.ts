/**
 * Pure readers for TikTok's item payload. No browser, no network, no database.
 *
 * Kept apart from the scroll loop because this is the shape most likely to change
 * underneath us, and because the storage layer needs it without needing Playwright.
 */
/** Slideshows live at /photo/<id> and carry an imagePost object. Videos don't. */
export const isPhotoPost = (item: any) => Boolean(item?.imagePost ?? item?.image_post_info);

export function slideUrls(item: any): string[] {
  const web = item?.imagePost?.images ?? [];
  if (web.length) return web.map((i: any) => i?.imageURL?.urlList?.[0]).filter(Boolean);
  const app = item?.image_post_info?.images ?? [];
  return app.map((i: any) => i?.thumbnail?.url_list?.[0]).filter(Boolean);
}
