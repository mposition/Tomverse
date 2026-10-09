import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activationPreflight, CONTENT_COLUMNS, completeVersionListing,
  LEGACY_KEY_COUNTS_SQL, summarizeCounts } from "../scripts/amux-v4-activation-preflight.mjs";

const rows = () => CONTENT_COLUMNS.map((_, ordinal) =>
  ({ ordinal, bodies: "0", legacy: "0" }));
const keys = () => ({
  AMUX_V4_CONTENT_MASTER_KEY_ID: "synthetic-master",
  AMUX_V4_CONTENT_MASTER_KEY_VERSION: "1",
  AMUX_V4_CONTENT_MASTER_KEY_B64: Buffer.alloc(32, 1).toString("base64"),
  AMUX_V4_CONTENT_DIGEST_KEY_ID: "synthetic-digest",
  AMUX_V4_CONTENT_DIGEST_KEY_B64: Buffer.alloc(32, 2).toString("base64"),
});

test("content count coverage matches every v4/v22 ciphertext field", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const actualColumns = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(([, name]) => /^(AmuxIdea|AmuxPortfolioNode$|AmuxWorkItem$|AmuxV22)/.test(name))
    .flatMap(([, name, model]) => [...model.matchAll(/^\s+(\w*[Cc]iphertext)\s+Bytes\?/gm)]
      .map(([, field]) => `${name}.${field}`));
  assert.deepEqual(CONTENT_COLUMNS.map(([name, field]) => `${name}.${field}`).sort(),
    actualColumns.sort(), "new v4/v22 encrypted tables must join the preflight inventory");
  for (const table of new Set(CONTENT_COLUMNS.map(([name]) => name))) {
    const model = schema.match(new RegExp(`model ${table} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(model);
    const bodies = [...model.matchAll(/^\s+(\w*[Cc]iphertext)\s+Bytes\?/gm)].map(m => m[1]);
    assert.deepEqual(CONTENT_COLUMNS.filter(([t]) => t === table).map(([, b]) => b).sort(), bodies.sort());
    for (const [, , key] of CONTENT_COLUMNS.filter(([t]) => t === table)) {
      assert.match(model, new RegExp(`\\b${key}\\s+String\\?`));
    }
  }
  assert.doesNotMatch(LEGACY_KEY_COUNTS_SQL, /\b(UPDATE|INSERT|DELETE|RETURNING)\b/);
});

test("zero is evidence; missing, duplicate, malformed and unsafe counts are not", () => {
  assert.deepEqual(summarizeCounts(rows()), { encryptedBodies: 0, legacyOrInvalidKeyBodies: 0 });
  for (const bad of [rows().slice(1), [...rows(), rows()[0]],
    rows().map(r => ({ ...r, ordinal: 0 })), rows().map(r => ({ ...r, bodies: "NaN" })),
    rows().map(r => ({ ...r, legacy: "1" })), rows().map(r => ({ ...r, bodies: "9007199254740992" }))]) {
    assert.equal(summarizeCounts(bad), null);
  }
  const legacy = rows();
  legacy[2] = { ordinal: 2, bodies: "3", legacy: "2" };
  assert.deepEqual(summarizeCounts(legacy), { encryptedBodies: 3, legacyOrInvalidKeyBodies: 2 });
});

test("incomplete or unsupported version listing never proves availability", () => {
  assert.equal(completeVersionListing({ IsTruncated: false }), true);
  assert.equal(completeVersionListing({ IsTruncated: false, Versions: [], DeleteMarkers: [] }), true);
  for (const response of [null, {}, { IsTruncated: true },
    { IsTruncated: false, Versions: [{}] }, { IsTruncated: false, DeleteMarkers: [{}] },
    { IsTruncated: false, NextKeyMarker: "hidden" }, { IsTruncated: false, Versions: "invalid" }]) {
    assert.equal(completeVersionListing(response), false);
  }
});

test("read-only success is not deletion proof or activation permission", async () => {
  const result = await activationPreflight({ env: keys(), readCounts: async () => rows(),
    listVersions: async () => ({ IsTruncated: false }) });
  assert.equal(result.appContentKeysConfigured, true);
  assert.equal(result.databaseCountsAvailable, true);
  assert.equal(result.keyStoreVersionListingAvailable, true);
  assert.equal(result.cryptographicDeletionVerified, false);
  assert.equal(result.runtimeActivated, false);
});

test("missing/equal keys and runtime exceptions fail closed without leaking values", async () => {
  for (const env of [{}, { ...keys(), AMUX_V4_CONTENT_DIGEST_KEY_B64:
      keys().AMUX_V4_CONTENT_MASTER_KEY_B64 }]) {
    const result = await activationPreflight({ env, readCounts: async () => { throw new Error("secret-db-url"); },
      listVersions: async () => { throw new Error("secret-access-key"); } });
    assert.equal(result.appContentKeysConfigured, false);
    assert.equal(result.databaseCountsAvailable, false);
    assert.equal(result.encryptedBodies, null);
    assert.equal(result.keyStoreVersionListingAvailable, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});
