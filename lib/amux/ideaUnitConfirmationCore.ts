import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { AMUX_V4_IDEA_SOURCE_SYSTEM } from "./ideaIdentityCore.ts";
import { checkV4TaskApprovedCeiling, type V4TaskCostCeilingResult } from "./v4TaskCostCeilingCore.ts";

/**
 * Dark v4 owner-confirmation contract. This module only hashes bounded,
 * non-body metadata. The app must assemble it from freshly authorized DB
 * rows and a server-computed cost receipt, then re-read those rows under the
 * consume transaction. Consume must compare against the stored prepare snapshot;
 * rebuilding its reviewed timestamps changes the digest. A model or browser
 * must never supply the final snapshot.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/);
const keyId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const version = z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);
const utcIso = z.string().length(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value);
const amount = z.string().max(19).regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
const routeLabel = z.string().min(1).max(160)
  .refine((value) => value === value.trim() && value === value.normalize("NFC") &&
    !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/iu.test(value) &&
    !/[\ud800-\udfff]/u.test(value));
const localRef = z.string().max(128)
  .regex(/^c(0|[1-9][0-9]*):(node|card|evidence)-(0|[1-9][0-9]{0,3})$/);
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);

const keyedDigest = z.object({ digest, keyId }).strict();
const node = z.object({
  id,
  level: z.enum(["initiative", "epic", "feature"]),
  parentId: id.nullable(),
  revision,
  content: keyedDigest,
  state: z.literal("active"),
  approvedDecisionId: id,
}).strict();
const cardTarget = z.object({
  kind: z.literal("card"),
  id,
  cardType: z.enum(["story", "task"]),
  storyKind: z.enum(["general", "bug"]).nullable(),
  featureNodeId: id,
  sourceSystem: z.literal(AMUX_V4_IDEA_SOURCE_SYSTEM),
  status: z.enum(["backlog", "todo", "doing", "review", "done", "blocked", "cancelled"]),
  revision,
  content: keyedDigest,
}).strict();
const nodeTarget = z.object({
  kind: z.literal("node"),
  id,
  level: z.enum(["initiative", "epic", "feature"]),
  parentId: id.nullable(),
  revision,
  content: keyedDigest,
  state: z.literal("active"),
  approvedDecisionId: id,
}).strict();
const cardReference = z.object({
  id,
  cardType: z.enum(["story", "task"]),
  featureNodeId: id,
  sourceSystem: z.literal(AMUX_V4_IDEA_SOURCE_SYSTEM),
  status: z.enum(["backlog", "todo", "doing", "review", "done", "blocked", "cancelled"]),
  revision,
  content: keyedDigest,
}).strict();
const evidence = z.object({ id, content: keyedDigest }).strict();
const duplicateCandidate = z.object({
  id,
  kind: z.enum(["node", "card"]),
  revision,
  content: keyedDigest,
}).strict();
const duplicateScan = z.object({
  scanVersion: version,
  checkedAtIso: utcIso,
  query: keyedDigest,
  result: keyedDigest,
  complete: z.literal(true),
  candidates: z.array(duplicateCandidate).max(64),
}).strict();
export type AmuxIdeaDuplicateScan = z.infer<typeof duplicateScan>;

const costRoute = z.object({
  routeId: routeLabel,
  workerName: routeLabel,
  provider: routeLabel,
  modelId: routeLabel,
  routePolicyDigest: digest,
  perAttemptMicroUsd: amount,
}).strict();
const costReceipt = z.object({
  role: routeLabel,
  grade: routeLabel,
  catalogVersion: routeLabel,
  catalogDigest: digest,
  pricingVersion: routeLabel,
  gradeRulesVersion: routeLabel,
  calculatedAtIso: utcIso,
  caps: z.object({
    uncachedInputTokens: revision,
    outputTokens: revision,
    cacheReadTokens: revision,
    cacheWriteTokens: revision,
    maxAttempts: z.number().int().positive().refine(Number.isSafeInteger),
  }).strict(),
  routes: z.array(costRoute).min(1).max(128),
  ceilingMicroUsd: amount,
  receiptDigest: digest,
}).strict();

const card = z.object({
  cardType: z.enum(["story", "task"]),
  storyKind: z.enum(["general", "bug"]).nullable(),
  normalizedBody: keyedDigest,
  featureNodeId: id,
  parentStory: cardReference.nullable(),
  dependencies: z.array(cardReference).max(128),
  evidence: z.array(evidence).max(128),
  task: z.object({
    role: routeLabel,
    grade: routeLabel,
    brief: keyedDigest,
    costReceipt,
    /** Missing in pre-v2 prepared decisions means no public PR consent. */
    publicPrDisclosureApproved: z.boolean().optional(),
  }).strict().nullable(),
}).strict();

const draftShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), level: z.enum(["initiative", "epic", "feature"]) }).strict(),
  z.object({ kind: z.literal("card"), cardType: z.enum(["story", "task"]),
    storyKind: z.enum(["general", "bug"]).nullable() }).strict(),
]);

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal("amux-intake-v11"),
  canonicalizerVersion: z.literal("amux-canonical-v1"),
  scannerVersion: version,
  ideaId: id,
  decisionId: id,
  prepareRequestId: z.uuid().regex(/^[0-9a-f-]+$/),
  actorUserId: id,
  ownerSession: keyedDigest,
  draftUnitId: id,
  localRef,
  unitVersion: revision,
  unitKind: z.enum(["node", "card"]),
  unitBody: keyedDigest,
  draftShape,
  action: z.enum([
    "create_node", "select_existing_node", "register_card",
    "link_existing_card", "link_existing_node", "reject_unit",
  ]),
  source: z.object({
    previewId: id,
    payload: keyedDigest,
    scopeApprovalId: id.nullable(),
    scope: keyedDigest.nullable(),
  }).strict(),
  hierarchy: z.array(node).max(3),
  nodeProposal: z.object({
    id,
    level: z.enum(["initiative", "epic", "feature"]),
    parentId: id.nullable(),
  }).strict().nullable(),
  target: z.union([nodeTarget, cardTarget]).nullable(),
  card: card.nullable(),
  duplicates: duplicateScan.nullable(),
  decisionReason: keyedDigest.nullable(),
}).strict();

export type AmuxIdeaUnitConfirmationSnapshot = z.infer<typeof snapshotSchema>;

const MAX_SNAPSHOT_BYTES = 32_768;
const asciiOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const coherentCardKind = (cardType: "story" | "task", storyKind: "general" | "bug" | null) =>
  cardType === "story" ? storyKind !== null : storyKind === null;
const stableCostBody = (value: z.infer<typeof costReceipt>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "calculatedAtIso" && key !== "receiptDigest"));

