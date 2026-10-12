import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  acquireChatAccess,
  ChatAccessError,
  guestCreditPeriodStart,
  holdChatUsageBucket,
  resolveGuestCreditQuotaLimits,
  type ChatAccess,
  type ChatBudget,
  type ChatUsageReservation,
  type GuestAutoHeldCreditEntry,
} from "@/lib/chatSecurity";
import type { GuestChatAutoAuthorityPayload } from "@/lib/guestChatAutoAuthority";
import {
  classifyGuestAutoCreditClaim,
  guestAutoCreditRequestKeyCore,
} from "@/lib/guestChatAutoCreditClaim";
import {
  planGuestAutoCreditConversion,
  planGuestAutoCreditPrehold,
  GuestAutoQuotaError,
  type GuestAutoCreditCandidate,
  type GuestAutoCreditPrehold,
} from "@/lib/guestChatAutoQuotaCore";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";

const REQUEST_KEY = /^guest-auto-credit:v1:[a-f0-9]{64}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const preholdPayloadSchema = z.object({
  version: z.literal(1),
  phase: z.literal("guest_auto_prehold"),
  reservationId: z.uuid(),
  traceId: z.string().min(1).max(120),
  clientTurnId: z.uuid(),
  requestKey: z.string().regex(REQUEST_KEY),
  authorityId: z.uuid(),
  candidateDigest: z.string().regex(HEX_64),
  reachableCandidateDigest: z.string().regex(HEX_64),
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  runtimeDeploymentId: z.uuid(),
  activationPairDigest: z.string().regex(HEX_64),
  configDigest: z.string().regex(HEX_64),
  basisModelId: z.string().min(1).max(160),
  basisProvider: z.string().min(1).max(80),
  heldCredits: z.number().int().positive(),
  preholdAuditLogId: z.string().min(1).max(100),
  minuteEntries: z.array(z.object({
    key: z.string().min(1).max(240),
    period: z.literal("minute"),
    periodStart: z.iso.datetime(),
    amount: z.literal(1),
  }).strict()).length(2),
  creditEntries: z.array(z.object({
    key: z.string().min(1).max(240),
    period: z.enum(["day", "month", "guest-ip-day", "guest-ip-month"]),
    periodStart: z.iso.datetime(),
    amount: z.number().int().positive(),
  }).strict()).length(4),
}).strict();

const exactGuestAutoPayloadSchema = z.object({
  guestAuto: z.object({
    authorityId: z.uuid(),
    requestKey: z.string().regex(REQUEST_KEY),
    clientTurnId: z.uuid(),
    candidateDigest: z.string().regex(HEX_64),
    reachableCandidateDigest: z.string().regex(HEX_64),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    runtimeDeploymentId: z.uuid(),
    activationPairDigest: z.string().regex(HEX_64),
    configDigest: z.string().regex(HEX_64),
    basisModelId: z.string().min(1).max(160),
    basisProvider: z.string().min(1).max(80),
    finalModelId: z.string().min(1).max(160),
    finalProvider: z.string().min(1).max(80),
    heldCredits: z.number().int().positive(),
    exactCredits: z.number().int().positive(),
    preholdAuditLogId: z.string().min(1).max(100),
    conversionAuditLogId: z.string().min(1).max(100),
  }).strict(),
}).passthrough();

type PreholdPayload = z.infer<typeof preholdPayloadSchema>;

export class GuestAutoCreditLedgerError extends Error {
  constructor(readonly code:
    | "invalid_binding"
    | "duplicate_binding"
    | "quota_exhausted"
    | "transition_invalid"
    | "integrity_unavailable") {
    super(code);
    this.name = "GuestAutoCreditLedgerError";
  }
}

/** Preserve the closed known-refusal boundary across module callers. */
export const isGuestAutoCreditLedgerError = (
  error: unknown,
): error is GuestAutoCreditLedgerError =>
  error instanceof GuestAutoCreditLedgerError;

export type GuestAutoCreditBinding = Readonly<{
  authority: GuestChatAutoAuthorityPayload;
  candidateDigest: string;
  clientTurnId: string;
}>;

export type GuestAutoCreditLedgerState = Readonly<{
  reservationId: string;
  requestKey: string;
  clientTurnId: string;
  phase: "guest_auto_prehold" | "exact";
  status: string;
  basisModelId: string;
  basisProvider: string;
  heldCredits: number;
}>;

