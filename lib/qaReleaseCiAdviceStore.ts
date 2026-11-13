import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { CI_ADVICE_ITEM_PREFIX, ciAdviceIdentity, parseCiAdviceItem, type CiAdviceItem, type CiAdviceConsole } from "@/lib/qaReleaseCiAdviceActionsCore";
import { qaReleaseCiAdviceFrom, type QaReleaseCiAdviceRecord, type QaReleaseCiAdviceSuggestion } from "@/lib/qaReleaseCiAdviceCore";
import { prisma } from "@/lib/prisma";

const KEY = "qa_release.ci_advice";
type Db = Pick<Prisma.TransactionClient, "appSetting">;
const itemKey = (id: string) => `${CI_ADVICE_ITEM_PREFIX}${id}`;
export const ciAdviceId = (item: QaReleaseCiAdviceSuggestion) => createHash("sha256").update(ciAdviceIdentity(item)).digest("hex");

async function readLatest(db: Db): Promise<QaReleaseCiAdviceRecord | null> {
  const row = await db.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    const suggestions = qaReleaseCiAdviceFrom(value);
    return typeof value.askedAt === "string" && suggestions !== null &&
      (value.answeredAt === null || typeof value.answeredAt === "string")
      ? { askedAt: value.askedAt, answeredAt: value.answeredAt, suggestions } : null;
  } catch {
    return null;
  }
}

export const readQaReleaseCiAdvice = () => readLatest(prisma);

const itemsFrom = (record: QaReleaseCiAdviceRecord | null): CiAdviceItem[] => {
  if (!record?.answeredAt) return [];
  const items = record.suggestions.flatMap((suggestion) => {
    const item = { ...suggestion, id: ciAdviceId(suggestion), createdAt: record.answeredAt, status: "open", at: null, amuxIdeaId: null };
    const parsed = parseCiAdviceItem(JSON.stringify(item));
    return parsed ? [parsed] : [];
  });
  return [...new Map(items.map((item) => [item.id, item])).values()];
};

async function readItems(db: Db, latest: QaReleaseCiAdviceRecord | null) {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: CI_ADVICE_ITEM_PREFIX } }, select: { key: true, value: true } });
  const seen = new Set(rows.map((row) => row.key));
  // A corrupt stored row remains a fence; never turn it into fresh open work.
  const stored = rows.flatMap((row) => {
    const item = parseCiAdviceItem(row.value);
    return item && itemKey(item.id) === row.key ? [item] : [];
  });
  return [...stored, ...itemsFrom(latest).filter((item) => !seen.has(itemKey(item.id)))];
}

/** Called under the shared audit lock by generation and operator actions. */
export async function ensureQaReleaseCiAdviceItems(tx: Prisma.TransactionClient): Promise<CiAdviceItem[]> {
  const latest = await readLatest(tx);
  const items = await readItems(tx, latest);
  for (const item of itemsFrom(latest)) {
    const key = itemKey(item.id), value = JSON.stringify(item);
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  return items;
}

/** Preserve pending items and all decisions when the model produces its next round. */
export async function recordQaReleaseCiAdvice(at: string, suggestions: QaReleaseCiAdviceSuggestion[] | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await ensureQaReleaseCiAdviceItems(tx);
    const before = await readLatest(tx);
    const record: QaReleaseCiAdviceRecord = suggestions === null
      ? { askedAt: at, answeredAt: before?.answeredAt ?? null, suggestions: before?.suggestions ?? [] }
      : { askedAt: at, answeredAt: at, suggestions };
    const value = JSON.stringify(record);
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
    await ensureQaReleaseCiAdviceItems(tx);
  });
}

export async function readQaReleaseCiAdviceConsole(): Promise<CiAdviceConsole | null> {
  const latest = await readLatest(prisma);
  if (!latest) return null;
  const items = await readItems(prisma, latest);
  return { ...latest, suggestions: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) };
}

type Operator = { session: Session; request: Request };
async function updateItem(tx: Prisma.TransactionClient, input: Operator, item: CiAdviceItem, next: CiAdviceItem) {
  await tx.appSetting.update({ where: { key: itemKey(item.id) }, data: { value: JSON.stringify(next) } });
  await writeAdminAuditLog({ tx, session: input.session, request: input.request, action: `qa_release.ci_advice.${next.status}`, targetType: "QaReleaseCiAdviceSuggestion",
    targetId: item.id, summary: "An administrator updated a CI improvement suggestion.",
    metadata: next.amuxIdeaId ? { amuxIdeaId: next.amuxIdeaId } : {} });
}

export async function changeCiAdviceStatus(input: Operator & { id: string; status: "completed" | "dismissed" | "sent"; ideaId?: string }) {
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const item = (await ensureQaReleaseCiAdviceItems(tx)).find((row) => row.id === input.id);
    if (!item) return null;
    if (item.status === input.status) return item;
    if (input.status === "sent" ? item.status !== "sending_to_amux" || !input.ideaId : item.status !== "open") return null;
    const next: CiAdviceItem = { ...item, status: input.status, at: new Date().toISOString(), amuxIdeaId: input.status === "sent" ? input.ideaId! : null };
    await updateItem(tx, input, item, next);
    return next;
  });
}

export async function reserveCiAdviceSend(input: Operator & { id: string }): Promise<CiAdviceItem | null> {
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const item = (await ensureQaReleaseCiAdviceItems(tx)).find((row) => row.id === input.id);
    if (!item || (item.status !== "open" && item.status !== "sending_to_amux")) return null;
    if (item.status === "sending_to_amux") return item;
    const next: CiAdviceItem = { ...item, status: "sending_to_amux", at: new Date().toISOString() };
    await updateItem(tx, input, item, next);
    return next;
  });
}

export async function readCiAdviceItem(id: string) {
  return (await readItems(prisma, await readLatest(prisma))).find((item) => item.id === id) ?? null;
}