const semanticShapeValid = (
  value: AmuxIdeaUnitConfirmationSnapshot,
  currentTaskCost: V4TaskCostCeilingResult | null,
  currentDuplicateScan: AmuxIdeaDuplicateScan | null,
): boolean => {
  if (!unique(value.hierarchy.map((entry) => entry.id))) return false;
  if (value.draftShape.kind !== value.unitKind) return false;
  const expectedLevels = ["initiative", "epic", "feature"];
  for (const [index, entry] of value.hierarchy.entries()) {
    if (entry.level !== expectedLevels[index] ||
      entry.parentId !== (index === 0 ? null : value.hierarchy[index - 1].id)) return false;
  }
  const isNode = value.unitKind === "node";
  if (value.draftShape.kind === "card" &&
      !coherentCardKind(value.draftShape.cardType, value.draftShape.storyKind)) return false;
  if (value.localRef.split(":")[1].split("-")[0] !== value.unitKind) return false;
  if (value.action === "reject_unit") {
    return value.card === null && value.nodeProposal === null &&
      value.target === null && value.hierarchy.length === 0 &&
      value.duplicates === null && currentDuplicateScan === null &&
      value.decisionReason !== null &&
      currentTaskCost === null &&
      ((value.source.scopeApprovalId === null) === (value.source.scope === null));
  }
  if (value.duplicates === null || currentDuplicateScan === null) return false;
  const { checkedAtIso: reviewedScanAt, ...reviewedScanBody } = value.duplicates;
  const { checkedAtIso: currentScanAt, ...currentScanBody } = currentDuplicateScan;
  if (currentScanAt < reviewedScanAt ||
      amuxCanonicalJson(reviewedScanBody) !== amuxCanonicalJson(currentScanBody) ||
      !unique(value.duplicates.candidates.map((entry) => `${entry.kind}:${entry.id}`)) ||
      value.duplicates.candidates.some((entry, index, items) => index > 0 &&
        asciiOrder(`${items[index - 1].kind}:${items[index - 1].id}`,
          `${entry.kind}:${entry.id}`) >= 0)) return false;
  if (value.action === "create_node" || value.action === "select_existing_node" ||
      value.action === "link_existing_node") {
    if (!isNode || value.card !== null) return false;
  } else if (value.action === "register_card" || value.action === "link_existing_card") {
    if (isNode) return false;
  }
  if (value.action === "select_existing_node" || value.action === "link_existing_node") {
    if (value.target?.kind !== "node") return false;
  } else if (value.action === "link_existing_card") {
    if (value.target?.kind !== "card") return false;
  } else if (value.target !== null) return false;

  if (isNode) {
    if (value.draftShape.kind !== "node" || currentTaskCost !== null) return false;
    if (value.action === "create_node") {
      if (value.nodeProposal === null || value.hierarchy.length > 2 ||
          value.nodeProposal.level !== expectedLevels[value.hierarchy.length] ||
          value.nodeProposal.level !== value.draftShape.level ||
          value.hierarchy.some((entry) => entry.id === value.nodeProposal?.id) ||
          value.nodeProposal.parentId !== (value.hierarchy.at(-1)?.id ?? null)) return false;
    } else {
      if (value.nodeProposal !== null || value.target?.kind !== "node" ||
          value.hierarchy.length > 2 ||
          value.target.level !== expectedLevels[value.hierarchy.length] ||
          value.target.level !== value.draftShape.level ||
          value.hierarchy.some((entry) => entry.id === value.target?.id) ||
          value.target.parentId !== (value.hierarchy.at(-1)?.id ?? null)) return false;
    }
  } else if (value.nodeProposal !== null) return false;

  if (value.action === "register_card" && value.card === null) return false;
  if (value.action === "link_existing_card" && value.card !== null) return false;
  if (value.card !== null) {
    const c = value.card;
    if (value.draftShape.kind !== "card" ||
        value.draftShape.cardType !== c.cardType ||
        value.draftShape.storyKind !== c.storyKind) return false;
    if (value.hierarchy.length !== 3 || c.featureNodeId !== value.hierarchy[2].id ||
        !unique(c.dependencies.map((entry) => entry.id)) ||
        !unique(c.evidence.map((entry) => entry.id)) ||
        c.dependencies.some((entry) => entry.cardType !== "task" || entry.status === "cancelled") ||
        (c.parentStory !== null && (c.parentStory.cardType !== "story" ||
          c.parentStory.featureNodeId !== c.featureNodeId ||
          c.parentStory.status !== "backlog" ||
          c.dependencies.some((entry) => entry.id === c.parentStory?.id)))) return false;
    if (c.cardType === "story") {
      if (c.storyKind === null || c.parentStory !== null || c.task !== null ||
          c.dependencies.length !== 0 || currentTaskCost !== null) return false;
    } else {
      if (c.storyKind !== null || c.task === null) return false;
      if (c.task.publicPrDisclosureApproved === true &&
          c.task.role !== "implement") return false;
      if (currentTaskCost?.ok !== true) return false;
      const currentReceipt = costReceipt.safeParse(currentTaskCost.receipt);
      if (!currentReceipt.success) return false;
      const reviewedCostAt = c.task.costReceipt.calculatedAtIso;
      const currentCostAt = currentReceipt.data.calculatedAtIso;
      if (c.task.role !== c.task.costReceipt.role || c.task.grade !== c.task.costReceipt.grade ||
          currentCostAt < reviewedCostAt ||
          amuxCanonicalJson(stableCostBody(c.task.costReceipt)) !==
            amuxCanonicalJson(stableCostBody(currentReceipt.data)) ||
          checkV4TaskApprovedCeiling(c.task.costReceipt,
            { ok: true, receipt: currentReceipt.data }).decision !== "allow") {
        return false;
      }
    }
  } else if (currentTaskCost !== null) {
    return false;
  }
  if (value.action === "link_existing_card" &&
      (value.target?.kind !== "card" || value.hierarchy.length !== 3 ||
        value.target.featureNodeId !== value.hierarchy[2].id ||
        value.target.status === "cancelled" ||
        value.draftShape.kind !== "card" ||
        !coherentCardKind(value.target.cardType, value.target.storyKind) ||
        value.target.cardType !== value.draftShape.cardType ||
        value.target.storyKind !== value.draftShape.storyKind)) return false;
  const reasonRequired = value.action === "link_existing_card" ||
    value.action === "link_existing_node" ||
    ((value.action === "create_node" || value.action === "register_card") &&
      value.duplicates.candidates.length > 0);
  if (reasonRequired !==
      (value.decisionReason !== null)) return false;
  if ((value.source.scopeApprovalId === null) !== (value.source.scope === null)) return false;
  return true;
};

