import { createHash, randomUUID } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import {
  inspectAmuxAnalysisChunk,
  type AmuxAnalysisChunkInspection,
  type AmuxPermittedTargetRef,
} from "./ideaAnalysisChunkCore.ts";
import { sealAmuxContent, type AmuxContentKeys, type SealedAmuxContent } from "./ideaCrypto.ts";

type InspectionInput = {
  raw: string;
  expectedPreviewId: string;
  expectedChunkIndex: number;
  expectedRevisionChunkIndex: number;
  previousContinuationKind: "input" | "output" | null;
  permittedSourceRefIds: readonly string[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
};

export type SealedAmuxDraftUnit = {
  id: string;
  unitIndex: number;
  localRef: string;
  unitKind: "node" | "card" | "evidence";
  body: SealedAmuxContent;
};

export type SealedAmuxAnalysisDraft = {
  chunkIndex: number;
  previewId: string;
  outcome: "propose" | "needs_information" | "reject";
  coverageStatus: "complete" | "more" | "needs_owner_input";
  continuationKind: "input" | "output" | null;
  freeform: SealedAmuxContent;
  units: SealedAmuxDraftUnit[];
};

/** Bind the encrypted freeform body to one idea and one preview attempt. */
export function amuxAnalysisFreeformSubjectId(ideaId: string, previewId: string): string {
  return createHash("sha256")
    .update("amux-v4-analysis-freeform\0", "utf8")
    .update(ideaId, "utf8")
    .update("\0", "utf8")
    .update(previewId, "utf8")
    .digest("hex");
}

/**
 * Turn one bounded, untrusted model response into independently encrypted
 * proposal bodies. This does not verify a source plan, cursor, lease, budget,
 * approval or DB state and grants no write, transfer or execution permission.
 * The future single writer must check those before persisting these envelopes.
 * In particular it must never store the whole parsed chunk as one draft body:
 * one unit's expiry must not retain another unit's content.
 */
export function sealAmuxAnalysisDraft(input: InspectionInput & {
  ideaId: string;
  keys: AmuxContentKeys;
  unitIds?: readonly string[];
}):
  | { ok: false; code: Extract<AmuxAnalysisChunkInspection, { ok: false }>["code"] | "idea_id_invalid" }
  | { ok: true; draft: SealedAmuxAnalysisDraft } {
  if (typeof input?.ideaId !== "string" ||
      !/^[A-Za-z0-9:_-]{1,100}$/.test(input.ideaId)) {
    return { ok: false, code: "idea_id_invalid" };
  }
  const inspected = inspectAmuxAnalysisChunk(input);
  if (!inspected.ok) return { ok: false, code: inspected.code };

  return sealInspectedAmuxAnalysisDraft({ ...input, inspected });
}

/** Seal the exact normalized object already admitted by the continuation
 * guard. Do not re-read a mutable model response or target-ref array after
 * range validation. The caller still has to bind DB source/preview proofs. */
export function sealInspectedAmuxAnalysisDraft(input: {
  ideaId: string; keys: AmuxContentKeys; unitIds?: readonly string[];
  inspected: Extract<AmuxAnalysisChunkInspection, { ok: true }>;
}):
  | { ok: false; code: "metadata_incomplete" | "idea_id_invalid" }
  | { ok: true; draft: SealedAmuxAnalysisDraft } {
  if (typeof input?.ideaId !== "string" ||
      !/^[A-Za-z0-9:_-]{1,100}$/.test(input.ideaId)) {
    return { ok: false, code: "idea_id_invalid" };
  }

  const { chunk } = input.inspected;
  if (input.unitIds && (input.unitIds.length !== chunk.units.length ||
      new Set(input.unitIds).size !== input.unitIds.length ||
      input.unitIds.some((id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))) {
    return { ok: false, code: "metadata_incomplete" };
  }
  const freeformBytes = Buffer.from(amuxCanonicalJson({
    schemaVersion: chunk.schemaVersion,
    previewId: chunk.previewId,
    chunkIndex: chunk.chunkIndex,
    outcome: chunk.outcome,
    coverageStatus: chunk.coverageStatus,
    continuationKind: chunk.continuationKind,
    ownerQuestion: chunk.ownerQuestion,
    coveredScope: chunk.coveredScope,
    remainingScope: chunk.remainingScope,
  }), "utf8");
  try {
    const freeform = sealAmuxContent(freeformBytes, "analysis_freeform",
      amuxAnalysisFreeformSubjectId(input.ideaId, chunk.previewId), input.keys);
    const units = chunk.units.map((unit, unitIndex): SealedAmuxDraftUnit => {
      const id = input.unitIds?.[unitIndex] ?? randomUUID();
      const bytes = Buffer.from(amuxCanonicalJson(unit), "utf8");
      try {
        return { id, unitIndex, localRef: unit.localId, unitKind: unit.kind,
          body: sealAmuxContent(bytes, "analysis_draft", id, input.keys) };
      } finally {
        bytes.fill(0);
      }
    });
    return { ok: true, draft: {
      chunkIndex: chunk.chunkIndex,
      previewId: chunk.previewId,
      outcome: chunk.outcome,
      coverageStatus: chunk.coverageStatus,
      continuationKind: chunk.continuationKind,
      freeform,
      units,
    } };
  } finally {
    freeformBytes.fill(0);
  }
}
