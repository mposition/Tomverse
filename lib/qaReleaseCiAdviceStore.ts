import "server-only";

import type { QaReleaseCiAdviceRecord, QaReleaseCiAdviceSuggestion } from "@/lib/qaReleaseCiAdviceCore";
import { prisma } from "@/lib/prisma";

/** One display-only row: the latest suggestions and when they were last asked for. Not an audit event. */
const KEY = "qa_release.ci_advice";

export async function readQaReleaseCiAdvice(): Promise<QaReleaseCiAdviceRecord | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as QaReleaseCiAdviceRecord;
    return typeof value.askedAt === "string" && Array.isArray(value.suggestions) ? value : null;
  } catch {
    return null;
  }
}

/** A failed ask (`suggestions` null) moves the clock and keeps the last answer. */
export async function recordQaReleaseCiAdvice(at: string, suggestions: QaReleaseCiAdviceSuggestion[] | null): Promise<void> {
  const before = await readQaReleaseCiAdvice();
  const record: QaReleaseCiAdviceRecord =
    suggestions === null
      ? { askedAt: at, answeredAt: before?.answeredAt ?? null, suggestions: before?.suggestions ?? [] }
      : { askedAt: at, answeredAt: at, suggestions };
  const value = JSON.stringify(record);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
