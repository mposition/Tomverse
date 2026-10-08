import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { scanAmuxNodeDuplicates, type AmuxDuplicateNode } from
  "./ideaNodeDuplicateScanCore.ts";

const LIMIT = 1_000;
const select = { id: true, level: true, parentId: true, state: true,
  revision: true, archivedAt: true, titleCiphertext: true,
  descriptionCiphertext: true, contentKeyId: true, contentKeyVersion: true,
  contentDigest: true, contentDigestKeyId: true } as const;
type NodeScanRow = Prisma.AmuxPortfolioNodeGetPayload<{ select: typeof select }>;
const fingerprint = (value: Uint8Array | null) => value === null ? null :
  createHash("sha256").update(value).digest("hex");
const signature = (row: NodeScanRow) =>
  JSON.stringify({ id: row.id, level: row.level, parentId: row.parentId,
    state: row.state, revision: row.revision,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    titleCiphertext: fingerprint(row.titleCiphertext),
    descriptionCiphertext: fingerprint(row.descriptionCiphertext),
    contentKeyId: row.contentKeyId, contentKeyVersion: row.contentKeyVersion,
    contentDigest: row.contentDigest,
    contentDigestKeyId: row.contentDigestKeyId });

export class AmuxNodeDuplicateScanError extends Error {
  constructor(readonly code: "catalog_incomplete" | "integrity_unavailable" |
    "too_many_candidates" | "invalid_input") {
    super(code);
    this.name = "AmuxNodeDuplicateScanError";
  }
}

/** Load only approved v4 nodes. Per-node keys are fetched before the DB
 * transaction, then the complete catalog is compared in SERIALIZABLE. */
export async function loadAmuxNodeDuplicateScanner() {
  const rows = await prisma.amuxPortfolioNode.findMany({
    take: LIMIT + 1, orderBy: { id: "asc" }, select,
  });
  if (rows.length > LIMIT) throw new AmuxNodeDuplicateScanError("catalog_incomplete");
  const revisions = await prisma.amuxPortfolioNodeRevision.findMany({
    where: { nodeId: { in: rows.map((row) => row.id) } },
    select: { nodeId: true, revision: true, decisionId: true,
      contentDigest: true, contentDigestKeyId: true },
  });
  const current = rows.map((row) => {
    const revision = revisions.find((entry) =>
      entry.nodeId === row.id && entry.revision === row.revision);
    if (!revision || revision.contentDigest !== row.contentDigest ||
        revision.contentDigestKeyId !== row.contentDigestKeyId) {
      throw new AmuxNodeDuplicateScanError("integrity_unavailable");
    }
    return { row, revision };
  });
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({
    where: { id: { in: current.map((entry) => entry.revision.decisionId) } },
    select: { id: true, ideaId: true, action: true, state: true,
      resolvedNodeId: true },
  });
  const identities = current.flatMap(({ row, revision }) => {
    const decision = decisions.find((entry) => entry.id === revision.decisionId);
    if (!decision || decision.action !== "create_node" ||
        decision.state !== "consumed" || decision.resolvedNodeId !== row.id) {
      throw new AmuxNodeDuplicateScanError("integrity_unavailable");
    }
    return row.state === "archived" || row.archivedAt !== null ? [] :
      [{ ideaId: decision.ideaId, purpose: "node_content" as const,
        subjectId: row.id }];
  });
  const keys = await loadAmuxContentKeyRing(identities);
  const catalog: AmuxDuplicateNode[] = [];
  try {
    for (const { row } of current) {
      if (row.state === "archived" || row.archivedAt !== null) {
        catalog.push({ id: row.id,
          level: row.level as AmuxDuplicateNode["level"], title: "",
          parentId: row.parentId, revision: row.revision,
          content: { digest: row.contentDigest,
            keyId: row.contentDigestKeyId }, archived: true });
        continue;
      }
      if (!row.titleCiphertext || !row.descriptionCiphertext ||
          !row.contentKeyId || !row.contentKeyVersion ||
          !["initiative", "epic", "feature"].includes(row.level)) {
        throw new AmuxNodeDuplicateScanError("integrity_unavailable");
      }
      const envelope = { keyId: row.contentKeyId,
        keyVersion: row.contentKeyVersion };
      const title = openAmuxContent({ ...envelope,
        ciphertext: Buffer.from(row.titleCiphertext) },
      "node_content", row.id, keys);
      const description = openAmuxContent({ ...envelope,
        ciphertext: Buffer.from(row.descriptionCiphertext) },
      "node_content", row.id, keys);
      try {
        const body = Buffer.from(amuxCanonicalJson({ title: title.toString("utf8"),
          description: description.toString("utf8") }), "utf8");
        if (!verifyAmuxContentDigest(body, "node_content", row.id,
          row.contentDigest, row.contentDigestKeyId, keys)) {
          throw new AmuxNodeDuplicateScanError("integrity_unavailable");
        }
        catalog.push({ id: row.id,
          level: row.level as AmuxDuplicateNode["level"],
          title: title.toString("utf8"), parentId: row.parentId,
          revision: row.revision, content: { digest: row.contentDigest,
            keyId: row.contentDigestKeyId },
          archived: row.state === "archived" || row.archivedAt !== null });
      } finally { title.fill(0); description.fill(0); }
    }
  } catch (error) {
    if (error instanceof AmuxNodeDuplicateScanError) throw error;
    throw new AmuxNodeDuplicateScanError("integrity_unavailable");
  }
  const baseline = rows.map(signature);
  return async (tx: Prisma.TransactionClient, input: {
    unitId: string; title: string; level: AmuxDuplicateNode["level"];
    parentId: string | null;
  }) => {
    const fresh = await tx.amuxPortfolioNode.findMany({
      take: LIMIT + 1, orderBy: { id: "asc" }, select,
    });
    if (fresh.length !== rows.length || fresh.map(signature)
      .some((value, index) => value !== baseline[index])) {
      throw new AmuxNodeDuplicateScanError("catalog_incomplete");
    }
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const result = scanAmuxNodeDuplicates({ ...input, nodes: catalog,
      catalogComplete: true, checkedAt: clock[0]?.now ?? new Date(NaN),
      key: keys });
    if (!result.ok) throw new AmuxNodeDuplicateScanError(result.code);
    return result.scan;
  };
}
