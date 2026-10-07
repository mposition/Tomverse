import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxIdeaDuplicateScan } from "./ideaUnitConfirmationCore.ts";

export type AmuxDuplicateNode = {
  id: string; level: "initiative" | "epic" | "feature";
  title: string; parentId: string | null; revision: number;
  content: { digest: string; keyId: string }; archived: boolean;
};

const REF = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const norm = (value: string) => value.normalize("NFC").trim().toLowerCase();

/** Complete, keyed exact-title node scan. Semantic overlap remains the
 * owner's decision; no model text can mark a candidate as resolved. */
export function scanAmuxNodeDuplicates(input: {
  unitId: string; title: string;
  level: AmuxDuplicateNode["level"]; parentId: string | null;
  nodes: readonly AmuxDuplicateNode[]; catalogComplete: boolean;
  checkedAt: Date; key: AmuxDigestKey;
}): { ok: true; scan: AmuxIdeaDuplicateScan } | { ok: false;
  code: "invalid_input" | "catalog_incomplete" | "too_many_candidates" } {
  if (!REF.test(input.unitId) || typeof input.title !== "string" ||
      input.title.length < 1 || input.title.length > 200 ||
      !["initiative", "epic", "feature"].includes(input.level) ||
      (input.parentId !== null && !REF.test(input.parentId)) ||
      !(input.checkedAt instanceof Date) ||
      !Number.isFinite(input.checkedAt.getTime())) {
    return { ok: false, code: "invalid_input" };
  }
  if (!input.catalogComplete || !Array.isArray(input.nodes) ||
      input.nodes.length > 1_000) {
    return { ok: false, code: "catalog_incomplete" };
  }
  const ids = new Set<string>();
  for (const node of input.nodes) {
    if (!REF.test(node.id) || ids.has(node.id) ||
        !["initiative", "epic", "feature"].includes(node.level) ||
        (node.parentId !== null && !REF.test(node.parentId)) ||
        typeof node.title !== "string" || !Number.isSafeInteger(node.revision) ||
        node.revision < 0 || !DIGEST.test(node.content.digest) ||
        !node.content.keyId || typeof node.archived !== "boolean") {
      return { ok: false, code: "catalog_incomplete" };
    }
    ids.add(node.id);
  }
  const title = norm(input.title);
  const candidates = input.nodes.filter((node) => !node.archived &&
    node.level === input.level && norm(node.title) === title)
    .map((node) => ({ id: node.id, kind: "node" as const,
      revision: node.revision, content: node.content }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (candidates.length > 64) return { ok: false, code: "too_many_candidates" };
  try {
    const query = amuxContentDigest(Buffer.from(amuxCanonicalJson({
      title, level: input.level, parentId: input.parentId,
    }), "utf8"), "analysis_draft", input.unitId, input.key);
    const result = amuxContentDigest(Buffer.from(amuxCanonicalJson(candidates),
      "utf8"), "analysis_draft", input.unitId, input.key);
    return { ok: true, scan: { scanVersion: "node-title-v1",
      checkedAtIso: input.checkedAt.toISOString(),
      query: { digest: query.digest, keyId: query.digestKeyId },
      result: { digest: result.digest, keyId: result.digestKeyId },
      complete: true, candidates } };
  } catch { return { ok: false, code: "invalid_input" }; }
}