const requestKeyFor = (subjectKey: string, authorityId: string) =>
  guestAutoCreditRequestKeyCore(subjectKey, authorityId);

const reachableCandidateDigest = (prehold: GuestAutoCreditPrehold) =>
  createHash("sha256").update(JSON.stringify({
    version: "guest-auto-reachable-candidates-v1",
    candidates: prehold.reachableCandidates.map((candidate) => ({
      modelId: candidate.modelId,
      provider: candidate.provider,
      usageCredits: candidate.usageCredits,
    })),
  }), "utf8").digest("hex");

export const guestAutoCreditRequestKey = (
  subjectKey: string,
  authorityId: string,
) => {
  if (!/^guest:[a-f0-9]{64}$/.test(subjectKey) || !UUID.test(authorityId)) {
    throw new GuestAutoCreditLedgerError("invalid_binding");
  }
  return requestKeyFor(subjectKey, authorityId);
};

const assertBinding = (
  access: ChatAccess,
  binding: GuestAutoCreditBinding,
  activeAt?: Date,
) => {
  const authority = binding.authority;
  if (
    access.kind !== "guest" || access.userId ||
    authority.version !== 1 ||
    authority.purpose !== "guest_chat_smart_adaptive" ||
    authority.subjectKey !== access.subjectKey ||
    authority.product !== "chat" ||
    authority.policyVersion !== 1 ||
    !UUID.test(authority.authorityId) ||
    !UUID.test(authority.nonce) ||
    !/^[a-f0-9]{40}$/.test(authority.sourceCommitSha) ||
    !UUID.test(authority.runtimeDeploymentId) ||
    !HEX_64.test(authority.activationPairDigest) ||
    !HEX_64.test(authority.configDigest) ||
    !Number.isSafeInteger(authority.issuedAtMs) ||
    !Number.isSafeInteger(authority.expiresAtMs) ||
    authority.issuedAtMs < 0 ||
    authority.expiresAtMs <= authority.issuedAtMs ||
    !HEX_64.test(binding.candidateDigest) ||
    !UUID.test(binding.clientTurnId) ||
    (activeAt !== undefined &&
      (authority.issuedAtMs > activeAt.getTime() ||
        authority.expiresAtMs <= activeAt.getTime()))
  ) {
    throw new GuestAutoCreditLedgerError("invalid_binding");
  }
};

const decrementEntry = async (
  tx: Prisma.TransactionClient,
  entry: { key: string; period: string; periodStart: Date; amount: number },
) => {
  const changed = await tx.$executeRaw`
    UPDATE "ChatUsageBucket"
    SET "count" = "count" - ${entry.amount}, "updatedAt" = NOW()
    WHERE "key" = ${entry.key} AND "period" = ${entry.period}
      AND "periodStart" = ${entry.periodStart} AND "count" >= ${entry.amount}
  `;
  if (changed !== 1) throw new GuestAutoCreditLedgerError("integrity_unavailable");
};

const parsePrehold = (value: Prisma.JsonValue): PreholdPayload => {
  const parsed = preholdPayloadSchema.safeParse(value);
  if (!parsed.success) throw new GuestAutoCreditLedgerError("integrity_unavailable");
  return parsed.data;
};

const datesForCreditEntries = (
  payload: PreholdPayload,
): GuestAutoHeldCreditEntry[] => payload.creditEntries.map((entry) => ({
  ...entry,
  periodStart: new Date(entry.periodStart),
}));

const stateFromRow = (row: {
  id: string;
  phase: string;
  status: string;
  provider: string;
  modelId: string;
  reservedCredits: number;
  idempotencyKey: string;
  reservationPayload: Prisma.JsonValue;
}): GuestAutoCreditLedgerState => {
  if (row.phase === "guest_auto_prehold") {
    const payload = parsePrehold(row.reservationPayload);
    return Object.freeze({
      reservationId: row.id,
      requestKey: row.idempotencyKey,
      clientTurnId: payload.clientTurnId,
      phase: "guest_auto_prehold",
      status: row.status,
      basisModelId: payload.basisModelId,
      basisProvider: payload.basisProvider,
      heldCredits: payload.heldCredits,
    });
  }
  const parsed = exactGuestAutoPayloadSchema.safeParse(row.reservationPayload);
  if (!parsed.success) throw new GuestAutoCreditLedgerError("integrity_unavailable");
  return Object.freeze({
    reservationId: row.id,
    requestKey: row.idempotencyKey,
    clientTurnId: parsed.data.guestAuto.clientTurnId,
    phase: "exact",
    status: row.status,
    basisModelId: parsed.data.guestAuto.basisModelId,
    basisProvider: parsed.data.guestAuto.basisProvider,
    heldCredits: parsed.data.guestAuto.heldCredits,
  });
};

