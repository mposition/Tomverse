import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  checkMarketingFeatureProposals,
  MARKETING_FEATURE_FACT_ACTIONS,
  marketingFeatureFactCreateSchema,
  marketingFeatureFactUpdateSchema,
  marketingFeaturesDocument,
} from "../lib/marketingFeatureFactsCore.ts";
import { featuresFile, FEATURES_FILE_ENV, syncFeatures, usableFeatures } from "../tools/marketing-video/features-source.mjs";
import { loadFeatures } from "../tools/marketing-video/concepts-core.mjs";

/**
 * The ad facts list (owner request 2026-11-12): kept in MarketingFeatureFact,
 * edited in Admin, read by the box's Higgsfield job with features.json as the
 * fallback. A refresh only proposes; these tests pin what a proposal may be
 * and that the job reads one list everywhere.
 */

const tool = resolve("tools/marketing-video");
const repoFeatures = JSON.parse(readFileSync(join(tool, "features.json"), "utf8")).features;
const MIGRATION = readFileSync("prisma/migrations/20261112120000_marketing_feature_facts/migration.sql", "utf8");

const row = (id, extra = {}) => ({
  id,
  position: 0,
  what: `What ${id} does.`,
  models: [],
  realExample: null,
  copy: null,
  disclosure: null,
  source: `claim.${id}`,
  hold: null,
  updatedAt: new Date("2026-11-12T00:00:00Z"),
  ...extra,
});
const proposal = (kind, id, extra = {}) => ({
  kind,
  id,
  what: `What ${id} does now.`,
  models: [],
  copy: null,
  source: `claim.${id}`,
  hold: null,
  reason: "The FAQ says so.",
  ...extra,
});

test("the migration seeds every entry of features.json, in order", () => {
  // Ids and order only: after the seed the Admin list is the source, and this
  // file is its fallback copy, so its wording moves with the list (2026-11-13).
  repoFeatures.forEach((feature, index) => {
    assert.ok(MIGRATION.includes(`('${feature.id}', ${index}, `), feature.id);
  });
});

test("the document the job reads has the shape of features.json", () => {
  const document = marketingFeaturesDocument([
    row("review", { position: 1, models: ["GPT 6 Luna"] }),
    row("chat", { position: 0, hold: "Not live." }),
  ]);
  assert.equal(typeof document.note, "string");
  assert.deepEqual(document.features.map((entry) => entry.id), ["chat", "review"]);
  // Absent fields are left out, as the file writes them.
  assert.deepEqual(document.features[0], { id: "chat", what: "What chat does.", source: "claim.chat", hold: "Not live." });
  assert.deepEqual(document.features[1].models, ["GPT 6 Luna"]);
  assert.equal(usableFeatures(document), true);
});

test("an operator edits wording, models, source and hold, never the disclosure or the recorded example", () => {
  const base = { id: "memory", what: "Memory.", models: [], copy: "", source: "claim.x", hold: "" };
  const created = marketingFeatureFactCreateSchema.parse(base);
  assert.equal(created.copy, null, "an emptied field is none");
  assert.equal(created.hold, null);
  for (const extra of [{ disclosure: { en: "x" } }, { realExample: {} }, { position: 3 }]) {
    assert.equal(marketingFeatureFactCreateSchema.safeParse({ ...base, ...extra }).success, false, Object.keys(extra)[0]);
  }
  assert.equal(marketingFeatureFactUpdateSchema.safeParse(base).success, false, "an update names the row it saw");
  assert.equal(marketingFeatureFactUpdateSchema.safeParse({ ...base, expectedUpdatedAt: "2026-11-12T00:00:00.000Z" }).success, true);
  assert.equal(marketingFeatureFactCreateSchema.safeParse({ ...base, id: "Bad Id" }).success, false);
  assert.deepEqual(MARKETING_FEATURE_FACT_ACTIONS, { create: "marketing_feature_fact.create", update: "marketing_feature_fact.update" });
});

