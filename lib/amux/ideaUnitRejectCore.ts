import { deriveAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationResult } from "./ideaUnitConfirmationCore.ts";
import { AMUX_V4_INPUT_SCANNER_VERSION } from "./localIntakeCore.ts";
import { amuxAnalysisTextSafe,
  type AmuxAnalysisChunk } from "./ideaAnalysisChunkCore.ts";
import type { AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxUnitDecisionBinding } from "./ideaUnitDecisionBindingCore.ts";

export const AMUX_V4_UNIT_REJECT_WRITE_ENV = "TOMVERSE_AMUX_V4_UNIT_REJECT_WRITE";
export const AMUX_V4_UNIT_REJECT_CODE_LATCH = false;
export const amuxV4UnitRejectWritePermitted = (value: string | undefined) =>
  AMUX_V4_UNIT_REJECT_CODE_LATCH && value === "enabled";
export const AMUX_V4_UNIT_REJECT_READ_ENV = "TOMVERSE_AMUX_V4_UNIT_REJECT_READ";
export const AMUX_V4_UNIT_REJECT_READ_CODE_LATCH = false;
export const amuxV4UnitRejectReadPermitted = (value: string | undefined) =>
  AMUX_V4_UNIT_REJECT_READ_CODE_LATCH && value === "enabled";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REF = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export const AMUX_V4_UNIT_REJECT_BODY_MAX_BYTES = 2_048;

export type AmuxUnitRejectRequest =
  | { stage: "prepare"; ideaId: string; draftUnitId: string;
      decisionId: string; prepareRequestId: string; reason: string }
  | { stage: "consume"; ideaId: string; draftUnitId: string;
      decisionId: string; prepareRequestId: string; consumeRequestId: string;
      confirmationDigest: string; reason: string };

const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

export function inspectAmuxUnitRejectRequest(raw: string): AmuxUnitRejectRequest | null {
  if (typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") > AMUX_V4_UNIT_REJECT_BODY_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const isPrepare = data.stage === "prepare";
  if (!isPrepare && data.stage !== "consume") return null;
  const required = ["stage", "ideaId", "draftUnitId", "decisionId",
    "prepareRequestId", "reason"];
  if (!exact(data, isPrepare ? required : [...required,
    "consumeRequestId", "confirmationDigest"]) ||
      typeof data.ideaId !== "string" || !REF.test(data.ideaId) ||
      typeof data.draftUnitId !== "string" || !REF.test(data.draftUnitId) ||
      typeof data.decisionId !== "string" || !UUID.test(data.decisionId) ||
      typeof data.prepareRequestId !== "string" ||
      !UUID.test(data.prepareRequestId) ||
      data.decisionId === data.prepareRequestId ||
      typeof data.reason !== "string" || data.reason.length === 0 ||
      data.reason !== data.reason.trim() ||
      data.reason !== data.reason.normalize("NFC") ||
      Buffer.byteLength(data.reason, "utf8") > 1_000 ||
      !amuxAnalysisTextSafe(data.reason)) return null;
  if (isPrepare) return data as AmuxUnitRejectRequest & { stage: "prepare" };
  if (typeof data.consumeRequestId !== "string" ||
      !UUID.test(data.consumeRequestId) ||
      data.consumeRequestId === data.prepareRequestId ||
      data.consumeRequestId === data.decisionId ||
      typeof data.confirmationDigest !== "string" ||
      !DIGEST.test(data.confirmationDigest)) return null;
  return data as AmuxUnitRejectRequest & { stage: "consume" };
}

/** Only the first, operator-idea chunk is handled by this dark writer. Later
 * source-plan revisions and hierarchy/card approvals need separate bindings. */
export function deriveAmuxUnitRejectConfirmation(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: AmuxUnitDecisionBinding;
  draftUnitId: string; localRef: string; unitBody: AmuxUnitDecisionBinding;
  proposal: AmuxAnalysisChunk["units"][number];
  previewId: string; previewPayload: AmuxUnitDecisionBinding;
  reason: AmuxUnitDecisionBinding;
}, key: AmuxDigestKey): AmuxIdeaUnitConfirmationResult {
  if (input.proposal.kind === "evidence" || input.proposal.localId !== input.localRef) {
    return { ok: false, code: "semantic_conflict" };
  }
  return deriveAmuxIdeaUnitConfirmation({
    schemaVersion: 1,
    policyVersion: "amux-intake-v11",
    canonicalizerVersion: "amux-canonical-v1",
    scannerVersion: AMUX_V4_INPUT_SCANNER_VERSION,
    ideaId: input.ideaId,
    decisionId: input.decisionId,
    prepareRequestId: input.prepareRequestId,
    actorUserId: input.actorUserId,
    ownerSession: { digest: input.ownerSession.digest,
      keyId: input.ownerSession.keyId },
    draftUnitId: input.draftUnitId,
    localRef: input.localRef,
    unitVersion: 1,
    unitKind: input.proposal.kind,
    unitBody: { digest: input.unitBody.digest, keyId: input.unitBody.keyId },
    draftShape: input.proposal.kind === "node"
      ? { kind: "node", level: input.proposal.level }
      : { kind: "card", cardType: input.proposal.cardType,
        storyKind: input.proposal.storyKind },
    action: "reject_unit",
    source: { previewId: input.previewId,
      payload: { digest: input.previewPayload.digest,
        keyId: input.previewPayload.keyId },
      scopeApprovalId: null, scope: null },
    hierarchy: [], nodeProposal: null, target: null, card: null,
    duplicates: null,
    decisionReason: { digest: input.reason.digest, keyId: input.reason.keyId },
  }, key, null, null);
}
