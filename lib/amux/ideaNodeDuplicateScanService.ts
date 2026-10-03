import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxAnalysisTextSafe } from "./ideaAnalysisChunkCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";
import { openAmuxNodeText } from "./ideaNodeContentCore.ts";
import type { AmuxIdeaDuplicateScan } from "./ideaUnitConfirmationCore.ts";

const SCAN_VERSION = "node_nfc_lower_title_v1";
const MAX_SCOPED_NODES = 10_000;
const MAX_CANDIDATES = 64;
const NODE_ID = /^[A-Za-z0-9_-]{8,80}$/;

export class AmuxNodeDuplicateScanError extends Error {
  constructor(readonly code: "invalid_query" | "incomplete" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxNodeDuplicateScanError";
  }
}

const keyed = (domain: string, value: unknown, keys: AmuxContentKeys) => ({
  digest: createHmac("sha256", keys.digestKey)
    .update(domain, "utf8").update("\0", "utf8")
    .update(keys.digestKeyId, "ascii").update("\0", "utf8")
    .update(amuxCanonicalJson(value), "utf8").digest("hex"),
  keyId: keys.digestKeyId,
});

const comparableTitle = (title: string) => title.normalize("NFC").toLowerCase();

/** Full NFC + Unicode lowercase title candidate scan within one hierarchy slot. The caller must
 * use this in both prepare and consume under SERIALIZABLE isolation; a bounded
 * or undecipherable corpus refuses confirmation instead of claiming completeness.
 * Similarity beyond this equality is not implied by `complete`. A node sealed
 * with an unavailable historical key also fails closed until rotation support
 * is implemented before live registration. */
export async function scanAmuxNodeDuplicates(tx: Prisma.TransactionClient,
  input: { level: "initiative" | "epic" | "feature";
    parentId: string | null; title: string },
  keys: AmuxContentKeys): Promise<AmuxIdeaDuplicateScan> {
  const validParent = input.parentId === null || NODE_ID.test(input.parentId);
  if (!validParent || !["initiative", "epic", "feature"].includes(input.level) ||
      (input.level === "initiative") !== (input.parentId === null) ||
      typeof input.title !== "string" || input.title.length === 0 ||
      input.title !== input.title.trim() ||
      input.title !== input.title.normalize("NFC") ||
      /[\t\n]/u.test(input.title) || !amuxAnalysisTextSafe(input.title) ||
      Buffer.byteLength(input.title, "utf8") > 200) {
    throw new AmuxNodeDuplicateScanError("invalid_query");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date; isolation: string }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now",
           current_setting('transaction_isolation') AS "isolation"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      clock[0]?.isolation !== "serializable") {
    throw new AmuxNodeDuplicateScanError("integrity_unavailable");
  }
  const rows = await tx.amuxPortfolioNode.findMany({
    where: { level: input.level, parentId: input.parentId, state: "active" },
    orderBy: { id: "asc" }, take: MAX_SCOPED_NODES + 1,
    select: { id: true, revision: true, titleCiphertext: true,
      descriptionCiphertext: true, contentKeyId: true, contentKeyVersion: true,
      contentDigest: true, contentDigestKeyId: true },
  });
  if (rows.length > MAX_SCOPED_NODES) throw new AmuxNodeDuplicateScanError("incomplete");
  const expected = comparableTitle(input.title);
  const candidates: AmuxIdeaDuplicateScan["candidates"] = [];
  for (const row of rows) {
    if (!NODE_ID.test(row.id) || !Number.isSafeInteger(row.revision) ||
        row.revision < 0) throw new AmuxNodeDuplicateScanError("integrity_unavailable");
    let title: string;
    try { title = openAmuxNodeText(row.id, row, keys).title; }
    catch { throw new AmuxNodeDuplicateScanError("integrity_unavailable"); }
    if (comparableTitle(title) !== expected) continue;
    candidates.push({ id: row.id, kind: "node", revision: row.revision,
      content: { digest: row.contentDigest, keyId: row.contentDigestKeyId } });
    if (candidates.length > MAX_CANDIDATES) {
      throw new AmuxNodeDuplicateScanError("incomplete");
    }
  }
  // PostgreSQL's collation is not necessarily the JS order required by the
  // confirmation contract; always canonicalize candidate order here.
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const query = keyed("amux-v4-node-dedupe-query-v1",
    { level: input.level, parentId: input.parentId, title: expected }, keys);
  const result = keyed("amux-v4-node-dedupe-result-v1", candidates, keys);
  return { scanVersion: SCAN_VERSION, checkedAtIso: now.toISOString(),
    query, result, complete: true, candidates };
}
