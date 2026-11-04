import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * PATCH /api/admin/marketing/settings: the four console switches
 * (operator decision 2026-11-04 added landing experiments).
 *
 * The permission, step-up, rate limit and the human audit row in the same
 * transaction are the shared wrapper's, swept for every marketing route in
 * tests/marketingS2b1Store.test.mjs. The wrapper is replaced here by one that
 * captures the spec, so this pins what the route hands it: the exact audit
 * action per switch, the gate (off is never refused), and the real writer
 * running against an in-memory AppSetting table.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

type Spec = {
  action: (body: unknown) => string;
  targetType: string;
  targetId: (body: unknown) => string;
  gate: (body: unknown) => string;
  bucket: string;
  schema: { safeParse: (body: unknown) => { success: boolean } };
  metadata: (body: unknown) => Record<string, unknown>;
  refusal: (error: unknown) => { code: string; status: number; message: string } | null;
  run: (tx: unknown, context: unknown) => Promise<unknown>;
};

let captured: Spec | null = null;
mock.module(mod("lib/marketingAdminMutations.ts"), {
  namedExports: {
    runMarketingAdminMutation: async (spec: Spec) => {
      captured = spec;
      return new Response(null, { status: 204 });
    },
  },
});

const rows = new Map<string, string>();
const tx = {
  appSetting: {
    findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.filter((key) => rows.has(key)).map((key) => ({ key, value: rows.get(key) })),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { value: string } }) => {
      rows.set(where.key, rows.has(where.key) ? update.value : create.value);
    },
    create: async ({ data }: { data: { key: string; value: string } }) => {
      rows.set(data.key, data.value);
    },
    updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
      if (rows.get(where.key) !== where.value) return { count: 0 };
      rows.set(where.key, data.value);
      return { count: 1 };
    },
  },
};

// No top-level await: this file is CommonJS to the transform, like its siblings.
let specPromise: Promise<Spec> | null = null;
const loadSpec = () => {
  specPromise ??= (async () => {
    const { PATCH } = await import(mod("app/api/admin/marketing/settings/route.ts"));
    await PATCH(new Request("https://tomverse.app/api/admin/marketing/settings", { method: "PATCH" }));
    return captured as unknown as Spec;
  })();
  return specPromise;
};
const body = (name: string, enabled: boolean, expectedConfigGeneration = 0) => ({
  switch: name,
  enabled,
  expectedConfigGeneration,
});

test("each switch records its own audit action, experiments included", async () => {
  const spec = await loadSpec();
  assert.deepEqual(
    ["drafts", "publish", "autonomous", "experiments"].map((name) => spec.action(body(name, true))),
    [
      "marketing_setting.drafts_changed",
      "marketing_setting.publish_changed",
      "marketing_setting.autonomous_changed",
      "marketing_setting.experiments_changed",
    ],
  );
  assert.equal(spec.targetType, "AppSetting");
  assert.equal(spec.targetId(body("experiments", true)), "experiments");
  assert.equal(spec.bucket, "admin-marketing-switch");
  assert.deepEqual(spec.metadata(body("experiments", false)), { switch: "experiments", enabled: false });
});

test("turning experiments on is behind the kill switch, turning it off never is", async () => {
  const spec = await loadSpec();
  assert.equal(spec.gate(body("experiments", true)), "account_control");
  assert.equal(spec.gate(body("experiments", false)), "operator_restriction");
});

test("the body takes only the four known switches and the generation the screen read", async () => {
  const spec = await loadSpec();
  const parses = (value: unknown) => spec.schema.safeParse(value).success;
  assert.equal(parses(body("experiments", true)), true);
  assert.equal(parses(body("webhookShadow", true)), false);
  assert.equal(parses(body("webhookApplyScope", true)), false);
  assert.equal(parses({ switch: "experiments", enabled: true }), false);
  assert.equal(parses({ ...body("experiments", true), extra: 1 }), false);
});

test("the writer's refusals keep their status and anything else falls through", async () => {
  const spec = await loadSpec();
  const { MarketingSwitchRefusedError } = await import(mod("lib/marketingSwitchWriter.ts"));
  assert.deepEqual(spec.refusal(new MarketingSwitchRefusedError("switch_conflict", "moved")), {
    code: "switch_conflict",
    status: 409,
    message: "moved",
  });
  assert.equal(spec.refusal(new Error("boom")), null);
});

test("experiments turns on and off through the writer, moving the generation each time", async () => {
  const spec = await loadSpec();
  const { MARKETING_EXPERIMENTS_KEY } = await import(mod("lib/marketingAutomationAccess.ts"));
  const { MARKETING_CONFIG_GENERATION_KEY } = await import(mod("lib/appSettings.ts"));
  rows.clear();
  rows.set(MARKETING_CONFIG_GENERATION_KEY, JSON.stringify({ generation: 3 }));

  assert.deepEqual(await spec.run(tx, { body: body("experiments", true, 3) }), {
    switch: "experiments",
    enabled: true,
    configGeneration: 4,
  });
  assert.equal(rows.get(MARKETING_EXPERIMENTS_KEY), "true");

  assert.deepEqual(await spec.run(tx, { body: body("experiments", false, 4) }), {
    switch: "experiments",
    enabled: false,
    configGeneration: 5,
  });
  assert.equal(rows.get(MARKETING_EXPERIMENTS_KEY), "false");
  assert.equal(rows.get(MARKETING_CONFIG_GENERATION_KEY), JSON.stringify({ generation: 5 }));
});
