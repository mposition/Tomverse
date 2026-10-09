import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxIdeaDuplicateScan } from "./ideaUnitConfirmationCore.ts";

/** An exact-title and explicit-reference scanner. The caller must supply the
 * complete, freshly read card catalog; a truncated catalog is never a scan. */
export type AmuxDuplicateCard = {
  id: string;
  title: string;
  revision: number;
  content: { digest: string; keyId: string };
  cardType: "story" | "task" | null;
  storyKind: "general" | "bug" | null;
  featureNodeId: string | null;
  archived: boolean;
};

export type AmuxCardDuplicateScanResult =
  | { ok: true; scan: AmuxIdeaDuplicateScan }
  | { ok: false; code: "catalog_incomplete" | "unresolved_reference" |
    "too_many_candidates" | "invalid_input" };

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_CARDS = 1_000;
const normalize = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase("und");

export function scanAmuxCardDuplicates(input: {
  unitId: string;
  title: string;
  cardType: "story" | "task";
  storyKind: "general" | "bug" | null;
  featureNodeId: string;
  explicitRefs: readonly string[];
  cards: readonly AmuxDuplicateCard[];
  catalogComplete: boolean;
  checkedAt: Date;
  key: AmuxDigestKey;
}): AmuxCardDuplicateScanResult {
  if (!input || !ID.test(input.unitId) || !ID.test(input.featureNodeId) ||
      typeof input.title !== "string" || input.title.length < 1 ||
      input.title.length > 200 || !["story", "task"].includes(input.cardType) ||
      (input.cardType === "story" ? !["general", "bug"].includes(input.storyKind ?? "") :
        input.storyKind !== null) || !Array.isArray(input.explicitRefs) ||
      input.explicitRefs.some((ref) => !ID.test(ref)) ||
      new Set(input.explicitRefs).size !== input.explicitRefs.length ||
      !(input.checkedAt instanceof Date) || !Number.isFinite(input.checkedAt.getTime())) {
    return { ok: false, code: "invalid_input" };
  }
  if (!input.catalogComplete || !Array.isArray(input.cards) ||
      input.cards.length > MAX_CARDS) return { ok: false, code: "catalog_incomplete" };
  const ids = new Set<string>();
  for (const card of input.cards) {
    if (!ID.test(card.id) || ids.has(card.id) ||
        typeof card.title !== "string" || !Number.isSafeInteger(card.revision) ||
        card.revision < 0 || !DIGEST.test(card.content.digest) ||
        typeof card.content.keyId !== "string" || !card.content.keyId ||
        typeof card.archived !== "boolean") {
      return { ok: false, code: "catalog_incomplete" };
    }
    ids.add(card.id);
  }
  if (input.explicitRefs.some((ref) => !ids.has(ref))) {
    return { ok: false, code: "unresolved_reference" };
  }
  if (input.cards.some((card) => card.archived &&
      input.explicitRefs.includes(card.id))) {
    return { ok: false, code: "unresolved_reference" };
  }
  const desired = normalize(input.title);
  const explicit = new Set(input.explicitRefs);
  const candidates = input.cards.filter((card) => !card.archived &&
    (explicit.has(card.id) || (card.cardType === input.cardType &&
      card.storyKind === input.storyKind && normalize(card.title) === desired)))
    .map((card) => ({ id: card.id, kind: "card" as const,
      revision: card.revision, content: card.content }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (candidates.length > 64) return { ok: false, code: "too_many_candidates" };
  try {
    const query = amuxContentDigest(Buffer.from(amuxCanonicalJson({
      title: desired, cardType: input.cardType, storyKind: input.storyKind,
      featureNodeId: input.featureNodeId,
      explicitRefs: [...input.explicitRefs].sort(),
    }), "utf8"), "analysis_draft", input.unitId, input.key);
    const result = amuxContentDigest(Buffer.from(amuxCanonicalJson(candidates), "utf8"),
      "analysis_draft", input.unitId, input.key);
    return { ok: true, scan: { scanVersion: "card-title-reference-v1",
      checkedAtIso: input.checkedAt.toISOString(),
      query: { digest: query.digest, keyId: query.digestKeyId },
      result: { digest: result.digest, keyId: result.digestKeyId },
      complete: true, candidates } };
  } catch { return { ok: false, code: "invalid_input" }; }
}
