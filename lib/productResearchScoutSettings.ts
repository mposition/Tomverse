/**
 * The Scout's model and daily call cap, set by an owner in Admin
 * (docs/policy/product-research-agent.md §13), and the call ledger the cap
 * counts.
 *
 * Two AppSetting rows: no model row means the model step is off, and no cap
 * row means a cap of zero, so nothing is spent until an owner sets both. Kept
 * out of lib/appSettings.ts, which sits inside the Prompt Refiner runtime
 * source closure.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SCOUT_DAILY_CALL_CAP_MAX, type ScoutCallRow } from "@/lib/productResearchScoutCore";

export const SCOUT_MODEL_SETTING_KEY = "productResearch.scoutModelId";
export const SCOUT_DAILY_CALL_CAP_SETTING_KEY = "productResearch.scoutDailyCallCap";

/** Lock id for the call ledger and the settings, so a reservation and a settings change never interleave. */
const SCOUT_CALL_LOCK = 734_209_118;

export type ScoutSettings = { readonly modelId: string | null; readonly dailyCallCap: number };

const parseCap = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, SCOUT_DAILY_CALL_CAP_MAX) : 0;
};

const settingsFrom = async (client: Pick<Prisma.TransactionClient, "appSetting">): Promise<ScoutSettings> => {
  const rows = await client.appSetting.findMany({
    where: { key: { in: [SCOUT_MODEL_SETTING_KEY, SCOUT_DAILY_CALL_CAP_SETTING_KEY] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((row) => row.key === key)?.value.trim();
  return { modelId: value(SCOUT_MODEL_SETTING_KEY) || null, dailyCallCap: parseCap(value(SCOUT_DAILY_CALL_CAP_SETTING_KEY)) };
};

/** The stored settings; an unreadable store reads as off. Never throws. */
export async function readScoutSettings(): Promise<ScoutSettings> {
  try {
    return await settingsFrom(prisma);
  } catch {
    return { modelId: null, dailyCallCap: 0 };
  }
}

/**
 * Writes both rows; `audit` runs in the same transaction, so the change and
 * its record land together. It takes the call lock first, so a reservation
 * that starts after this commits reads the new model and cap.
 */
export async function writeScoutSettings(
  settings: ScoutSettings,
  audit: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCOUT_CALL_LOCK})`;
    if (settings.modelId === null) {
      await tx.appSetting.deleteMany({ where: { key: SCOUT_MODEL_SETTING_KEY } });
    } else {
      await tx.appSetting.upsert({
        where: { key: SCOUT_MODEL_SETTING_KEY },
        create: { key: SCOUT_MODEL_SETTING_KEY, value: settings.modelId },
        update: { value: settings.modelId },
      });
    }
    const cap = String(Math.max(0, Math.min(settings.dailyCallCap, SCOUT_DAILY_CALL_CAP_MAX)));
    await tx.appSetting.upsert({
      where: { key: SCOUT_DAILY_CALL_CAP_SETTING_KEY },
      create: { key: SCOUT_DAILY_CALL_CAP_SETTING_KEY, value: cap },
      update: { value: cap },
    });
    await audit(tx);
  });
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type ScoutCallReservation = { readonly id: string } | { readonly refused: "model_off" | "daily_cap_reached" };

/**
 * Takes one call from today's cap (UTC day): a ledger row is written before
 * the model is called. The model and the cap are read again under the call
 * lock, which a settings write also takes, so turning the model off or
 * lowering the cap stops every reservation after it. A reservation for a model
 * that is no longer the chosen one is refused as model_off.
 */
export async function startScoutCall(input: {
  readonly subject: string;
  readonly modelId: string;
}): Promise<ScoutCallReservation> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCOUT_CALL_LOCK})`;
    const current = await settingsFrom(tx);
    if (current.modelId === null || current.modelId !== input.modelId) return { refused: "model_off" as const };
    const used = await tx.productResearchScoutLlmCall.count({ where: { createdAt: { gte: startOfUtcDay(new Date()) } } });
    if (used >= current.dailyCallCap) return { refused: "daily_cap_reached" as const };
    const row = await tx.productResearchScoutLlmCall.create({
      data: { subject: input.subject, modelId: input.modelId },
      select: { id: true },
    });
    return { id: row.id };
  });
}

export async function settleScoutCall(
  id: string,
  result: { readonly ok: boolean; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly kept: number | null },
): Promise<void> {
  await prisma.productResearchScoutLlmCall.update({
    where: { id },
    data: {
      outcome: result.ok ? "ok" : "failed",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      kept: result.kept,
    },
  });
}

export type ScoutUsageToday = { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number };

export async function scoutUsageToday(): Promise<ScoutUsageToday> {
  const totals = await prisma.productResearchScoutLlmCall.aggregate({
    where: { createdAt: { gte: startOfUtcDay(new Date()) } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return {
    calls: totals._count._all,
    inputTokens: totals._sum.inputTokens ?? 0,
    outputTokens: totals._sum.outputTokens ?? 0,
  };
}

/** The ledger rows of the last `days` UTC days, newest first, for the Admin run view. */
export async function scoutRecentCalls(days: number): Promise<ScoutCallRow[]> {
  const since = new Date(startOfUtcDay(new Date()).getTime() - (days - 1) * 86_400_000);
  return prisma.productResearchScoutLlmCall.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: days * SCOUT_DAILY_CALL_CAP_MAX,
    select: { createdAt: true, outcome: true, inputTokens: true, outputTokens: true, kept: true },
  });
}
