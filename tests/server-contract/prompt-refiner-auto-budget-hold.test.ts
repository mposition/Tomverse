import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const windows = new Map<string, bigint>();
const holds = new Map<string, Record<string, unknown>>();
const events: string[] = [];
const dbNow = new Date("2026-10-08T13:59:59.999Z");
let auditSequence = 0;
let forceExhausted = false;

const refreshWindows = (hold: Record<string, unknown>) => {
  const active = new Set(["reserved", "dispatching", "unknown"]);
  for (const [period, startKey] of [["brisbane_day", "dayStart"],
    ["brisbane_month", "monthStart"]] as const) {
    const start = hold[startKey] as Date;
    let total = BigInt(0);
    for (const candidate of holds.values()) {
      if ((candidate[startKey] as Date).getTime() !== start.getTime()) continue;
      total += active.has(candidate.status as string)
        ? candidate.reservedMicroUsd as bigint
        : candidate.status === "settled" ? candidate.settledMicroUsd as bigint : BigInt(0);
    }
    windows.set(`${period}:${start.toISOString()}`, total);
  }
};

const tx = {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join("?");
    if (sql.includes("set_config(")) return [{ statement_limit: "4000" }];
    if (sql.includes("transaction_timestamp()")) return [{ dbNow }];
    if (sql.includes("FROM \"PromptRefinerAutoBudgetHold\"")) {
      const [holdId, requestKey, candidateDigest, pricePinDigest, deploymentId] = values;
      const hold = holds.get(holdId as string);
      return hold && hold.requestKey === requestKey &&
        hold.candidateDigest === candidateDigest && hold.pricePinDigest === pricePinDigest &&
        hold.runtimeDeploymentId === deploymentId ? [{ ...hold }] : [];
    }
    throw new Error(`unexpected_query:${sql}`);
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO \"PromptRefinerAutoBudgetHold\"")) {
      if (forceExhausted) throw new Error("prompt_refiner_auto_budget_exhausted");
      const [id, requestKey, dayStart, monthStart, reservedMicroUsd,
        candidateDigest, pricePinDigest, runtimeDeploymentId, reservationAuditLogId] = values;
      if ([...holds.values()].some((hold) => hold.requestKey === requestKey)) {
        throw Object.assign(new Error("Raw query failed."), {
          code: "P2010",
          meta: { driverAdapterError: { cause: {
            originalCode: "23505",
            originalMessage: "duplicate key value violates unique constraint " +
              '"PromptRefinerAutoBudgetHold_requestKey_key"',
            kind: "UniqueConstraintViolation",
            constraint: { index: "PromptRefinerAutoBudgetHold_requestKey_key" },
            table: "PromptRefinerAutoBudgetHold",
          } } },
        });
      }
      const hold = { id, requestKey, dayStart, monthStart, reservedMicroUsd,
        settledMicroUsd: null, status: "reserved", candidateDigest, pricePinDigest,
        runtimeDeploymentId, reservationAuditLogId, dispatchIntentId: null,
        adapterConfigDigest: null, dispatchAuditLogId: null, unknownObservationId: null,
        unknownAuditLogId: null, dispatchedAt: null, unknownAt: null,
        settlementObservationId: null,
        releaseProofId: null, settlementAuditLogId: null };
      holds.set(id as string, hold); refreshWindows(hold);
      events.push("hold:reserved"); return 1;
    }
    if (!sql.includes("UPDATE \"PromptRefinerAutoBudgetHold\"")) {
      throw new Error(`unexpected_execute:${sql}`);
    }
    if (sql.includes("SET \"status\" = 'settled'")) {
      const [amount, observationId, auditId, holdId] = values;
      const hold = holds.get(holdId as string);
      if (!hold || hold.status !== "dispatching") return 0;
      Object.assign(hold, { status: "settled", settledMicroUsd: amount,
        settlementObservationId: observationId, settlementAuditLogId: auditId });
      refreshWindows(hold); events.push("hold:settled"); return 1;
    }
    if (sql.includes("SET \"status\" = 'unknown'")) {
      const [observationId, auditId, holdId] = values;
      const hold = holds.get(holdId as string);
      if (!hold || hold.status !== "dispatching") return 0;
      Object.assign(hold, { status: "unknown", unknownObservationId: observationId,
        unknownAuditLogId: auditId, unknownAt: dbNow });
      refreshWindows(hold); events.push("hold:unknown"); return 1;
    }
    if (sql.includes("SET \"status\" = 'dispatching'")) {
      const [intentId, adapterConfigDigest, auditId, holdId] = values;
      const hold = holds.get(holdId as string);
      if (!hold || hold.status !== "reserved") return 0;
      Object.assign(hold, { status: "dispatching", dispatchIntentId: intentId,
        adapterConfigDigest, dispatchAuditLogId: auditId, dispatchedAt: dbNow });
      events.push("hold:dispatching"); return 1;
    }
    const [proofId, auditId, holdId, expectedStatus] = values;
    const hold = holds.get(holdId as string);
    if (!hold || hold.status !== expectedStatus) return 0;
    Object.assign(hold, { status: "released", settledMicroUsd: BigInt(0),
      releaseProofId: proofId, settlementAuditLogId: auditId });
    refreshWindows(hold); events.push("hold:released"); return 1;
  },
};

