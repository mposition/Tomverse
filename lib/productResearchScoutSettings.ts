/**
 * The Scout's model, daily call cap and daily generation cap, set by an owner in
 * Admin (docs/policy/product-research-agent.md §13), and the ledger the caps
 * count.
 *
 * Three AppSetting rows: no model row means the model step is off, and no cap
 * row means a cap of zero, so nothing is spent until an owner sets them. Kept
 * out of lib/appSettings.ts, which sits inside the Prompt Refiner runtime
 * source closure.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SCOUT_DAILY_CALL_CAP_MAX,
  SCOUT_GENERATION_DAILY_CAP_MAX,
  SCOUT_GENERATION_PERMIT_PREFIX,
  type ScoutCallRow,
} from "@/lib/productResearchScoutCore";

export const SCOUT_MODEL_SETTING_KEY = "productResearch.scoutModelId";
export const SCOUT_DAILY_CALL_CAP_SETTING_KEY = "productResearch.scoutDailyCallCap";
export const SCOUT_GENERATION_DAILY_CAP_SETTING_KEY = "productResearch.scoutGenerationDailyCap";

/** What a generation permit's ledger row names in place of a model: the product chose the model. */
const SCOUT_GENERATION_LEDGER_MODEL = "product-path";
/** The model-call cap and its figures count model calls, not generation permits. */
const MODEL_CALLS = { subject: { not: { startsWith: SCOUT_GENERATION_PERMIT_PREFIX } } };
const GENERATION_PERMITS = { subject: { startsWith: SCOUT_GENERATION_PERMIT_PREFIX } };

/** Lock id for the call ledger and the settings, so a reservation and a settings change never interleave. */
const SCOUT_CALL_LOCK = 734_209_118;

export type ScoutSettings = { readonly modelId: string | null; readonly dailyCallCap: number; readonly generationDailyCap: number };

const parseCap = (value: string | undefined, max: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : 0;
};

const settingsFrom = async (client: Pick<Prisma.TransactionClient, "appSetting">): Promise<ScoutSettings> => {
  const rows = await client.appSetting.findMany({
    where: { key: { in: [SCOUT_MODEL_SETTING_KEY, SCOUT_DAILY_CALL_CAP_SETTING_KEY, SCOUT_GENERATION_DAILY_CAP_SETTING_KEY] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((row) => row.key === key)?.value.trim();
  return {
    modelId: value(SCOUT_MODEL_SETTING_KEY) || null,
    dailyCallCap: parseCap(value(SCOUT_DAILY_CALL_CAP_SETTING_KEY), SCOUT_DAILY_CALL_CAP_MAX),
    generationDailyCap: parseCap(value(SCOUT_GENERATION_DAILY_CAP_SETTING_KEY), SCOUT_GENERATION_DAILY_CAP_MAX),
  };
};

/** The stored settings; an unreadable store reads as off. Never throws. */
export async function readScoutSettings(): Promise<ScoutSettings> {
  try {
    return await settingsFrom(prisma);
  } catch {
    return { modelId: null, dailyCallCap: 0, generationDailyCap: 0 };
  }
}

/**
 * Writes every row; `audit` runs in the same transaction, so the change and
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
    const generationCap = String(Math.max(0, Math.min(settings.generationDailyCap, SCOUT_GENERATION_DAILY_CAP_MAX)));
    await tx.appSetting.upsert({
      where: { key: SCOUT_GENERATION_DAILY_CAP_SETTING_KEY },
      create: { key: SCOUT_GENERATION_DAILY_CAP_SETTING_KEY, value: generationCap },
      update: { value: generationCap },
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
    const used = await tx.productResearchScoutLlmCall.count({ where: { createdAt: { gte: startOfUtcDay(new Date()) }, ...MODEL_CALLS } });
    if (used >= current.dailyCallCap) return { refused: "daily_cap_reached" as const };
    const row = await tx.productResearchScoutLlmCall.create({
      data: { subject: input.subject, modelId: input.modelId },
      select: { id: true },
    });
    return { id: row.id };
  });
}

/**
 * Takes real generations from today's cap (UTC day), as many of those asked for
 * as it still allows, under the same lock as the settings: a ledger row each,
 * written before the walker spends anything, so an owner lowering the cap stops
 * every run after the change. A permit a run did not use stays spent. No permit
 * is granted while the model is off or the model-call cap is zero: nothing would
 * judge what the money made. `audit` runs in the same transaction with what was
 * granted.
 */
export async function reserveScoutGenerations(
  requested: readonly string[],
  audit: (tx: Prisma.TransactionClient, granted: readonly string[]) => Promise<unknown>,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCOUT_CALL_LOCK})`;
    const { modelId, dailyCallCap, generationDailyCap } = await settingsFrom(tx);
    const used = await tx.productResearchScoutLlmCall.count({ where: { createdAt: { gte: startOfUtcDay(new Date()) }, ...GENERATION_PERMITS } });
    const allowed = modelId === null || dailyCallCap === 0 ? 0 : Math.max(0, generationDailyCap - used);
    const granted = requested.slice(0, allowed);
    if (granted.length > 0) {
      await tx.productResearchScoutLlmCall.createMany({
        data: granted.map((id) => ({
          subject: `${SCOUT_GENERATION_PERMIT_PREFIX}${id}`,
          modelId: SCOUT_GENERATION_LEDGER_MODEL,
          outcome: "ok",
        })),
      });
    }
    await audit(tx, granted);
    return granted;
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

export type ScoutUsageToday = {
  readonly calls: number;
  readonly generations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export async function scoutUsageToday(): Promise<ScoutUsageToday> {
  const today = { gte: startOfUtcDay(new Date()) };
  const [totals, generations] = await Promise.all([
    prisma.productResearchScoutLlmCall.aggregate({
      where: { createdAt: today, ...MODEL_CALLS },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.productResearchScoutLlmCall.count({ where: { createdAt: today, ...GENERATION_PERMITS } }),
  ]);
  return {
    calls: totals._count._all,
    generations,
    inputTokens: totals._sum.inputTokens ?? 0,
    outputTokens: totals._sum.outputTokens ?? 0,
  };
}

/** The ledger rows of the last `days` UTC days, newest first, for the Admin run view. */
export async function scoutRecentCalls(days: number): Promise<ScoutCallRow[]> {
  const since = new Date(startOfUtcDay(new Date()).getTime() - (days - 1) * 86_400_000);
  return prisma.productResearchScoutLlmCall.findMany({
    where: { createdAt: { gte: since }, ...MODEL_CALLS },
    orderBy: { createdAt: "desc" },
    take: days * SCOUT_DAILY_CALL_CAP_MAX,
    select: { createdAt: true, outcome: true, inputTokens: true, outputTokens: true, kept: true },
  });
}
