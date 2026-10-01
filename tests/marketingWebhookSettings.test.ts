// The staging webhook settings and the fault latch (S2 plan, S2e).
//
// A fake transaction that keeps AppSetting rows in a map and applies the same
// conditional writes Prisma would: `updateMany` matches on the exact stored
// value, `create` fails on an existing key. The concurrency the plan asks for --
// two deliveries racing for one arm -- is exercised against PostgreSQL in the
// integration suite; here the conditional write's zero-row answer is.

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  MARKETING_WEBHOOK_FAULT_ARM_KEY,
  parseMarketingWebhookFaultArm,
  serializeMarketingWebhookFaultArm,
} from "@/lib/marketingWebhookCore";
import { MARKETING_WEBHOOK_SHADOW_KEY } from "@/lib/marketingAutomationAccess";
import {
  MarketingWebhookSettingRefusedError,
  consumeMarketingWebhookFaultArm,
  setMarketingWebhookFaultArm,
  writeMarketingWebhookShadowSwitch,
} from "@/lib/marketingWebhookSettings";
import type { MarketingTransaction } from "@/lib/marketingStore";

const NOW = new Date("2026-10-02T09:00:00.000Z");
const DIGEST = "a".repeat(64);

const staging = () => {
  process.env.TOMVERSE_DEPLOY_ENV = "staging";
  process.env.APP_ENV = "staging";
};

beforeEach(() => {
  staging();
});

const fakeTx = (
  rows: Record<string, string> = {},
  options: { stealBeforeUpdate?: string; now?: Date } = {},
) => {
  const settings = new Map(Object.entries(rows));
  const audits: Record<string, unknown>[] = [];
  const tx = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { value: settings.get(where.key) } : null,
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (settings.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        settings.set(data.key, data.value);
        return data;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; value: string };
        data: { value: string };
      }) => {
        // A concurrent writer that got there first, when a test says so.
        if (options.stealBeforeUpdate !== undefined) {
          settings.set(where.key, options.stealBeforeUpdate);
        }
        if (settings.get(where.key) !== where.value) return { count: 0 };
        settings.set(where.key, data.value);
        return { count: 1 };
      },
    },
    $queryRaw: async () => [{ now: options.now ?? NOW }],
    $executeRaw: async () => 0,
    adminAuditLog: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: "audit-1" };
      },
    },
  };
  return { tx: tx as unknown as MarketingTransaction, settings, audits };
};

const refused = (code: string) => (error: unknown) =>
  error instanceof MarketingWebhookSettingRefusedError && error.code === code;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

test("outside staging every writer refuses before reading anything", async () => {
  for (const env of [
    { TOMVERSE_DEPLOY_ENV: "production", APP_ENV: "production" },
    { TOMVERSE_DEPLOY_ENV: "staging", APP_ENV: "production" },
    { TOMVERSE_DEPLOY_ENV: "", APP_ENV: "" },
  ]) {
    process.env.TOMVERSE_DEPLOY_ENV = env.TOMVERSE_DEPLOY_ENV;
    process.env.APP_ENV = env.APP_ENV;
    const { tx, settings } = fakeTx({
      [MARKETING_WEBHOOK_FAULT_ARM_KEY]: serializeMarketingWebhookFaultArm({
        eventIdDigest: DIGEST,
        state: "armed",
        generation: 1,
        armedAt: "2026-10-02T08:00:00.000Z",
        expiresAt: "2026-10-02T10:00:00.000Z",
      }),
    });
    const before = new Map(settings);
    await assert.rejects(
      writeMarketingWebhookShadowSwitch(tx, { enabled: true, expectedEnabled: false }),
      refused("environment_not_staging"),
    );
    await assert.rejects(
      setMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST, expectedGeneration: 1, ttlMs: 60_000 }),
      refused("environment_not_staging"),
    );
    // The deliberate-failure branch's precondition: production never consumes.
    await assert.rejects(
      consumeMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST }),
      refused("environment_not_staging"),
    );
    assert.deepEqual(settings, before, JSON.stringify(env));
  }
});

