import "server-only";

import type { Prisma } from "@prisma/client";

import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest, type AmuxContentKeys } from "@/lib/amux/ideaCrypto";
import { AmuxIdeaKeyStoreError, createAmuxContentUnitKeys,
  loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { v22TaskResultIdeaId } from "@/lib/amux/v22TaskResultStore";
import { amuxV52FindingsRepeat, amuxV52RejectingVendors, countAmuxV52Findings,
  decodeAmuxV52FindingsDoc, encodeAmuxV52FindingsDoc, fitAmuxV52FindingsDoc,
  parseAmuxV52FindingsTransport, type AmuxV52FindingsDoc } from
  "@/lib/amux/v52ReviewFindingsCore";
import { prisma } from "@/lib/prisma";

/**
 * A rejected v52 review's findings as a sealed AMUX content unit (owner
 * decision 2026-11-15). The document is made and bounded by
 * v52ReviewFindingsCore.ts; this module only seals it with the attempt's own
 * key, stores it beside the review record, and opens it again for the three
 * readers: Admin, the Decision Maker's card and the next attempt's prompt.
 * Every reader treats the text as untrusted data. Key-store calls never run
 * inside a DB transaction: keys are created or loaded first, the rows are
 * read in the caller's boundary, and the bodies are opened after it.
 */

const PURPOSE = "review_findings" as const;

/**
 * The attempt's key, created before the record's transaction. Null when the
 * key store cannot be reached: the verdict is still recorded, and the owner is
 * told the reasons could not be kept. A key an earlier try left behind with no
 * body is reused (no body was ever sealed under it).
 */
export async function createAmuxV52ReviewFindingsKeys(ideaId: string,
  attemptId: string): Promise<AmuxContentKeys | null> {
  const identity = { ideaId, purpose: PURPOSE, subjectId: attemptId };
  try {
    return await createAmuxContentUnitKeys(identity);
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError && error.code === "conflict") {
      try { return await loadAmuxContentUnitKeys(identity); } catch { return null; }
    }
    return null;
  }
}

export type AmuxV52PreparedFindings = { doc: AmuxV52FindingsDoc; ideaId: string;
  keys: AmuxContentKeys; repeatsPrior: boolean };

/**
 * Before the record's transaction: the normalised document of a reject's
 * `findings_summary` and the attempt's key. Null when it is not a reject, the
 * launcher sent nothing a reader could use, the attempt's idea cannot be
 * found, or the key store is unreachable (the verdict is still recorded).
 */
export async function prepareAmuxV52ReviewFindings(input: { attemptId: string;
  verdict: string; findingsSummary: string | undefined }):
  Promise<AmuxV52PreparedFindings | null> {
  if (input.verdict !== "reject") return null;
  const parsed = parseAmuxV52FindingsTransport(input.findingsSummary);
  if (!parsed) return null;
  // A record that exists already (a repeated submission) seals no new body, so no key is made for it.
  const existing = await prisma.amuxV52ReviewRecord.findUnique({
    where: { attemptId: input.attemptId }, select: { attemptId: true } });
  if (existing) return null;
  const doc = fitAmuxV52FindingsDoc(parsed);
  const attempt = await prisma.amuxExecutionAttempt.findUnique({
    where: { id: input.attemptId },
    select: { taskId: true, task: { select: { sourceSnapshot: true } } },
  });
  const ideaId = v22TaskResultIdeaId(attempt?.task.sourceSnapshot);
  if (!attempt || !ideaId) return null;
  const keys = await createAmuxV52ReviewFindingsKeys(ideaId, input.attemptId);
  if (!keys) return null;
  return { doc, ideaId, keys, repeatsPrior: await repeatsPreviousRejection(attempt.taskId,
    input.attemptId, doc) };
}

/**
 * Whether the review about to be recorded says the same thing, from the same
 * vendor, as the Task's previous rejection. Best effort: a previous body that
 * cannot be opened means "not known to repeat", never a reason to fail.
 */
async function repeatsPreviousRejection(taskId: string, attemptId: string,
  doc: AmuxV52FindingsDoc): Promise<boolean> {
  try {
    const previous = await prisma.amuxV52ReviewRecord.findFirst({
      where: { taskId, verdict: "reject", attemptId: { not: attemptId } },
      orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
      select: HISTORY_SELECT,
    });
    if (!previous) return false;
    const [opened] = await openAmuxV52ReviewHistory([historyRow(previous)]);
    return opened?.opened?.doc ? amuxV52FindingsRepeat(doc, opened.opened.doc) : false;
  } catch { return false; }
}