const payloadMatchesBinding = (
  row: {
    phase: string;
    subjectKey: string;
    idempotencyKey: string;
    clientTurnId: string | null;
    reservationPayload: Prisma.JsonValue;
  },
  access: ChatAccess,
  binding: GuestAutoCreditBinding,
  requestedPrehold?: GuestAutoCreditPrehold,
) => {
  if (
    row.subjectKey !== access.subjectKey ||
    row.idempotencyKey !== requestKeyFor(
      access.subjectKey,
      binding.authority.authorityId,
    ) ||
    row.clientTurnId !== binding.clientTurnId
  ) return false;

  const common = row.phase === "guest_auto_prehold"
    ? (() => {
        const parsed = preholdPayloadSchema.safeParse(row.reservationPayload);
        return parsed.success ? parsed.data : null;
      })()
    : (() => {
        const parsed = exactGuestAutoPayloadSchema.safeParse(row.reservationPayload);
        return parsed.success ? parsed.data.guestAuto : null;
      })();
  return common !== null &&
    common.authorityId === binding.authority.authorityId &&
    common.clientTurnId === binding.clientTurnId &&
    common.candidateDigest === binding.candidateDigest &&
    common.sourceCommitSha === binding.authority.sourceCommitSha &&
    common.runtimeDeploymentId === binding.authority.runtimeDeploymentId &&
    common.activationPairDigest === binding.authority.activationPairDigest &&
    common.configDigest === binding.authority.configDigest &&
    (!requestedPrehold || (
      common.basisModelId === requestedPrehold.basisModelId &&
      common.basisProvider === requestedPrehold.basisProvider &&
      common.heldCredits === requestedPrehold.dayAmount &&
      common.reachableCandidateDigest === reachableCandidateDigest(
        requestedPrehold,
      )
    ));
};

const readUsage = async (
  tx: Prisma.TransactionClient,
  key: string,
  period: string,
  periodStart: Date,
) => {
  const row = await tx.chatUsageBucket.findUnique({
    where: { key_period_periodStart: { key, period, periodStart } },
    select: { count: true },
  });
  if (!row) return 0;
  return guestAutoUsageBucketCount(row.count);
};

/** Narrow Prisma BIGINT counters without accepting mock/runtime string coercion. */
export const guestAutoUsageBucketCount = (value: unknown): number => {
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw new GuestAutoCreditLedgerError("integrity_unavailable");
  }
  try {
    const count = usageBucketCount(value);
    if (count < 0) throw new Error("negative Guest Auto usage bucket");
    return count;
  } catch {
    throw new GuestAutoCreditLedgerError("integrity_unavailable");
  }
};

const buildPrehold = (input: Parameters<typeof planGuestAutoCreditPrehold>[0]) => {
  try {
    return planGuestAutoCreditPrehold(input);
  } catch (error) {
    if (error instanceof GuestAutoQuotaError &&
        error.code === "no_reachable_candidate") {
      throw new GuestAutoCreditLedgerError("quota_exhausted");
    }
    throw new GuestAutoCreditLedgerError("invalid_binding");
  }
};