const fakePrisma = {
  async $transaction<T>(work: (client: typeof tx) => Promise<T>): Promise<T> {
    const beforeWindows = structuredClone(windows);
    const beforeHolds = structuredClone(holds);
    const beforeEvents = [...events];
    const beforeAudit = auditSequence;
    try { return await work(tx); }
    catch (error) {
      windows.clear(); for (const [key, value] of beforeWindows) windows.set(key, value);
      holds.clear(); for (const [key, value] of beforeHolds) holds.set(key, value);
      events.splice(0, events.length, ...beforeEvents); auditSequence = beforeAudit;
      throw error;
    }
  },
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: fakePrisma } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async (input: unknown) => { assert.equal(input, tx); events.push("audit_lock"); },
  writeSystemAuditLog: async (input: { tx: unknown; systemActor: string; action: string }) => {
    assert.equal(input.tx, tx); assert.equal(input.systemActor, "prompt-refiner-auto-budget");
    events.push(`audit:${input.action}`); return `audit-${++auditSequence}`;
  },
} });

const load = () => import(mod("lib/promptRefinerAutoBudgetHold.ts"));
const key = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const configDigest = "c".repeat(64);
const base = (requestKey: string) => ({ requestKey,
  candidateDigest: "a".repeat(64), pricePinDigest: "b".repeat(64),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111" });
const binding = (holdId: string, requestKey: string) => ({ holdId, ...base(requestKey) });
const trustedCapability = Object.freeze({ name: "synthetic-server-adapter" });
type Raw<T> = { capability: object; fact: T };
const verify = <T>(raw: Raw<T>) => {
  if (raw.capability !== trustedCapability) throw new Error("untrusted_adapter_observation");
  return raw.fact;
};
const raw = <T>(fact: T): Raw<T> => ({ capability: trustedCapability, fact });
const clear = () => { windows.clear(); holds.clear(); events.length = 0;
  auditSequence = 0; forceExhausted = false; };

test("Brisbane day and month boundaries use the DB instant", async () => {
  const budget = await load();
  const before = budget.promptRefinerAutoBudgetWindows(new Date("2026-10-31T13:59:59.999Z"));
  const after = budget.promptRefinerAutoBudgetWindows(new Date("2026-10-31T14:00:00.000Z"));
  assert.equal(before.dayStart.toISOString(), "2026-10-30T14:00:00.000Z");
  assert.equal(before.monthStart.toISOString(), "2026-09-30T14:00:00.000Z");
  assert.equal(after.dayStart.toISOString(), "2026-10-31T14:00:00.000Z");
  assert.equal(after.monthStart.toISOString(), "2026-10-31T14:00:00.000Z");
});

test("reservation is audited, exact-window booked, and never dispatch authority", async () => {
  const budget = await load(); clear();
  const result = await budget.reservePromptRefinerAutoBudget(base(key(1)));
  assert.equal(result.reservedMicroUsd, BigInt(29_918));
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual([...windows.values()], [BigInt(29_918), BigInt(29_918)]);
  assert.deepEqual(events, ["audit_lock", "audit:prompt_refiner.auto_budget_reserved",
    "hold:reserved"]);
  const beforeDuplicate = { events: [...events], auditSequence,
    holds: structuredClone(holds), windows: structuredClone(windows) };
  await assert.rejects(budget.reservePromptRefinerAutoBudget(base(key(1))),
    (error: unknown) => error instanceof Error &&
      error.name === "PromptRefinerAutoBudgetError" && "code" in error &&
      error.code === "duplicate_request");
  assert.deepEqual(events, beforeDuplicate.events);
  assert.equal(auditSequence, beforeDuplicate.auditSequence);
  assert.deepEqual(holds, beforeDuplicate.holds);
  assert.deepEqual(windows, beforeDuplicate.windows);
});

test("trusted dispatch and verified billing settle actual cost and refund both windows", async () => {
  const budget = await load(); clear();
  const held = await budget.reservePromptRefinerAutoBudget(base(key(2)));
  const bound = binding(held.id, key(2));
  const intentId = key(102);
  const observationId = key(202);
  const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
    verifyBillingUnknown: verify, verifyUndispatched: verify,
  });
  await authority.recordDispatchIntent(raw({ binding: bound, intentId,
    adapterConfigDigest: configDigest }));
  const settled = await authority.settleVerifiedBilled(raw({
    kind: "verified_billed" as const, binding: bound, intentId,
    adapterConfigDigest: configDigest, observationId, billedMicroUsd: BigInt(12_345),
  }));
  assert.equal(settled.status, "settled");
  assert.deepEqual([...windows.values()], [BigInt(12_345), BigInt(12_345)]);
  assert.equal(holds.get(held.id)?.status, "settled");
  await assert.rejects(authority.settleVerifiedBilled(raw({
    kind: "verified_billed" as const, binding: bound, intentId,
    adapterConfigDigest: configDigest, observationId: key(203),
    billedMicroUsd: BigInt(1),
  })), /transition_invalid/);
  assert.deepEqual([...windows.values()], [BigInt(12_345), BigInt(12_345)]);
});

