import "server-only";
import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { modelSupportsImageInput } from "@/lib/models";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import {
  readScoutSettings,
  startScoutCall,
  settleScoutCall,
} from "./productResearchScoutSettings";
import { scoutLlmFor } from "./productResearchScoutLlm";
import { recentSuggestionTitles } from "./productResearchScoutStore";
import {
  MEMORY_PROBE_LOCALES,
  type MemoryProbeLocale,
} from "./productResearchScoutMemoryCases";
import {
  assessMemory,
  dailyMemoryMode,
  memoryProbe,
  memorySubject,
  memoryReading,
  memoryLatestKey,
  parseMemoryReading,
  type MemoryReading,
} from "./productResearchScoutMemoryCore";
import {
  memoryIdeaInput,
  verifiedMemoryIdeas,
} from "./productResearchScoutMemoryIdeas";

export const MEMORY_SCOUT_ENV = "PRODUCT_RESEARCH_SCOUT_MEMORY_ENABLED";
export const memoryScoutEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[MEMORY_SCOUT_ENV] === "1";
const utcDay = () => new Date().toISOString().slice(0, 10);
const ideaSubject = "memory.continuation.ideas";

export async function latestMemoryReadings(): Promise<Array<MemoryReading & {measuredAt:string}>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: MEMORY_PROBE_LOCALES.map(memoryLatestKey) } },
    select: { key: true, value: true, updatedAt: true },
  });
  return rows.flatMap((row) => {
    const reading = parseMemoryReading(row.key, row.value);
    return reading ? [{ ...reading, measuredAt: row.updatedAt.toISOString() }] : [];
  });
}

export async function sampleMemoryQuality(locale: MemoryProbeLocale) {
  const day = utcDay(),
    subject = memorySubject(locale);
  const { modelId } = await readScoutSettings();
  if (!modelId) return { judged: false, reason: "model_off" };
  const model = await getEnabledRuntimeModel(modelId);
  if (!model || !modelSupportsImageInput(model))
    return { judged: false, reason: "model_off" };
  const probe = memoryProbe(day, locale, dailyMemoryMode(day, locale));
  const grant = await startScoutCall({ modelId, subject, onceOnUtcDay: day });
  if ("refused" in grant) return { judged: false, reason: grant.refused };
  let generated;
  try {
    // No tools, user credits, account data or grader answers in this request.
    generated = await generateText({
      model: getActiveAiModel(model),
      messages: probe.messages,
      maxOutputTokens: 512,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60000),
    });
  } catch {
    await settleScoutCall(grant.id, {
      ok: false,
      inputTokens: null,
      outputTokens: null,
      kept: null,
    });
    return { judged: false, reason: "model_failed" };
  }
  const result = memoryReading(
    probe,
    assessMemory(probe, generated.text),
    modelId,
  );
  await prisma.$transaction(async (tx) => {
    // The latest of two calls finishing out of order across UTC midnight wins.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subject}))`;
    const key = memoryLatestKey(locale),
      prior = await tx.appSetting.findUnique({
        where: { key },
        select: { value: true },
      });
    if (!prior || (parseMemoryReading(key, prior.value)?.day ?? "") <= day) {
      const value = JSON.stringify(result);
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    await tx.productResearchScoutLlmCall.update({
      where: { id: grant.id },
      data: {
        outcome: "ok",
        kept: 0,
        inputTokens: generated.usage.inputTokens ?? null,
        outputTokens: generated.usage.outputTokens ?? null,
      },
    });
  });
  return { judged: true, stored: 0, outcome: result.outcome };
}

export async function proposeMemoryImprovements() {
  const day = utcDay(),
    { modelId } = await readScoutSettings();
  if (!modelId) return { judged: false, reason: "model_off" };
  const readings = (await latestMemoryReadings()).filter(
    (r) => r.day === day && r.model === modelId && r.outcome !== "pass",
  );
  if (!readings.length) return { judged: false, reason: "nothing_to_triage" };
  const llm = await scoutLlmFor(modelId);
  if (!llm) return { judged: false, reason: "model_off" };
  const existing = (
    await Promise.all(
      readings.map((r) => recentSuggestionTitles(memorySubject(r.locale))),
    )
  ).flat();
  const grant = await startScoutCall({
    modelId,
    subject: ideaSubject,
    onceOnUtcDay: day,
  });
  if ("refused" in grant) return { judged: false, reason: grant.refused };
  const judgement = await llm.judge(memoryIdeaInput(readings), existing);
  if (!judgement.suggestions) {
    await settleScoutCall(grant.id, {
      ok: false,
      inputTokens: judgement.inputTokens,
      outputTokens: judgement.outputTokens,
      kept: null,
    });
    return { judged: false, reason: "model_failed" };
  }
  const ideas = verifiedMemoryIdeas(readings, judgement.suggestions, existing);
  const stored = await prisma.$transaction(async (tx) => {
    if (ideas.length)
      await tx.productResearchSuggestion.createMany({
        data: ideas.map(({ subject, suggestion }) => ({
          kind: "catalogue",
          subject,
          modelId,
          ...suggestion,
        })),
      });
    await tx.productResearchScoutLlmCall.update({
      where: { id: grant.id },
      data: {
        outcome: "ok",
        inputTokens: judgement.inputTokens,
        outputTokens: judgement.outputTokens,
        kept: ideas.length,
      },
    });
    return ideas.length;
  });
  return { judged: true, stored };
}
