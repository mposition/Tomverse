import "server-only";
import { prisma } from "./prisma";
import {
  ARM_NAMES,
  SCENARIOS,
  EXPERIMENT_VERSION,
  type Trial,
} from "./scoutMemoryExperiment";
import { MEMORY_PROBE_LOCALES } from "./productResearchScoutMemoryCases";
const PREFIX = "productResearch.memoryTrials.";
function storageKey(r: Trial) {
  const slot = Math.floor(Date.parse(r.day + "T00:00:00Z") / 86400000) % 7;
  return PREFIX + [slot, r.locale, r.arm].join(".");
}
function parseTrial(key: string, raw: string): Trial | null {
  try {
    const v = JSON.parse(raw) as Trial;
    if (
      !v ||
      v.version !== EXPERIMENT_VERSION ||
      !MEMORY_PROBE_LOCALES.includes(v.locale) ||
      !ARM_NAMES.includes(v.arm) ||
      !SCENARIOS.includes(v.scenario) ||
      typeof v.model !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.day) ||
      !/^[a-f0-9]{64}$/.test(v.sourceDigest) ||
      !Number.isFinite(Date.parse(v.measuredAt)) ||
      key !== storageKey(v) ||
      ![v.elapsedMs, v.answerMs, v.retrievalMs].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      ![
        v.answerMicroUsd,
        v.retrievalMicroUsd,
        v.inputTokens,
        v.outputTokens,
        v.rerankTokens,
      ].every((n) => n === null || (Number.isFinite(n) && n >= 0)) ||
      ![v.exact, v.decision, v.exceptions, v.abstained].every(
        (x) => typeof x === "boolean",
      ) ||
      !(v.scenario === "absent"
        ? v.retrieved === null
        : typeof v.retrieved === "boolean")
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
export async function recentMemoryTrials(now = new Date()): Promise<Trial[]> {
  const first = new Date(now.getTime() - 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: PREFIX } },
    select: { key: true, value: true },
  });
  return rows.flatMap((row) => {
    const v = parseTrial(row.key, row.value);
    return v && v.day >= first && v.day <= today ? [v] : [];
  });
}
export async function storeMemoryTrial(r: Trial, callId: string) {
  const key = storageKey(r),
    value = JSON.stringify(r);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const existing = await tx.appSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const prior = existing && parseTrial(key, existing.value);
    if (!prior || prior.day <= r.day)
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    await tx.productResearchScoutLlmCall.update({
      where: { id: callId },
      data: {
        outcome: "ok",
        kept: 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      },
    });
  });
}
