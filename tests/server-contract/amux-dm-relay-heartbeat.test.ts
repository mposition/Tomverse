import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, mock, test } from "node:test";

// The Decision Maker relay's heartbeat (docs/ops/amux/bridge-monitoring.md §6):
// the pure rule, and the writer's bounds. Prisma is faked; the writer must
// never hold up the sync route it runs in, nor throw into it.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type TransactionOptions = { maxWait?: number; timeout?: number };
const world = {
  transactionOptions: [] as TransactionOptions[],
  statements: [] as string[],
  upserts: [] as unknown[],
  transactionError: null as Error | null,
  questionWhere: null as unknown,
};

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $transaction: async (
        work: (tx: unknown) => Promise<unknown>,
        options: TransactionOptions
      ) => {
        world.transactionOptions.push(options);
        if (world.transactionError) throw world.transactionError;
        return work({
          $executeRaw: async (strings: TemplateStringsArray) => {
            world.statements.push(strings.join("?"));
            return 0;
          },
          appSetting: {
            upsert: async (args: unknown) => {
              world.upserts.push(args);
              return {};
            },
          },
        });
      },
      appSetting: { findUnique: async () => ({ value: "2026-11-14T00:00:00.000Z" }) },
      amuxDecisionMakerRequest: {
        findFirst: async (args: { where: unknown }) => {
          world.questionWhere = args.where;
          return null;
        },
      },
    },
  },
});

let heartbeat: typeof import("../../lib/amux/dmRelayHeartbeat");
let core: typeof import("../../lib/amux/dmRelayHeartbeatCore");
before(async () => {
  heartbeat = await import(mod("lib/amux/dmRelayHeartbeat.ts"));
  core = await import(mod("lib/amux/dmRelayHeartbeatCore.ts"));
});

const reset = () => {
  world.transactionOptions = [];
  world.statements = [];
  world.upserts = [];
  world.transactionError = null;
  world.questionWhere = null;
};

test("the heartbeat writes one row, bounded in connection wait, time and locks", async () => {
  reset();
  const now = new Date("2026-11-14T03:00:00.000Z");
  await heartbeat.recordAmuxDmRelaySync(now);
  assert.deepEqual(world.transactionOptions, [{ maxWait: 500, timeout: 1_500 }]);
  assert.match(world.statements[0] ?? "", /set_config\('statement_timeout', \?, true\), set_config\('lock_timeout', \?, true\)/);
  assert.deepEqual(world.upserts, [{
    where: { key: "amuxDmRelayLastSyncAt" },
    create: { key: "amuxDmRelayLastSyncAt", value: now.toISOString() },
    update: { value: now.toISOString() },
  }]);
});

test("a heartbeat that cannot be written is swallowed with a log line that carries no error text", async () => {
  reset();
  world.transactionError = new Error("Transaction API error: timeout secret-host");
  const warn = mock.method(console, "warn", () => undefined);
  await heartbeat.recordAmuxDmRelaySync();
  assert.equal(warn.mock.callCount(), 1);
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /secret-host/);
  warn.mock.restore();
});

test("the question read looks back only the question window", async () => {
  reset();
  const now = new Date("2026-11-14T03:00:00.000Z");
  await heartbeat.readAmuxDmRelayLastQuestionAt(now);
  assert.deepEqual(world.questionWhere, { createdAt: { gt: new Date("2026-11-14T02:20:00.000Z") } });
});

test("calling, asking and silent", () => {
  const now = new Date("2026-11-14T03:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  assert.equal(core.judgeAmuxDmRelayLiveness(ago(5), null, now).state, "calling");
  assert.equal(core.judgeAmuxDmRelayLiveness(new Date(now.getTime() + 60_000), null, now).state, "calling");
  assert.deepEqual(core.judgeAmuxDmRelayLiveness(ago(6), null, now), {
    state: "silent", lastSyncAt: ago(6), minutesSilent: 6,
  });
  assert.equal(core.judgeAmuxDmRelayLiveness(ago(30), ago(40), now).state, "asking");
  assert.equal(core.judgeAmuxDmRelayLiveness(ago(45), ago(41), now).state, "silent");
  assert.equal(core.judgeAmuxDmRelayLiveness(null, ago(10), now).state, "asking");
  assert.deepEqual(core.judgeAmuxDmRelayLiveness(null, null, now), {
    state: "silent", lastSyncAt: null, minutesSilent: null,
  });
  assert.equal(core.parseAmuxDmRelayLastSync("not a time"), null);
  assert.equal(core.amuxDmRelayExpected({ TOMVERSE_AMUX_DM_ROUTING: "enabled" } as NodeJS.ProcessEnv), true);
  assert.equal(core.amuxDmRelayExpected({ TOMVERSE_AMUX_DM_ROUTING: "true" } as NodeJS.ProcessEnv), false);
});

test("the question window covers the relay's longest wait on one question", () => {
  const io = readFileSync(resolve(ROOT, "apps/tomverse-orchestrator/src/dm_relay/io.rs"), "utf8");
  const broker = Number(io.match(/DM_BROKER_RESPONSE_DEADLINE: Duration = Duration::from_millis\((\d+) \* 60 \* 1000\)/)?.[1]);
  const idle = Number(io.match(/DM_RELAY_IDLE: Duration = Duration::from_secs\((\d+)\)/)?.[1]);
  // The assignment deadline is the request's creation plus two minutes
  // (migration 20261008090100_amux_decision_maker_request_ledger).
  assert.ok(broker > 0 && (broker + 2) * 60_000 < core.AMUX_DM_RELAY_QUESTION_MS, `broker ${broker} min`);
  assert.ok(idle > 0 && idle * 1_000 * 10 <= core.AMUX_DM_RELAY_SILENT_MS, `idle ${idle} s`);
  const routing = readFileSync(resolve(ROOT, "lib/amux/decisionMakerInternalRoute.ts"), "utf8");
  assert.match(routing, /AMUX_DM_ROUTING_ENV = "TOMVERSE_AMUX_DM_ROUTING"/, "the switch read by name is the routes' switch");
});
