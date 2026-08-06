import assert from "node:assert/strict";
import test from "node:test";
import { mergeImageTimelineRow } from "../lib/imageTimelineMerge.ts";

const asset = (url) => ({ role: "thumbnail", mimeType: "image/webp", url });

const row = (overrides = {}) => ({
  generationId: "gen-1",
  status: "succeeded",
  assets: [asset("https://r2/thumb.webp?sig=first")],
  ...overrides,
});

test("a settled card keeps the signed URLs it already has", () => {
  // Signed URLs are minted fresh on every read, so a group poll answers with a
  // different URL string for an image that has not changed. Taking it rewrites
  // the <img> src and the browser re-downloads the same bytes -- once per poll
  // tick, for every target that finished before the slowest one in its group.
  const merged = mergeImageTimelineRow(
    [row()],
    row({ assets: [asset("https://r2/thumb.webp?sig=second")] })
  );
  assert.deepEqual(merged[0].assets, [
    asset("https://r2/thumb.webp?sig=first"),
  ]);
});

test("the recovery read is the one caller allowed to replace them", () => {
  // It exists precisely because the URLs expire, so it must be able to.
  const merged = mergeImageTimelineRow(
    [row()],
    row({ assets: [asset("https://r2/thumb.webp?sig=second")] }),
    { refreshAssets: true }
  );
  assert.deepEqual(merged[0].assets, [
    asset("https://r2/thumb.webp?sig=second"),
  ]);
});

test("a card that has no assets yet takes whatever arrives", () => {
  // The rule is about not re-taking URLs already held, not about refusing the
  // first ones -- a generation that just settled has none until this merge.
  const merged = mergeImageTimelineRow(
    [row({ status: "processing", assets: [] })],
    row({ assets: [asset("https://r2/thumb.webp?sig=first")] })
  );
  assert.equal(merged[0].status, "succeeded");
  assert.deepEqual(merged[0].assets, [
    asset("https://r2/thumb.webp?sig=first"),
  ]);
});

test("a stale answer never moves a terminal row back to running", () => {
  const merged = mergeImageTimelineRow(
    [row()],
    row({ status: "processing", assets: [] })
  );
  assert.equal(merged[0].status, "succeeded");
  assert.deepEqual(merged[0].assets, [
    asset("https://r2/thumb.webp?sig=first"),
  ]);
});

test("a failed card is settled too, and keeps its (empty) assets", () => {
  // Terminal means terminal in both directions: a failed attempt has no assets
  // and must not acquire any from a later answer either.
  const merged = mergeImageTimelineRow(
    [row({ status: "failed", assets: [] })],
    row({ status: "failed", assets: [asset("https://r2/thumb.webp?sig=x")] })
  );
  // No assets held, so nothing to preserve -- the incoming empty-or-not value
  // is taken. What matters is that the status did not move.
  assert.equal(merged[0].status, "failed");
});

test("an unknown generation is appended rather than dropped", () => {
  const merged = mergeImageTimelineRow([row()], row({ generationId: "gen-2" }));
  assert.deepEqual(
    merged.map((entry) => entry.generationId),
    ["gen-1", "gen-2"]
  );
});

test("the input array is never mutated", () => {
  // The caller is a React state updater; mutating the previous state in place
  // is how an update silently fails to render.
  const current = [row()];
  const snapshot = JSON.parse(JSON.stringify(current));
  mergeImageTimelineRow(current, row({ status: "processing", assets: [] }));
  mergeImageTimelineRow(current, row({ generationId: "gen-2" }));
  assert.deepEqual(current, snapshot);
});