// ---------------------------------------------------------------------------
// Shadow switch
// ---------------------------------------------------------------------------

test("the shadow switch turns on from absent, and off again, against what was read", async () => {
  const { tx, settings } = fakeTx();
  await writeMarketingWebhookShadowSwitch(tx, { enabled: true, expectedEnabled: false });
  assert.equal(settings.get(MARKETING_WEBHOOK_SHADOW_KEY), "true");
  await writeMarketingWebhookShadowSwitch(tx, { enabled: false, expectedEnabled: true });
  assert.equal(settings.get(MARKETING_WEBHOOK_SHADOW_KEY), "false");
});

test("a shadow change against a stale read, a no-op or a non-boolean row is refused", async () => {
  await assert.rejects(
    writeMarketingWebhookShadowSwitch(fakeTx({ [MARKETING_WEBHOOK_SHADOW_KEY]: "true" }).tx, {
      enabled: false,
      expectedEnabled: false,
    }),
    refused("shadow_switch_conflict"),
  );
  await assert.rejects(
    writeMarketingWebhookShadowSwitch(fakeTx({ [MARKETING_WEBHOOK_SHADOW_KEY]: "true" }).tx, {
      enabled: true,
      expectedEnabled: true,
    }),
    refused("shadow_switch_noop"),
  );
  await assert.rejects(
    writeMarketingWebhookShadowSwitch(fakeTx({ [MARKETING_WEBHOOK_SHADOW_KEY]: "yes" }).tx, {
      enabled: true,
      expectedEnabled: false,
    }),
    refused("shadow_switch_unreadable"),
  );
  await assert.rejects(
    writeMarketingWebhookShadowSwitch(
      fakeTx({ [MARKETING_WEBHOOK_SHADOW_KEY]: "false" }, { stealBeforeUpdate: "true" }).tx,
      { enabled: true, expectedEnabled: false },
    ),
    refused("shadow_switch_conflict"),
  );
});

// ---------------------------------------------------------------------------
// Fault arm
// ---------------------------------------------------------------------------

test("an arm moves the generation by one and takes its times from the database clock", async () => {
  const { tx, settings } = fakeTx();
  const arm = await setMarketingWebhookFaultArm(tx, {
    eventIdDigest: DIGEST,
    expectedGeneration: 0,
    ttlMs: 30 * 60 * 1000,
  });
  assert.deepEqual(arm, {
    eventIdDigest: DIGEST,
    state: "armed",
    generation: 1,
    armedAt: "2026-10-02T09:00:00.000Z",
    expiresAt: "2026-10-02T09:30:00.000Z",
  });
  assert.deepEqual(parseMarketingWebhookFaultArm(settings.get(MARKETING_WEBHOOK_FAULT_ARM_KEY)), arm);

  const again = await setMarketingWebhookFaultArm(tx, {
    eventIdDigest: "b".repeat(64),
    expectedGeneration: 1,
    ttlMs: 60_000,
  });
  assert.equal(again.generation, 2);
});

test("an arm against a stale generation, a bad digest, a bad lifetime or a foreign row is refused", async () => {
  const stored = serializeMarketingWebhookFaultArm({
    eventIdDigest: DIGEST,
    state: "consumed",
    generation: 3,
    armedAt: "2026-10-02T08:00:00.000Z",
    expiresAt: "2026-10-02T08:30:00.000Z",
  });
  const cases: Array<[Record<string, string>, Parameters<typeof setMarketingWebhookFaultArm>[1], string]> = [
    [{ [MARKETING_WEBHOOK_FAULT_ARM_KEY]: stored }, { eventIdDigest: DIGEST, expectedGeneration: 2, ttlMs: 60_000 }, "fault_arm_conflict"],
    [{}, { eventIdDigest: "A".repeat(64), expectedGeneration: 0, ttlMs: 60_000 }, "fault_arm_digest_invalid"],
    [{}, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 0 }, "fault_arm_ttl_invalid"],
    [{}, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 25 * 60 * 60 * 1000 }, "fault_arm_ttl_invalid"],
    [{ [MARKETING_WEBHOOK_FAULT_ARM_KEY]: "{}" }, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }, "fault_arm_unreadable"],
  ];
  for (const [rows, input, code] of cases) {
    await assert.rejects(setMarketingWebhookFaultArm(fakeTx(rows).tx, input), refused(code), code);
  }
});

