import assert from "node:assert/strict";
import test from "node:test";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";

test("Desktop accepts 2K image quotes and isolates an unsupported image catalogue from text capabilities", async (t) => {
  let size = "2048x2048";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    autoSelection: { offered: true }, desktopWrite: true, desktopAttachments: true,
    desktopReview: { easy: true, modelLimit: 3, plan: "Max" },
    desktopImages: { maxModels: 2, models: [{ id: "recraftv4_pro", name: "Recraft V4 Pro", provider: "recraft",
      pricingVersion: "fixture", prices: [{ size, quality: "high", credits: 350 }] }] },
  }));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  const supported = await load();
  assert.equal(supported?.images?.models[0].prices[0].size, size);
  assert.equal(supported?.review?.modelLimit, 3);
  size = "4096x4096";
  const invalid = await load();
  assert.equal(invalid?.images, null);
  assert.equal(invalid?.chatWrite, true);
  assert.equal(invalid?.attachments, true);
  assert.equal(invalid?.review?.modelLimit, 3);
});
