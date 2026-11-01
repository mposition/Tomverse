import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

// docs/policy/marketing-automation.md section 5 asks that every AppSetting key
// the marketing automation uses has an audited writer or an explicit reason it
// has none. The landing experiment's keys live with the experiment
// (lib/marketingExperimentContract.ts) rather than in lib/appSettings.ts,
// which is a sealed Prompt Refiner closure file, so this test is where their
// writers are enumerated. A new file that touches one of them fails here until
// it is named, with a reason, below.

const root = join(import.meta.dirname, "..");
const SOURCE_DIRECTORIES = ["lib", "app", "components", "scripts"];

const sources = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) {
      sources.push({
        path: relative(root, path).split(sep).join("/"),
        text: readFileSync(path, "utf8"),
      });
    }
  }
};
for (const directory of SOURCE_DIRECTORIES) walk(join(root, directory));

const filesMentioning = (identifier) =>
  sources
    .filter((source) => new RegExp(`\\b${identifier}\\b`).test(source.text))
    .map((source) => source.path)
    .sort();

test("the experiment configuration row is written only by the audited start and stop", () => {
  assert.deepEqual(
    filesMentioning("MARKETING_EXPERIMENT_CONFIG_KEY"),
    [
      // The name.
      "lib/marketingExperimentContract.ts",
      // The only writer: start and stop, inside runMarketingAdminMutation's
      // transaction, behind the human audit row.
      "lib/marketingExperimentStore.ts",
      // Read: the visitor-facing activation check.
      "lib/marketingExperimentState.ts",
      // The audit target id of the two routes that call the writer.
      "app/api/admin/marketing/experiments/route.ts",
      "app/api/admin/marketing/experiments/stop/route.ts",
    ].sort()
  );
  const store = sources.find((source) => source.path === "lib/marketingExperimentStore.ts").text;
  assert.match(store, /tx\.appSetting\.(?:create|updateMany)\(\{\s*(?:data:\s*\{\s*)?(?:where:\s*\{\s*)?key: MARKETING_EXPERIMENT_CONFIG_KEY/);
  const state = sources.find((source) => source.path === "lib/marketingExperimentState.ts").text;
  assert.doesNotMatch(
    state,
    /appSetting\.(?:create|update|updateMany|upsert|delete|deleteMany)\(/,
    "the visitor-facing reader must not write the configuration"
  );
});

test("an experiment id's permanent record is written once, by the start, and read nowhere else", () => {
  assert.deepEqual(filesMentioning("MARKETING_EXPERIMENT_USED_PREFIX"), [
    "lib/marketingExperimentContract.ts",
    "lib/marketingExperimentStore.ts",
  ]);
});

test("a met stop rule is recorded once, insert-if-absent, and read only by the experiment's own modules", () => {
  assert.deepEqual(filesMentioning("MARKETING_EXPERIMENT_TRIPPED_PREFIX"), [
    "lib/marketingExperimentContract.ts",
    "lib/marketingExperimentCore.ts",
  ]);
  assert.deepEqual(filesMentioning("experimentTrippedKey"), [
    "lib/marketingExperimentCore.ts",
    "lib/marketingExperimentState.ts",
  ]);
  const state = sources.find((source) => source.path === "lib/marketingExperimentState.ts").text;
  // Never updated or deleted: the only statement that names the key is a
  // do-nothing-on-conflict insert.
  assert.match(state, /ON CONFLICT \("key"\) DO NOTHING/);
});

test("experiment counters are incremented in one place, with one statement", () => {
  assert.deepEqual(filesMentioning("incrementExperimentCounter"), [
    // The writer, and the public route that calls it for a consented,
    // validated exposure or click.
    "app/api/marketing/experiments/route.ts",
    "lib/marketingExperimentState.ts",
  ]);
  // The counter prefix is the namespace those rows live in; the files that
  // name it are the contract, the key builder, the reader and the stop's tally.
  assert.deepEqual(filesMentioning("MARKETING_EXPERIMENT_COUNTER_PREFIX"), [
    "lib/marketingExperimentContract.ts",
    "lib/marketingExperimentCore.ts",
    "lib/marketingExperimentState.ts",
    "lib/marketingExperimentStore.ts",
  ]);
  const state = sources.find((source) => source.path === "lib/marketingExperimentState.ts").text;
  // An atomic increment, not a read followed by a write.
  assert.match(state, /ON CONFLICT \("key"\) DO UPDATE/);
  // The lock, the increment and the stop-rule record: three statements.
  assert.equal((state.match(/\$executeRaw/g) ?? []).length, 3);
  // The increment and the judgement of the counters it leaves are one
  // transaction under one per-experiment lock, in that order: a counter change
  // that is judged on a later, different state can miss the moment the rule
  // was met. (No database is available to this test, so the structure is what
  // it can hold; the order is what makes the judgement exact.)
  const body = state.slice(state.indexOf("export async function incrementExperimentCounter"));
  const at = (needle) => body.indexOf(needle);
  assert.ok(at("prisma.$transaction(") > 0, "increment runs in a transaction");
  assert.ok(at("pg_advisory_xact_lock(hashtext(") > at("prisma.$transaction("));
  assert.ok(at('ON CONFLICT ("key") DO UPDATE') > at("pg_advisory_xact_lock("));
  assert.ok(at("await recordStopRuleTrip(tx, config)") > at('ON CONFLICT ("key") DO UPDATE'));
  assert.ok(
    !/prisma\.(?:appSetting|\$executeRaw)/.test(body.slice(body.indexOf("async function recordStopRuleTrip"))),
    "the judgement reads through the transaction, not around it"
  );
});

test("the experiments switch has no writer in this feature", () => {
  // Turning landing experiments on is an operator step (policy 9.1); the start
  // route only reads the switch through the shared access resolver.
  const writers = sources
    .filter((source) => source.path.startsWith("lib/marketingExperiment"))
    .filter((source) =>
      [
        ...source.text.matchAll(
          /appSetting\.(?:create|update|updateMany|upsert|delete|deleteMany)\(([\s\S]{0,400}?)\)\s*;/g
        ),
      ].some((match) => /MARKETING_EXPERIMENTS_KEY/.test(match[1]))
    );
  assert.deepEqual(writers.map((source) => source.path), []);
  // And the check above can see a write when there is one.
  const probe =
    "await tx.appSetting.upsert({ where: { key: MARKETING_EXPERIMENTS_KEY }, update: {}, create: {} });";
  assert.ok(
    /appSetting\.(?:create|update|updateMany|upsert|delete|deleteMany)\(([\s\S]{0,400}?)\)\s*;/.exec(probe)
  );
});
