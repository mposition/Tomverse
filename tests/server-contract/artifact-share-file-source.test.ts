// Contract: what a generated HTML file's share link is made from (docs/policy/generated-artifacts.md section 19).
//
//   * the file is read up to the preview's own limit, not up to the size its row recorded;
//   * a file larger than that limit is refused as too large -- never cut short;
//   * bytes that are not whole UTF-8 are refused rather than published with replacement characters;
//   * a file within the limit is shared byte for byte, even when the row recorded a smaller size.
//
// The database row and the object store are replaced; the service is real.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const LIMIT = 1_000_000;

const world = {
  bytes: Buffer.from("<h1>chart</h1>") as Buffer,
  tooLarge: false,
  reads: [] as Array<{ key: string; maxBytes: number }>,
  byteSize: 14,
};

const artifactRow = () => ({
  id: "art_1",
  messageId: "msg_1",
  conversationId: "conv_1",
  format: "html",
  filename: "chart.html",
  byteSize: world.byteSize,
  objectKey: "message-artifacts/user_1/conv_1/art_1.html",
  conversation: { userId: "user_1", kind: "chat", temporaryExpiresAt: null, password: null, continuationBridge: null },
  message: { researchRunId: null },
});

let service: typeof import("../../lib/artifactShareService");
const load = async () => {
  if (service) return service;
  const { BoundedBufferError } = await import(mod("lib/boundedBuffer.ts"));
  mock.module(mod("lib/prisma.ts"), {
    namedExports: { prisma: { messageArtifact: { findFirst: async () => artifactRow() } } },
  });
  mock.module(mod("lib/r2.ts"), {
    namedExports: {
      readOwnR2ObjectBytes: async (key: string, options: { maxBytes: number }) => {
        world.reads.push({ key, maxBytes: options.maxBytes });
        if (world.tooLarge) throw new BoundedBufferError();
        return world.bytes;
      },
    },
  });
  mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ allowSharing: true }) } });
  service = await import(mod("lib/artifactShareService.ts"));
  return service;
};

const OPEN = { sharingAvailable: true, planAllowsSharing: true };
const reset = (bytes: Buffer, byteSize = bytes.byteLength) => {
  world.bytes = bytes;
  world.byteSize = byteSize;
  world.tooLarge = false;
  world.reads = [];
};

test("a file is read up to the preview's limit, not up to the size its row recorded, and shared byte for byte", async () => {
  const { prepareArtifactShare } = await load();
  const page = Buffer.from("<h1>매출 차트</h1><p>2026</p>", "utf8");
  // The row says less than the object holds: the object is not cut to the row's figure.
  reset(page, 5);
  const outcome = await prepareArtifactShare("user_1", { kind: "artifact", artifactId: "art_1" }, OPEN);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.prepared.content, page.toString("utf8"));
  assert.deepEqual(world.reads, [{ key: "message-artifacts/user_1/conv_1/art_1.html", maxBytes: LIMIT }]);
});

test("a file larger than the limit is refused as too large, never truncated", async () => {
  const { prepareArtifactShare } = await load();
  reset(Buffer.from("x"), 10);
  world.tooLarge = true;
  const outcome = await prepareArtifactShare("user_1", { kind: "artifact", artifactId: "art_1" }, OPEN);
  assert.deepEqual(outcome, { ok: false, code: "ARTIFACT_SHARE_TOO_LARGE", status: 413 });
});

test("a recorded size over the limit is refused before the file is read", async () => {
  const { prepareArtifactShare } = await load();
  reset(Buffer.from("x"), LIMIT + 1);
  const outcome = await prepareArtifactShare("user_1", { kind: "artifact", artifactId: "art_1" }, OPEN);
  assert.deepEqual(outcome, { ok: false, code: "ARTIFACT_SHARE_TOO_LARGE", status: 413 });
  assert.deepEqual(world.reads, []);
});

test("bytes that are not whole UTF-8 are refused, not decoded with replacement characters", async () => {
  const { prepareArtifactShare } = await load();
  // "매" is three bytes; the last one is missing, as a cut-off file would be.
  const cut = Buffer.from("<p>매</p>", "utf8").subarray(0, 5);
  reset(cut);
  const outcome = await prepareArtifactShare("user_1", { kind: "artifact", artifactId: "art_1" }, OPEN);
  assert.deepEqual(outcome, { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 });
});