export async function reserveGuestAutoCreditPrehold(input: Readonly<{
  access: ChatAccess;
  binding: GuestAutoCreditBinding;
  candidates: readonly GuestAutoCreditCandidate[];
  traceId?: string;
  now?: Date;
}>): Promise<Readonly<{
  state: GuestAutoCreditLedgerState;
  prehold: GuestAutoCreditPrehold;
}>> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new GuestAutoCreditLedgerError("invalid_binding");
  assertBinding(input.access, input.binding, now);
  const requestKey = guestAutoCreditRequestKey(
    input.access.subjectKey,
    input.binding.authority.authorityId,
  );
  const reservationId = randomUUID();
  const traceId = input.traceId ?? reservationId;
  if (traceId.length < 1 || traceId.length > 120) {
    throw new GuestAutoCreditLedgerError("invalid_binding");
  }

  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.access.subjectKey}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-lease:${input.access.subjectKey}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-lease:${input.access.ipKey}`}))`;
    const turnExisting = await tx.chatCreditReservation.findUnique({
      where: { subjectKey_clientTurnId: {
        subjectKey: input.access.subjectKey,
        clientTurnId: input.binding.clientTurnId,
      } },
    });
    const existing = await tx.chatCreditReservation.findUnique({
      where: { idempotencyKey: requestKey },
    });
    const claim = classifyGuestAutoCreditClaim({
      subjectKey: input.access.subjectKey,
      clientTurnId: input.binding.clientTurnId,
      requestKey,
      byAuthority: existing,
      byTurn: turnExisting,
    });
    if (claim === "conflict") {
      throw new GuestAutoCreditLedgerError("duplicate_binding");
    }
    if (claim === "replay_terminal") {
      throw new GuestAutoCreditLedgerError("transition_invalid");
    }
    if (claim === "replay_preheld" && existing) {
      if (!payloadMatchesBinding(existing, input.access, input.binding)) {
        throw new GuestAutoCreditLedgerError("duplicate_binding");
      }
      if (existing.phase !== "guest_auto_prehold") {
        throw new GuestAutoCreditLedgerError("transition_invalid");
      }
      if (existing.status !== "guest_auto_preheld") {
        throw new GuestAutoCreditLedgerError("transition_invalid");
      }
      const existingPayload = parsePrehold(existing.reservationPayload);
      const existingPrehold = buildPrehold({
        candidates: input.candidates,
        remainingDayCredits: existingPayload.heldCredits,
        remainingMonthCredits: existingPayload.heldCredits,
      });
      if (!payloadMatchesBinding(existing, input.access, input.binding, existingPrehold)) {
        throw new GuestAutoCreditLedgerError("duplicate_binding");
      }
      return Object.freeze({
        state: stateFromRow(existing),
        prehold: existingPrehold,
      });
    }
    if (claim !== "new") {
      throw new GuestAutoCreditLedgerError("integrity_unavailable");
    }

    const limits = resolveGuestCreditQuotaLimits();
    const minuteStart = guestCreditPeriodStart("minute", now);
    const dayStart = guestCreditPeriodStart("day", now);
    const monthStart = guestCreditPeriodStart("month", now);
    const ipDayLimit = limits.subjectDay * limits.ipCreditMultiplier;
    const ipMonthLimit = limits.subjectMonth * limits.ipCreditMultiplier;
    const remainingDayCredits = Math.min(
      Math.max(0, limits.subjectDay - await readUsage(
        tx, input.access.subjectKey, "day", dayStart,
      )),
      Math.max(0, ipDayLimit - await readUsage(
        tx, input.access.ipKey, "guest-ip-day", dayStart,
      )),
    );
    const remainingMonthCredits = Math.min(
      Math.max(0, limits.subjectMonth - await readUsage(
        tx, input.access.subjectKey, "month", monthStart,
      )),
      Math.max(0, ipMonthLimit - await readUsage(
        tx, input.access.ipKey, "guest-ip-month", monthStart,
      )),
    );
    const prehold = buildPrehold({
      candidates: input.candidates,
      remainingDayCredits,
      remainingMonthCredits,
    });
    const frozenReachableCandidateDigest = reachableCandidateDigest(prehold);
    const heldCredits = prehold.dayAmount;
    const minuteEntries = [
      { key: input.access.subjectKey, period: "minute" as const,
        periodStart: minuteStart, amount: 1 as const },
      { key: input.access.ipKey, period: "minute" as const,
        periodStart: minuteStart, amount: 1 as const },
    ];
    const creditEntries = [
      { key: input.access.subjectKey, period: "day" as const,
        periodStart: dayStart, amount: heldCredits },
      { key: input.access.subjectKey, period: "month" as const,
        periodStart: monthStart, amount: heldCredits },
      { key: input.access.ipKey, period: "guest-ip-day" as const,
        periodStart: dayStart, amount: heldCredits },
      { key: input.access.ipKey, period: "guest-ip-month" as const,
        periodStart: monthStart, amount: heldCredits },
    ];
    const checks = [
      [minuteEntries[0], limits.subjectMinute],
      [minuteEntries[1], limits.ipMinute],
      [creditEntries[0], limits.subjectDay],
      [creditEntries[1], limits.subjectMonth],
      [creditEntries[2], ipDayLimit],
      [creditEntries[3], ipMonthLimit],
    ] as const;
    for (const [entry, limit] of checks) {
      if (!(await holdChatUsageBucket(tx, entry.key, entry.period, entry.periodStart,
        limit, entry.amount))) {
        throw new ChatAccessError(
          429,
          entry.period === "minute" ? "CHAT_RATE_LIMITED" :
            entry.key === input.access.ipKey ? "CHAT_IP_QUOTA_EXCEEDED" :
              "CHAT_QUOTA_EXCEEDED",
          entry.key === input.access.ipKey ? "Guest usage limit exceeded." :
            "AI response credit limit exceeded.",
        );
      }
    }

    const preholdAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: "guest-chat-auto-credit",
      action: "guest_chat.auto_credit_preheld",
      targetType: "ChatCreditReservation",
      targetId: reservationId,
      summary: "Reserved one model-agnostic Guest Smart Adaptive credit hold.",
      metadata: {
        authorityId: input.binding.authority.authorityId,
        clientTurnId: input.binding.clientTurnId,
        requestKey,
        candidateDigest: input.binding.candidateDigest,
        reachableCandidateDigest: frozenReachableCandidateDigest,
        sourceCommitSha: input.binding.authority.sourceCommitSha,
        runtimeDeploymentId: input.binding.authority.runtimeDeploymentId,
        activationPairDigest: input.binding.authority.activationPairDigest,
        configDigest: input.binding.authority.configDigest,
        basisModelId: prehold.basisModelId,
        basisProvider: prehold.basisProvider,
        heldCredits,
      },
    });
    const payload: PreholdPayload = {
      version: 1,
      phase: "guest_auto_prehold",
      reservationId,
      traceId,
      requestKey,
      authorityId: input.binding.authority.authorityId,
      clientTurnId: input.binding.clientTurnId,
      candidateDigest: input.binding.candidateDigest,
      reachableCandidateDigest: frozenReachableCandidateDigest,
      sourceCommitSha: input.binding.authority.sourceCommitSha,
      runtimeDeploymentId: input.binding.authority.runtimeDeploymentId,
      activationPairDigest: input.binding.authority.activationPairDigest,
      configDigest: input.binding.authority.configDigest,
      basisModelId: prehold.basisModelId,
      basisProvider: prehold.basisProvider,
      heldCredits,
      preholdAuditLogId,
      minuteEntries: minuteEntries.map((entry) => ({
        ...entry, periodStart: entry.periodStart.toISOString(),
      })),
      creditEntries: creditEntries.map((entry) => ({
        ...entry, periodStart: entry.periodStart.toISOString(),
      })),
    };
    const created = await tx.chatCreditReservation.create({
      data: {
        id: reservationId,
        userId: null,
        subjectKey: input.access.subjectKey,
        traceId,
        clientTurnId: input.binding.clientTurnId,
        source: "chat",
        phase: "guest_auto_prehold",
        provider: prehold.basisProvider,
        modelId: prehold.basisModelId,
        status: "guest_auto_preheld",
        idempotencyKey: requestKey,
        reservationPayload: payload as Prisma.InputJsonValue,
        reservedCredits: heldCredits,
        reservedCostMicroUsd: BigInt(0),
        planReservedCredits: 0,
        addOnReservedCredits: 0,
        expiresAt: new Date(input.binding.authority.expiresAtMs),
      },
    });
    return Object.freeze({
      state: stateFromRow(created),
      prehold,
    });
  }, { maxWait: 5_000, timeout: 15_000 });
}