const normalize = (value: AmuxIdeaUnitConfirmationSnapshot): AmuxIdeaUnitConfirmationSnapshot => ({
  ...value,
  card: value.card === null ? null : {
    ...value.card,
    dependencies: [...value.card.dependencies].sort((a, b) => asciiOrder(a.id, b.id)),
    evidence: [...value.card.evidence].sort((a, b) => asciiOrder(a.id, b.id)),
  },
});

export type AmuxIdeaUnitConfirmationResult =
  | { ok: true; confirmationDigest: string; digestKeyId: string; bytes: number }
  | { ok: false; code: "schema_rejected" | "semantic_conflict" | "too_large" | "key_invalid" };

export function deriveAmuxIdeaUnitConfirmation(
  rawSnapshot: unknown,
  key: { digestKeyId: string; digestKey: Buffer },
  /** Recomputed from the current DB candidate scan, never copied from the snapshot. */
  currentDuplicateScan: unknown,
  /** Recomputed from the current server catalog, never copied from the snapshot. */
  currentTaskCost: V4TaskCostCeilingResult | null,
): AmuxIdeaUnitConfirmationResult {
  if (!key || !keyId.safeParse(key.digestKeyId).success ||
    !Buffer.isBuffer(key.digestKey) || key.digestKey.length !== 32) {
    return { ok: false, code: "key_invalid" };
  }
  try {
    const rough = JSON.stringify(rawSnapshot);
    if (typeof rough !== "string") return { ok: false, code: "schema_rejected" };
    if (Buffer.byteLength(rough, "utf8") > MAX_SNAPSHOT_BYTES) {
      return { ok: false, code: "too_large" };
    }
    const parsed = snapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) return { ok: false, code: "schema_rejected" };
    const scan = currentDuplicateScan === null ? null : duplicateScan.safeParse(currentDuplicateScan);
    if (scan !== null && !scan.success) return { ok: false, code: "semantic_conflict" };
    if (!semanticShapeValid(parsed.data, currentTaskCost, scan?.data ?? null)) {
      return { ok: false, code: "semantic_conflict" };
    }
    const canonical = amuxCanonicalJson(normalize(parsed.data));
    const bytes = Buffer.byteLength(canonical, "utf8");
    if (bytes > MAX_SNAPSHOT_BYTES) return { ok: false, code: "too_large" };
    const confirmationDigest = createHmac("sha256", key.digestKey)
      .update("amux-v4-unit-confirmation-v1\0", "utf8")
      .update(key.digestKeyId, "ascii")
      .update("\0", "utf8")
      .update(canonical, "utf8")
      .digest("hex");
    return { ok: true, confirmationDigest, digestKeyId: key.digestKeyId, bytes };
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
}

/** A digest comparison is not authorization; the caller also checks DB owner/session/base. */
export function sameAmuxIdeaUnitConfirmation(a: unknown, b: unknown): boolean {
  if (!digest.safeParse(a).success || !digest.safeParse(b).success) return false;
  return timingSafeEqual(Buffer.from(a as string, "hex"), Buffer.from(b as string, "hex"));
}