export type AmuxV52SealedFindings = {
  ciphertext: Uint8Array<ArrayBuffer>; keyId: string; keyVersion: number;
  digest: string; digestKeyId: string; byteLength: number; findingCount: number;
};

/** Pure: seals the document under the attempt's key. */
export function sealAmuxV52ReviewFindings(doc: AmuxV52FindingsDoc,
  attemptId: string, keys: AmuxContentKeys): AmuxV52SealedFindings {
  const bytes = encodeAmuxV52FindingsDoc(doc);
  try {
    const sealed = sealAmuxContent(bytes, PURPOSE, attemptId, keys);
    try {
      return { ciphertext: new Uint8Array(sealed.ciphertext), keyId: sealed.keyId,
        keyVersion: sealed.keyVersion, digest: sealed.digest,
        digestKeyId: sealed.digestKeyId, byteLength: bytes.length,
        findingCount: Math.min(100_000, countAmuxV52Findings(doc)) };
    } finally { sealed.ciphertext.fill(0); }
  } finally { bytes.fill(0); }
}

/** The digest the audit row carries for a body, without sealing it. */
export function amuxV52ReviewFindingsDigest(doc: AmuxV52FindingsDoc,
  attemptId: string, keys: AmuxContentKeys) {
  const bytes = encodeAmuxV52FindingsDoc(doc);
  try { return amuxContentDigest(bytes, PURPOSE, attemptId, keys); }
  finally { bytes.fill(0); }
}

/** In the record's transaction, after the record row: one body per rejected attempt. */
export async function createAmuxV52ReviewFindingsRow(tx: Prisma.TransactionClient,
  input: { attemptId: string; taskId: string; ideaId: string;
    sealed: AmuxV52SealedFindings; repeatsPrior: boolean }) {
  await tx.amuxV52ReviewFindings.create({ data: {
    attemptId: input.attemptId, taskId: input.taskId, ideaId: input.ideaId,
    ciphertext: input.sealed.ciphertext, keyId: input.sealed.keyId,
    keyVersion: input.sealed.keyVersion, digest: input.sealed.digest,
    digestKeyId: input.sealed.digestKeyId, byteLength: input.sealed.byteLength,
    findingCount: input.sealed.findingCount, repeatsPrior: input.repeatsPrior,
  } });
}

export type AmuxV52SealedRow = { ideaId: string; ciphertext: Uint8Array | null;
  keyId: string | null; keyVersion: number | null; digest: string;
  digestKeyId: string; bodyPurgedAt: Date | null };

const SEALED = { ideaId: true, ciphertext: true, keyId: true, keyVersion: true,
  digest: true, digestKeyId: true, bodyPurgedAt: true } as const;

export type AmuxV52FindingsOpened =
  | { state: "available"; doc: AmuxV52FindingsDoc }
  | { state: "purged" | "unavailable"; doc: null };

/** Opens one attempt's body outside any DB transaction. Never throws. */
export async function openAmuxV52ReviewFindingsRow(attemptId: string,
  row: AmuxV52SealedRow | null | undefined): Promise<AmuxV52FindingsOpened | null> {
  if (!row) return null;
  if (row.bodyPurgedAt) return { state: "purged", doc: null };
  if (!row.ciphertext || !row.keyId || !row.keyVersion)
    return { state: "unavailable", doc: null };
  let keys: AmuxContentKeys | null = null;
  let plain: Buffer | null = null;
  try {
    keys = await loadAmuxContentUnitKeys({ ideaId: row.ideaId, purpose: PURPOSE,
      subjectId: attemptId });
    plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
      keyId: row.keyId, keyVersion: row.keyVersion }, PURPOSE, attemptId, keys);
    if (!verifyAmuxContentDigest(plain, PURPOSE, attemptId, row.digest,
      row.digestKeyId, keys)) return { state: "unavailable", doc: null };
    return { state: "available", doc: decodeAmuxV52FindingsDoc(plain) };
  } catch { return { state: "unavailable", doc: null }; }
  finally { plain?.fill(0); keys?.masterKey.fill(0); }
}