export async function convertGuestAutoCreditPrehold(input: Readonly<{
  access: ChatAccess;
  binding: GuestAutoCreditBinding;
  prehold: GuestAutoCreditPrehold;
  budget: ChatBudget;
  traceId: string;
  enabledTools?: string[];
}>): Promise<{ leaseId: string; setCookie: string | undefined;
  usageReservation: ChatUsageReservation }> {
  assertBinding(input.access, input.binding);
  try {
    planGuestAutoCreditConversion({
      prehold: input.prehold,
      selectedModelId: input.budget.modelId,
      selectedProvider: input.budget.provider,
      selectedUsageCredits: input.budget.usageCredits,
    });
  } catch {
    throw new GuestAutoCreditLedgerError("transition_invalid");
  }
  const requestKey = guestAutoCreditRequestKey(
    input.access.subjectKey,
    input.binding.authority.authorityId,
  );
  const row = await prisma.chatCreditReservation.findUnique({
    where: { idempotencyKey: requestKey },
  });
  if (!row || row.phase !== "guest_auto_prehold" ||
      row.status !== "guest_auto_preheld" || row.traceId !== input.traceId) {
    throw new GuestAutoCreditLedgerError("transition_invalid");
  }
  const payload = parsePrehold(row.reservationPayload);
  if (
    !payloadMatchesBinding(row, input.access, input.binding, input.prehold) ||
    payload.reachableCandidateDigest !== reachableCandidateDigest(input.prehold)
  ) {
    throw new GuestAutoCreditLedgerError("duplicate_binding");
  }
  return acquireChatAccess(input.access, input.budget, {
    traceId: input.traceId,
    source: "chat",
    enabledTools: input.enabledTools,
    guestAutoPrehold: {
      reservationId: row.id,
      requestKey,
      authorityId: payload.authorityId,
      clientTurnId: payload.clientTurnId,
      candidateDigest: payload.candidateDigest,
      reachableCandidateDigest: payload.reachableCandidateDigest,
      sourceCommitSha: payload.sourceCommitSha,
      runtimeDeploymentId: payload.runtimeDeploymentId,
      activationPairDigest: payload.activationPairDigest,
      configDigest: payload.configDigest,
      basisModelId: payload.basisModelId,
      basisProvider: payload.basisProvider,
      heldCredits: payload.heldCredits,
      preholdAuditLogId: payload.preholdAuditLogId,
      creditEntries: datesForCreditEntries(payload),
    },
  });
}

