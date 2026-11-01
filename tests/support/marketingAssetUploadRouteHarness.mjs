// Runs the media CLI's upload confirmation route against stand-ins for R2 and
// the store, and prints what each scenario did. Needs
// --experimental-test-module-mocks (tests/marketingAssetUploadRoute.test.mjs).

import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(path)).href;
const SECRET = "s".repeat(40);
const SHA = "a".repeat(64);

const world = {
  hashed: { sha256: SHA, size: 100, etag: '"v1"' },
  copyThrows: false,
  uploaded: false,
  confirmRefuses: false,
  calls: [],
};
const { MarketingAssetRefusedError } = await import(mod("lib/marketingAssetCore.ts"));

mock.module(mod("lib/r2.ts"), {
  namedExports: {
    validateR2ObjectMetadata: async (key) => {
      world.calls.push(`validate ${key}`);
      return { size: 100, contentType: "video/mp4", etag: '"v1"' };
    },
    hashR2Object: async (key) => {
      world.calls.push(`hash ${key}`);
      return world.hashed;
    },
    copyR2Object: async (from, to, options) => {
      world.calls.push(`copy ${from} -> ${to} if ${options?.ifMatch}`);
      if (world.copyThrows) throw new Error("PreconditionFailed");
    },
    deleteR2Object: async (key) => {
      world.calls.push(`delete ${key}`);
    },
  },
});

mock.module(mod("lib/marketingAssetStore.ts"), {
  namedExports: {
    readMarketingAssetUploadTarget: async () => ({
      uploadKey: "marketing-assets/media-a/upload.mp4",
      r2Key: "marketing-assets/media-a/original.mp4",
      kind: "video",
      contentType: "video/mp4",
      bytes: 100,
      sha256: SHA,
      uploaded: world.uploaded,
    }),
    confirmMarketingAssetUpload: async () => {
      world.calls.push("confirm");
      if (world.confirmRefuses) throw new MarketingAssetRefusedError("asset_not_submitted", 409, "decided");
      return { assetId: "media-a", uploadedAt: "2026-10-31T00:00:00.000Z" };
    },
  },
});

mock.module(mod("lib/marketingStore.ts"), {
  namedExports: { runMarketingTransaction: async (_client, run) => run({}) },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });

process.env.MARKETING_MEDIA_SUBMIT_SECRET = SECRET;
delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;

const { POST } = await import(mod("app/api/internal/marketing-assets/[assetId]/uploaded/route.ts"));

const call = async (scenario, setup, { secret = SECRET, assetId = "media-a" } = {}) => {
  world.hashed = { sha256: SHA, size: 100, etag: '"v1"' };
  world.copyThrows = false;
  world.uploaded = false;
  world.confirmRefuses = false;
  world.calls = [];
  setup?.();
  const response = await POST(
    new Request(`https://tomverse.app/api/internal/marketing-assets/${assetId}/uploaded`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ assetId }) },
  );
  const body = await response.json();
  return { scenario, status: response.status, code: body.code ?? null, calls: [...world.calls] };
};

const results = [
  await call("verified"),
  await call("hash mismatch", () => {
    world.hashed = { sha256: "b".repeat(64), size: 100, etag: '"v2"' };
  }),
  await call("replaced while verified", () => {
    world.copyThrows = true;
  }),
  await call("already uploaded", () => {
    world.uploaded = true;
  }),
  await call("wrong secret", undefined, { secret: "x".repeat(40) }),
  await call("decided meanwhile", () => {
    world.confirmRefuses = true;
  }),
];

console.log(`MARKETING_ASSET_UPLOAD_RESULTS=${JSON.stringify(results)}`);
