import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { amuxContentDigest, openAmuxContent, verifyAmuxContentDigest } from
  "./ideaCrypto.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { scanAmuxCardDuplicates, type AmuxDuplicateCard } from
  "./ideaCardDuplicateScanCore.ts";
import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";

const LIMIT = 1_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ciphertextFingerprint = (value: Uint8Array | null) => value === null ? null :
  createHash("sha256").update(value).digest("hex");

export class AmuxCardDuplicateScanError extends Error {
  constructor(readonly code: "invalid_input" | "catalog_incomplete" | "integrity_unavailable" |
    "unresolved_reference" | "too_many_candidates") {
    super(code);
    this.name = "AmuxCardDuplicateScanError";
  }
}

const select = { id: true, sourceSystem: true, sourceSnapshot: true,
  title: true, revision: true, cardType: true, storyKind: true,
  parentFeatureNodeId: true, archivedAt: true, status: true,
  v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true,
  v4TitleDigest: true, v4TitleDigestKeyId: true } as const;

/** Preload external card keys before the transaction. A changed/new card in
 * the subsequent SERIALIZABLE transaction refuses the scan instead of using
 * an incomplete key ring or a stale candidate set. */
export async function loadAmuxCardDuplicateScanner() {
  const rows = await prisma.amuxWorkItem.findMany({
    take: LIMIT + 1, orderBy: { id: "asc" }, select,
  });
  if (rows.length > LIMIT) throw new AmuxCardDuplicateScanError("catalog_incomplete");
  const identities = rows.filter((row) => row.sourceSystem === "admin-idea-v4" &&
      row.archivedAt === null && row.status !== "cancelled")
    .map((row) => {
      const snapshot = row.sourceSnapshot;
      const ideaId = snapshot && typeof snapshot === "object" &&
        !Array.isArray(snapshot) && "ideaId" in snapshot ? snapshot.ideaId : null;
      if (typeof ideaId !== "string" || !UUID.test(ideaId)) {
        throw new AmuxCardDuplicateScanError("integrity_unavailable");
      }
      return { ideaId, purpose: "card_title" as const, subjectId: row.id };
    });
  const keys = await loadAmuxContentKeyRing(identities);
  const catalog: AmuxDuplicateCard[] = [];
  try {
    for (const row of rows) {
      if (row.sourceSystem === "admin-idea-v4") {
        if (row.archivedAt !== null || row.status === "cancelled") {
          if (!row.v4TitleDigest || !row.v4TitleDigestKeyId) {
            throw new AmuxCardDuplicateScanError("integrity_unavailable");
          }
          catalog.push({ id: row.id, title: "", revision: row.revision,
            content: { digest: row.v4TitleDigest,
              keyId: row.v4TitleDigestKeyId },
            cardType: row.cardType as "story" | "task",
            storyKind: row.storyKind as "general" | "bug" | null,
            featureNodeId: row.parentFeatureNodeId, archived: true });
          continue;
        }
        if (!row.v4TitleCiphertext || !row.v4TitleKeyId ||
            !row.v4TitleKeyVersion || !row.v4TitleDigest ||
            !row.v4TitleDigestKeyId ||
            !["story", "task"].includes(row.cardType ?? "")) {
          throw new AmuxCardDuplicateScanError("integrity_unavailable");
        }
        const plaintext = openAmuxContent({
          ciphertext: Buffer.from(row.v4TitleCiphertext),
          keyId: row.v4TitleKeyId, keyVersion: row.v4TitleKeyVersion,
        }, "card_title", row.id, keys);
        try {
          if (!verifyAmuxContentDigest(plaintext, "card_title", row.id,
            row.v4TitleDigest, row.v4TitleDigestKeyId, keys)) {
            throw new AmuxCardDuplicateScanError("integrity_unavailable");
          }
          catalog.push({ id: row.id, title: plaintext.toString("utf8"),
            revision: row.revision, content: { digest: row.v4TitleDigest,
              keyId: row.v4TitleDigestKeyId },
            cardType: row.cardType as "story" | "task",
            storyKind: row.storyKind as "general" | "bug" | null,
            featureNodeId: row.parentFeatureNodeId,
            archived: row.archivedAt !== null || row.status === "cancelled" });
        } finally { plaintext.fill(0); }
      } else {
        const digest = amuxContentDigest(Buffer.from(row.title, "utf8"),
          "card_title", row.id, keys);
        catalog.push({ id: row.id, title: row.title,
          revision: row.revision, content: { digest: digest.digest,
            keyId: digest.digestKeyId }, cardType: null, storyKind: null,
          featureNodeId: null, archived: row.archivedAt !== null ||
            row.status === "cancelled" });
      }
    }
  } catch (error) {
    if (error instanceof AmuxCardDuplicateScanError) throw error;
    throw new AmuxCardDuplicateScanError("integrity_unavailable");
  }
  const signatures = rows.map((row) => JSON.stringify({ id: row.id,
    sourceSystem: row.sourceSystem, sourceSnapshot: row.sourceSnapshot,
    title: row.title, revision: row.revision, cardType: row.cardType,
    storyKind: row.storyKind, parentFeatureNodeId: row.parentFeatureNodeId,
    archivedAt: row.archivedAt?.toISOString() ?? null, status: row.status,
    titleDigest: row.v4TitleDigest, titleKeyId: row.v4TitleKeyId,
    titleKeyVersion: row.v4TitleKeyVersion,
    titleCiphertext: ciphertextFingerprint(row.v4TitleCiphertext) }));

  return async (tx: Prisma.TransactionClient, input: {
    unitId: string; proposal: AmuxAnalysisCard; featureNodeId: string;
  }) => {
    const fresh = await tx.amuxWorkItem.findMany({
      take: LIMIT + 1, orderBy: { id: "asc" }, select,
    });
    const freshSignatures = fresh.map((row) => JSON.stringify({ id: row.id,
      sourceSystem: row.sourceSystem, sourceSnapshot: row.sourceSnapshot,
      title: row.title, revision: row.revision, cardType: row.cardType,
      storyKind: row.storyKind, parentFeatureNodeId: row.parentFeatureNodeId,
      archivedAt: row.archivedAt?.toISOString() ?? null, status: row.status,
      titleDigest: row.v4TitleDigest, titleKeyId: row.v4TitleKeyId,
      titleKeyVersion: row.v4TitleKeyVersion,
      titleCiphertext: ciphertextFingerprint(row.v4TitleCiphertext) }));
    if (fresh.length > LIMIT || freshSignatures.length !== signatures.length ||
        freshSignatures.some((value, index) => value !== signatures[index])) {
      throw new AmuxCardDuplicateScanError("catalog_incomplete");
    }
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const result = scanAmuxCardDuplicates({ unitId: input.unitId,
      title: input.proposal.title, cardType: input.proposal.cardType,
      storyKind: input.proposal.storyKind,
      featureNodeId: input.featureNodeId,
      explicitRefs: input.proposal.duplicateCandidateRefs,
      cards: catalog, catalogComplete: true,
      checkedAt: clock[0]?.now ?? new Date(NaN), key: keys });
    if (!result.ok) throw new AmuxCardDuplicateScanError(result.code);
    return result.scan;
  };
}