export type GuestAutoCreditReleaseReason =
  | "authority_refused"
  | "refiner_confirmed_undispatched"
  | "router_refused_before_dispatch";

const GUEST_AUTO_CREDIT_RELEASE_SCOPE = Object.freeze({
  authority_refused: "pre_paid_full",
  refiner_confirmed_undispatched: "paid_refiner_financial_only",
  router_refused_before_dispatch: "paid_refiner_financial_only",
} as const satisfies Record<GuestAutoCreditReleaseReason,
  "pre_paid_full" | "paid_refiner_financial_only">);

export async function releaseGuestAutoCreditPrehold(input: Readonly<{
  access: ChatAccess;
  binding: GuestAutoCreditBinding;
  proofId: string;
  reason: GuestAutoCreditReleaseReason;
}>): Promise<GuestAutoCreditLedgerState> {
  assertBinding(input.access, input.binding);
  if (!UUID.test(input.proofId)) throw new GuestAutoCreditLedgerError("invalid_binding");
  const releaseScope = GUEST_AUTO_CREDIT_RELEASE_SCOPE[input.reason];
  if (!releaseScope) throw new GuestAutoCreditLedgerError("invalid_binding");
  const requestKey = guestAutoCreditRequestKey(input.access.subjectKey,
    input.binding.authority.authorityId);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.access.subjectKey}))`;
    const row = await tx.chatCreditReservation.findUnique({
      where: { idempotencyKey: requestKey },
    });
    if (!row || row.subjectKey !== input.access.subjectKey) {
      throw new GuestAutoCreditLedgerError("transition_invalid");
    }
    if (!payloadMatchesBinding(row, input.access, input.binding)) {
      throw new GuestAutoCreditLedgerError("duplicate_binding");
    }
    if (row.phase === "guest_auto_prehold" && row.status === "guest_auto_released") {
      return stateFromRow(row);
    }
    if (row.phase !== "guest_auto_prehold" || row.status !== "guest_auto_preheld") {
      throw new GuestAutoCreditLedgerError("transition_invalid");
    }
    const payload = parsePrehold(row.reservationPayload);
    // The minute entries count the request that bought the Refiner call, while
    // the credit entries fund the still-undispatched Chat model. Before paid
    // work both are unused. After a known Refiner spend, only the Chat credit
    // hold is unused: releasing the minute entries as well would let one Guest
    // repeat paid Refiner work without consuming the existing request throttle.
    const releasedEntries = releaseScope === "pre_paid_full"
      ? [...payload.minuteEntries, ...payload.creditEntries]
      : payload.creditEntries;
    for (const entry of releasedEntries) {
      await decrementEntry(tx, { ...entry, periodStart: new Date(entry.periodStart) });
    }
    const observedAt = new Date();
    const changed = await tx.chatCreditReservation.updateMany({
      where: { id: row.id, phase: "guest_auto_prehold", status: "guest_auto_preheld" },
      data: { status: "guest_auto_released", outcome: "failed",
        settledAt: observedAt, reconciledAt: observedAt },
    });
    if (changed.count !== 1) throw new GuestAutoCreditLedgerError("integrity_unavailable");
    await writeSystemAuditLog({
      tx,
      systemActor: "guest-chat-auto-credit",
      action: "guest_chat.auto_credit_released",
      targetType: "ChatCreditReservation",
      targetId: row.id,
      summary: "Released one confirmed-undispatched Guest Smart Adaptive credit prehold.",
      metadata: { authorityId: payload.authorityId, requestKey, proofId: input.proofId,
        reason: input.reason, releaseScope,
        requestThrottle: releaseScope === "pre_paid_full" ? "released" : "retained",
        heldCredits: payload.heldCredits },
    });
    return stateFromRow({ ...row, status: "guest_auto_released" });
  }, { maxWait: 5_000, timeout: 15_000 });
}

export async function markGuestAutoCreditUnknown(input: Readonly<{
  access: ChatAccess;
  binding: GuestAutoCreditBinding;
  observationId: string;
  boundary: "refiner" | "conversion" | "manifest" | "provider_dispatch" |
    "settlement";
}>): Promise<GuestAutoCreditLedgerState> {
  assertBinding(input.access, input.binding);
  if (!UUID.test(input.observationId)) {
    throw new GuestAutoCreditLedgerError("invalid_binding");
  }
  const requestKey = guestAutoCreditRequestKey(input.access.subjectKey,
    input.binding.authority.authorityId);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.access.subjectKey}))`;
    const row = await tx.chatCreditReservation.findUnique({
      where: { idempotencyKey: requestKey },
    });
    if (!row || row.subjectKey !== input.access.subjectKey) {
      throw new GuestAutoCreditLedgerError("transition_invalid");
    }
    if (!payloadMatchesBinding(row, input.access, input.binding)) {
      throw new GuestAutoCreditLedgerError("duplicate_binding");
    }
    if (row.status === "guest_auto_unknown") return stateFromRow(row);
    if (!((row.phase === "guest_auto_prehold" && row.status === "guest_auto_preheld") ||
          (row.phase === "exact" && row.status === "reserved"))) {
      throw new GuestAutoCreditLedgerError("transition_invalid");
    }
    const changed = await tx.chatCreditReservation.updateMany({
      where: { id: row.id, phase: row.phase, status: row.status },
      data: { status: "guest_auto_unknown", reconciledAt: new Date() },
    });
    if (changed.count !== 1) throw new GuestAutoCreditLedgerError("integrity_unavailable");
    await writeSystemAuditLog({
      tx,
      systemActor: "guest-chat-auto-credit",
      action: "guest_chat.auto_credit_unknown",
      targetType: "ChatCreditReservation",
      targetId: row.id,
      summary: "Retained Guest Smart Adaptive credit holds after an unknown outcome.",
      metadata: { requestKey, observationId: input.observationId,
        boundary: input.boundary, phase: row.phase },
    });
    return stateFromRow({ ...row, status: "guest_auto_unknown" });
  }, { maxWait: 5_000, timeout: 15_000 });
}

export async function readGuestAutoCreditState(input: Readonly<{
  subjectKey: string;
  authorityId: string;
}>): Promise<GuestAutoCreditLedgerState | null> {
  const requestKey = guestAutoCreditRequestKey(input.subjectKey, input.authorityId);
  const row = await prisma.chatCreditReservation.findUnique({
    where: { idempotencyKey: requestKey },
  });
  if (!row || row.subjectKey !== input.subjectKey ||
      !row.idempotencyKey.startsWith("guest-auto-credit:v1:")) return null;
  return stateFromRow(row);
}