const armed = (overrides: Record<string, unknown> = {}) =>
  serializeMarketingWebhookFaultArm({
    eventIdDigest: DIGEST,
    state: "armed",
    generation: 4,
    armedAt: "2026-10-02T08:50:00.000Z",
    expiresAt: "2026-10-02T09:20:00.000Z",
    ...overrides,
  } as never);

test("a matching event consumes the arm once and records it as the receiver", async () => {
  const { tx, settings, audits } = fakeTx({ [MARKETING_WEBHOOK_FAULT_ARM_KEY]: armed() });
  assert.deepEqual(await consumeMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST }), {
    consumed: true,
  });
  assert.equal(parseMarketingWebhookFaultArm(settings.get(MARKETING_WEBHOOK_FAULT_ARM_KEY))?.state, "consumed");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.action, "marketing_webhook.fault_arm_consumed");
  assert.deepEqual(
    (audits[0]?.metadata as Record<string, unknown>).systemActor,
    "marketing-webhook",
  );
  // The retry: already consumed, so it goes on and nothing more is written.
  assert.deepEqual(await consumeMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST }), {
    consumed: false,
  });
  assert.equal(audits.length, 1);
});

test("another event, an expired arm, no arm, or a lost race consumes nothing", async () => {
  const cases: Array<[string, Record<string, string>, { stealBeforeUpdate?: string; now?: Date }, string]> = [
    ["another event", { [MARKETING_WEBHOOK_FAULT_ARM_KEY]: armed() }, {}, "b".repeat(64)],
    ["expired", { [MARKETING_WEBHOOK_FAULT_ARM_KEY]: armed() }, { now: new Date("2026-10-02T09:20:00.000Z") }, DIGEST],
    ["no arm", {}, {}, DIGEST],
    [
      "lost the race",
      { [MARKETING_WEBHOOK_FAULT_ARM_KEY]: armed() },
      { stealBeforeUpdate: armed({ state: "consumed" }) },
      DIGEST,
    ],
  ];
  for (const [label, rows, options, digest] of cases) {
    const { tx, audits } = fakeTx(rows, options);
    assert.deepEqual(
      await consumeMarketingWebhookFaultArm(tx, { eventIdDigest: digest }),
      { consumed: false },
      label,
    );
    assert.equal(audits.length, 0, label);
  }
});

test("two writers that both read 'absent' get one write and one conflict", async () => {
  // The second create hits the unique key. That is the same fact as a changed
  // value -- somebody else wrote first -- and it is answered as one, not as an
  // unhandled database error.
  const racing = fakeTx();
  const original = (racing.tx as unknown as { appSetting: { create: (a: unknown) => Promise<unknown> } }).appSetting.create;
  (racing.tx as unknown as { appSetting: { create: (a: unknown) => Promise<unknown> } }).appSetting.create =
    async (args: unknown) => {
      // Somebody else created it between this writer's read and its create.
      await original({ data: { key: (args as { data: { key: string } }).data.key, value: "true" } });
      return original(args);
    };
  await assert.rejects(
    writeMarketingWebhookShadowSwitch(racing.tx, { enabled: true, expectedEnabled: false }),
    refused("shadow_switch_conflict"),
  );
  const arming = fakeTx();
  (arming.tx as unknown as { appSetting: { create: (a: unknown) => Promise<unknown> } }).appSetting.create =
    async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    };
  await assert.rejects(
    setMarketingWebhookFaultArm(arming.tx, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
    refused("fault_arm_conflict"),
  );
});