test("unknown is terminal, retains the full hold, and never authorizes retry", async () => {
  const budget = await load(); clear();
  const held = await budget.reservePromptRefinerAutoBudget(base(key(3)));
  const bound = binding(held.id, key(3));
  const intentId = key(103);
  const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
    verifyBillingUnknown: verify, verifyUndispatched: verify,
  });
  await authority.recordDispatchIntent(raw({ binding: bound, intentId,
    adapterConfigDigest: configDigest }));
  const result = await authority.retainUnknown(raw({ kind: "billing_unknown" as const,
    binding: bound, intentId, adapterConfigDigest: configDigest,
    observationId: key(303) }));
  assert.equal(result.retryAuthorized, false);
  assert.deepEqual([...windows.values()], [BigInt(29_918), BigInt(29_918)]);
  await assert.rejects(authority.settleVerifiedBilled(raw({
    kind: "verified_billed" as const, binding: bound, intentId,
    adapterConfigDigest: configDigest, observationId: key(304),
    billedMicroUsd: BigInt(1) })), /transition_invalid/);
  await assert.rejects(authority.releaseConfirmedUndispatched(raw({
    kind: "confirmed_undispatched" as const, binding: bound, proofId: key(305),
    intentId, adapterConfigDigest: configDigest })), /transition_invalid/);
  assert.equal(holds.get(held.id)?.status, "unknown");
});