/** Prisma calls `readAmuxV52ReviewHistory` and `readAmuxV52RejectedReviews` make, for their caller's boundary. */
export const AMUX_V52_REVIEW_HISTORY_PRISMA_CALLS = 1;
/** Reviews read per Task: the newest few explain a retry; older ones add noise. */
export const AMUX_V52_REVIEW_HISTORY_TAKE = 4;
/** Rejected reviews of one Task a card shows. */
export const AMUX_V52_REJECTED_REVIEWS_PER_TASK = 3;

const HISTORY_SELECT = { taskId: true, attemptId: true, verdict: true, jobId: true,
  reviewerVendors: true, findingsSummary: true,
  attempt: { select: { attemptNumber: true } },
  findings: { select: SEALED } } as const;

const historyRow = (row: Prisma.AmuxV52ReviewRecordGetPayload<{
  select: typeof HISTORY_SELECT }>) => ({ taskId: row.taskId, attemptId: row.attemptId,
  verdict: row.verdict, jobId: row.jobId, reviewerVendors: row.reviewerVendors,
  findingsSummary: row.findingsSummary, attemptNumber: row.attempt.attemptNumber,
  sealed: row.findings });

/**
 * The Task's newest review records with their sealed findings, newest first.
 * One statement, so a delivery's or a card's boundary pays for one call; the
 * rows are opened afterwards, outside it.
 */
export async function readAmuxV52ReviewHistory(tx: Prisma.TransactionClient,
  taskId: string) {
  const rows = await tx.amuxV52ReviewRecord.findMany({
    where: { taskId },
    orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    take: AMUX_V52_REVIEW_HISTORY_TAKE,
    select: HISTORY_SELECT,
  });
  return rows.map(historyRow);
}
export type AmuxV52ReviewHistoryRow =
  Awaited<ReturnType<typeof readAmuxV52ReviewHistory>>[number];

/**
 * The newest rejected reviews of several Tasks, still one statement: at most
 * three per Task, newest first, for the cards the Decision Maker is shown.
 */
export async function readAmuxV52RejectedReviews(tx: Prisma.TransactionClient,
  taskIds: readonly string[]): Promise<AmuxV52ReviewHistoryRow[]> {
  if (taskIds.length === 0) return [];
  const rows = await tx.amuxV52ReviewRecord.findMany({
    where: { taskId: { in: [...taskIds] }, verdict: "reject" },
    orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    take: Math.min(60, taskIds.length * AMUX_V52_REJECTED_REVIEWS_PER_TASK * 2),
    select: HISTORY_SELECT,
  });
  const seen = new Map<string, number>();
  return rows.map(historyRow).filter((row) => {
    const count = (seen.get(row.taskId) ?? 0) + 1;
    seen.set(row.taskId, count);
    return count <= AMUX_V52_REJECTED_REVIEWS_PER_TASK;
  });
}

export type AmuxV52OpenedReview = AmuxV52ReviewHistoryRow & {
  opened: AmuxV52FindingsOpened | null;
  /** The vendors that rejected this run, as far as the record and body show. */
  rejectingVendors: string[];
};

/**
 * Opens a history's rejected rows (outside the DB transaction). A record made
 * before the findings were sealed reads as its plain summary, kept as a note.
 */
export async function openAmuxV52ReviewHistory(
  rows: readonly AmuxV52ReviewHistoryRow[]): Promise<AmuxV52OpenedReview[]> {
  const out: AmuxV52OpenedReview[] = [];
  for (const row of rows) {
    let opened = row.verdict === "reject" ?
      await openAmuxV52ReviewFindingsRow(row.attemptId, row.sealed) : null;
    if (row.verdict === "reject" && !opened?.doc && row.findingsSummary) {
      const legacy = parseAmuxV52FindingsTransport(row.findingsSummary);
      if (legacy) opened = { state: "available", doc: legacy };
    }
    const fromDoc = opened?.doc ? amuxV52RejectingVendors(opened.doc) : [];
    // Without a readable body, a run reviewed by one vendor was rejected by it.
    const rejectingVendors = fromDoc.length > 0 ? fromDoc :
      row.verdict === "reject" && row.reviewerVendors.length === 1 ? [...row.reviewerVendors] : [];
    out.push({ ...row, opened, rejectingVendors });
  }
  return out;
}
