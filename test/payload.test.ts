import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPhotoPost, slideUrls } from "../src/collect/payload.ts";

/**
 * The parsing seam. Everything else in the pipeline is downstream of these two functions
 * getting TikTok's payload shape right, and the shape is the thing most likely to change
 * out from under us.
 */
describe("payload parsing", () => {
  it("recognises a web slideshow payload", () => {
    assert.equal(isPhotoPost({ imagePost: { images: [] } }), true);
  });

  it("recognises the app payload shape too", () => {
    assert.equal(isPhotoPost({ image_post_info: { images: [] } }), true);
  });

  it("does not mistake a video for a slideshow", () => {
    assert.equal(isPhotoPost({ video: { playAddr: "https://example.test/v.mp4" } }), false);
    assert.equal(isPhotoPost({}), false);
    assert.equal(isPhotoPost(null), false);
  });

  it("pulls slide urls from the web shape in order", () => {
    const urls = slideUrls({
      imagePost: {
        images: [
          { imageURL: { urlList: ["https://example.test/a.jpg", "https://cdn2.test/a.jpg"] } },
          { imageURL: { urlList: ["https://example.test/b.jpg"] } },
        ],
      },
    });
    assert.deepEqual(urls, ["https://example.test/a.jpg", "https://example.test/b.jpg"]);
  });

  it("falls back to the app shape when the web shape is absent", () => {
    const urls = slideUrls({
      image_post_info: { images: [{ thumbnail: { url_list: ["https://example.test/x.jpg"] } }] },
    });
    assert.deepEqual(urls, ["https://example.test/x.jpg"]);
  });

  it("drops entries with no usable url rather than emitting undefined", () => {
    const urls = slideUrls({
      imagePost: {
        images: [
          { imageURL: { urlList: [] } },
          { imageURL: { urlList: ["https://example.test/ok.jpg"] } },
          {},
        ],
      },
    });
    assert.deepEqual(urls, ["https://example.test/ok.jpg"]);
  });

  it("returns an empty list for a video, which is what slide_count 0 depends on", () => {
    assert.deepEqual(slideUrls({ video: {} }), []);
  });
});