test("only a returned durable dispatch result can retain an unexpected unknown", async () => {
  const budget = await load(); clear();
  const held = await budget.reservePromptRefinerAutoBudget(base(key(30)));
  const bound = binding(held.id, key(30));
  const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
    verifyBillingUnknown: verify, verifyUndispatched: verify,
  });
  const recorded = await authority.recordDispatchIntent(raw({ binding: bound,
    intentId: key(130), adapterConfigDigest: configDigest }));
  assert.equal(Object.hasOwn(recorded, "dispatchedAt"), false);
  await assert.rejects(authority.retainUnknownAfterRecordedDispatch({
    ...recorded,
  }), /evidence_invalid/);
  const retained = await authority.retainUnknownAfterRecordedDispatch(recorded);
  assert.equal(retained.status, "unknown");
  assert.equal(retained.retryAuthorized, false);
  assert.equal(retained.dispatchedAt.toISOString(), dbNow.toISOString());
  assert.equal(retained.unknownAt.toISOString(), dbNow.toISOString());
  assert.deepEqual([...windows.values()], [BigInt(29_918), BigInt(29_918)]);
  await assert.rejects(authority.retainUnknownAfterRecordedDispatch(recorded),
    /transition_invalid/);
});

test("confirmed undispatched proof releases before or after an intent, once", async () => {
  const budget = await load(); clear();
  const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
    verifyBillingUnknown: verify, verifyUndispatched: verify,
  });
  const first = await budget.reservePromptRefinerAutoBudget(base(key(4)));
  const firstBinding = binding(first.id, key(4));
  await authority.releaseConfirmedUndispatched(raw({
    kind: "confirmed_undispatched" as const, binding: firstBinding,
    proofId: key(404), intentId: null, adapterConfigDigest: null }));
  assert.deepEqual([...windows.values()], [BigInt(0), BigInt(0)]);

  const second = await budget.reservePromptRefinerAutoBudget(base(key(5)));
  const secondBinding = binding(second.id, key(5));
  await authority.recordDispatchIntent(raw({ binding: secondBinding,
    intentId: key(105), adapterConfigDigest: configDigest }));
  await authority.releaseConfirmedUndispatched(raw({
    kind: "confirmed_undispatched" as const, binding: secondBinding,
    proofId: key(405), intentId: key(105), adapterConfigDigest: configDigest }));
  assert.deepEqual([...windows.values()], [BigInt(0), BigInt(0)]);
  await assert.rejects(authority.releaseConfirmedUndispatched(raw({
    kind: "confirmed_undispatched" as const, binding: secondBinding,
    proofId: key(406), intentId: key(105), adapterConfigDigest: configDigest })),
  /transition_invalid/);
});

test("untrusted client-shaped evidence and mismatched binding fail before mutation", async () => {
  const budget = await load(); clear();
  const held = await budget.reservePromptRefinerAutoBudget(base(key(6)));
  const bound = binding(held.id, key(6));
  const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
    verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
    verifyBillingUnknown: verify, verifyUndispatched: verify,
  });
  await assert.rejects(authority.recordDispatchIntent({ capability: {}, fact: {
    binding: bound, intentId: key(106), adapterConfigDigest: configDigest,
  } }), /untrusted_adapter_observation/);
  await assert.rejects(authority.recordDispatchIntent(raw({
    binding: { ...bound, pricePinDigest: "d".repeat(64) },
    intentId: key(106), adapterConfigDigest: configDigest,
  })), /binding_invalid/);
  assert.equal(holds.get(held.id)?.status, "reserved");
});

test("budget exhaustion rolls the reservation audit back", async () => {
  const budget = await load(); clear(); forceExhausted = true;
  await assert.rejects(budget.reservePromptRefinerAutoBudget(base(key(7))),
    (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "budget_exhausted");
  assert.equal(holds.size, 0); assert.equal(windows.size, 0);
  assert.deepEqual(events, []); assert.equal(auditSequence, 0);
});