test("a refresh proposal is kept only when it is a real change the list can take", () => {
  const current = [row("chat"), row("plugins", { hold: "Not live." })];
  const { proposals, dropped } = checkMarketingFeatureProposals(
    {
      proposals: [
        proposal("add", "voice-input", { hold: "Not live: switch off." }),
        proposal("add", "chat"), // exists
        proposal("update", "unknown"), // missing
        proposal("update", "chat", { what: "What chat does.", source: "claim.chat" }), // no change
        proposal("release_hold", "chat"), // no hold to release
        proposal("release_hold", "plugins", { hold: "still held" }), // keeps a hold
        proposal("release_hold", "plugins"),
        proposal("update", "chat", { what: "" }), // breaks the field rules
        proposal("update", "chat", { extra: true }),
        proposal("add", "voice-input"), // the same id twice
      ],
    },
    current,
  );
  assert.deepEqual(proposals.map((entry) => `${entry.kind}:${entry.id}`), ["add:voice-input", "release_hold:plugins"]);
  assert.equal(dropped, 8);
  assert.deepEqual(checkMarketingFeatureProposals(null, current), { proposals: [], dropped: 0 });
});

test("the job takes the app's list and every later read names that file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "features-"));
  try {
    const document = marketingFeaturesDocument([row("chat"), row("review", { position: 1 })]);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization });
      return new Response(JSON.stringify({ result: document }), { status: 200 });
    };
    const env = { MARKETING_APP_URL: "https://tomverse.app", MARKETING_MEDIA_SUBMIT_SECRET: "s".repeat(40) };
    const out = join(dir, "features.json");
    const synced = await syncFeatures({ toolDir: tool, out, env, fetchImpl });
    assert.deepEqual(synced, { source: "app", file: out });
    assert.deepEqual(calls, [{ url: "https://tomverse.app/api/internal/marketing-features", authorization: `Bearer ${"s".repeat(40)}` }]);
    assert.equal(featuresFile(tool, { [FEATURES_FILE_ENV]: out }), out);

    const before = process.env[FEATURES_FILE_ENV];
    process.env[FEATURES_FILE_ENV] = out;
    try {
      assert.deepEqual(loadFeatures(tool).map((entry) => entry.id), ["chat", "review"]);
    } finally {
      if (before === undefined) delete process.env[FEATURES_FILE_ENV];
      else process.env[FEATURES_FILE_ENV] = before;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the job falls back to features.json when the app cannot give a usable list", async () => {
  const env = { MARKETING_APP_URL: "https://tomverse.app", MARKETING_MEDIA_SUBMIT_SECRET: "s".repeat(40) };
  const repo = join(tool, "features.json");
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const cases = [
    [{ toolDir: tool, out: "unused", env: {} }, "not_configured"],
    [{ toolDir: tool, out: "unused", env, fetchImpl: async () => { throw new Error("down"); } }, "unreachable"],
    [{ toolDir: tool, out: "unused", env, fetchImpl: answer(503, { code: "kill_switch" }) }, "http_503_kill_switch"],
    [{ toolDir: tool, out: "unused", env, fetchImpl: answer(200, { result: { features: [] } }) }, "http_200"],
    [{ toolDir: tool, out: "unused", env, fetchImpl: answer(200, { result: { features: [{ id: "chat" }] } }) }, "http_200"],
  ];
  for (const [input, reason] of cases) assert.deepEqual(await syncFeatures(input), { source: "repo", file: repo, reason });
  // No chosen file, or one that is gone: the repository's.
  assert.equal(featuresFile(tool, {}), repo);
  assert.equal(featuresFile(tool, { [FEATURES_FILE_ENV]: join(tmpdir(), "missing-features.json") }), repo);
});

test("run-higgsfield reads, copies and prompts with the one synced file", () => {
  const source = readFileSync(join(tool, "run-higgsfield.mjs"), "utf8");
  assert.match(source, /await syncFeatures\(/u);
  assert.match(source, /process\.env\[FEATURES_FILE_ENV\] = synced\.file/u);
  assert.doesNotMatch(source, /readFileSync\("features\.json"|copyFileSync\("features\.json"/u);
  assert.match(readFileSync(join(tool, "make-card.mjs"), "utf8"), /readFileSync\(featuresFile\(toolDir\)/u);
});
