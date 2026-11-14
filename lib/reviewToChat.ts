import type { ComparisonReview, ReviewMode, ReviewSetup, Citation } from "../packages/chat-core/src/review";

export const REVIEW_CHAT_PARAM = "reviewDraft";
export const REVIEW_CHAT_LIMIT = 24_000;
export const REVIEW_CHAT_TTL = 5 * 60_000;
export type QuickReview = {
  id: string;
  reviewerModelId: string;
  responseMap: ComparisonReview["responseMap"];
  result: {
    commonConclusions: Array<{ text: string; citations: Citation[]; verified: boolean }>;
    importantDifferences: Array<{ text: string; citations: Citation[]; verified: boolean }>;
    modelKeyClaims: Array<{ responseId: "A" | "B" | "C"; claims: Array<{ claim: string; quote: string; verified: boolean }> }>;
    verificationNeeded: string[];
  };
};
export type ReviewChatSource = {
  conversationId: string;
  setup: ReviewSetup;
  scope?: string;
} & ({ kind: "review"; review: ComparisonReview; mode: ReviewMode; includeSynthesis: boolean; reviewer: "primary" | "secondary" }
  | { kind: "quick"; review: QuickReview });
export type ReviewChatSelection = { section: string; ordinal: number; itemId?: string };
export type ReviewChatCopy = Record<string, string>;

export const reviewInputKey = (setup: ReviewSetup) => JSON.stringify([
  setup.source?.question,
  [...(setup.source?.responses ?? [])].sort((a, b) => a.messageId.localeCompare(b.messageId)),
]);
const resultKey = (review: ComparisonReview | QuickReview) => JSON.stringify([review.id, review.reviewerModelId, review.result, review.responseMap]);

/** Read-only existing routes repeat ownership, lock and deletion checks. */
export async function revalidateReviewChatSource(source: ReviewChatSource, signal?: AbortSignal) {
  const root = `/api/conversations/${encodeURIComponent(source.conversationId)}`;
  if (source.kind === "quick") {
    const response = await fetch(`${root}/compare-summary?handoff=1`, { cache: "no-store", signal });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data.available === true && data.cached === true && data.source &&
      reviewInputKey(data) === reviewInputKey(source.setup) && data.storedSummary && resultKey(data.storedSummary) === resultKey(source.review));
  }
  const query = `?${new URLSearchParams({ reviewMode: source.mode, includeSynthesis: String(source.includeSynthesis) })}`;
  const response = await fetch(`${root}/comparison-reviews${query}`, { cache: "no-store", signal });
  if (!response.ok) return false;
  const setup = await response.json() as ReviewSetup;
  return Boolean(setup.available && setup.source && reviewInputKey(setup) === reviewInputKey(source.setup) &&
    setup.storedReview && setup.storedReview.persisted !== false &&
    !setup.storedReview.guest && resultKey(setup.storedReview) === resultKey(source.review));
}

/** A literal projection of one reviewer, never a semantic summary or a DOM scrape. */
export function formatReviewChat(source: ReviewChatSource, selection: ReviewChatSelection | undefined, request: string, copy: ReviewChatCopy) {
  const { review } = source;
  const question = source.setup.source?.question;
  if (!question || !review.id || review.responseMap.length < 2 ||
    review.responseMap.some(row => !source.setup.source?.responses.some(item => item.messageId === row.messageId)) ||
    (source.kind === "review" && (source.review.guest || source.review.persisted === false))) return null;
  const entry = source.kind === "review" ? source.review.result[source.reviewer] : null;
  if (source.kind === "review" && !entry) return null;
  const cite = (citations: Citation[]) => citations.map(c =>
    `${c.responseId} (${review.responseMap.find(row => row.responseId === c.responseId)?.modelName ?? c.responseId}): “${c.quote}” [${c.verified ? copy.matched : copy.unmatched}]`).join("\n");
  const blocks: Array<{ section: string; ordinal: number; text: string }> = [];
  const add = (section: string, ordinal: number, text: string) => blocks.push({ section, ordinal, text: `${copy[section] ?? section}: ${text}` });
  let cautions: string[];
  if (source.kind === "review" && entry) {
    const result = entry.result;
    for (const section of ["consensus", "contradictions"] as const) result[section].forEach((item, i) => add(section, i, `${item.text}\n${cite(item.citations)}`));
    result.differences.forEach((item, i) => add("differences", i, `${item.issue}\n${item.positions.map(p => `${p.responseId}: ${p.position}\n${cite([p])}`).join("\n")}`));
    result.missingPoints.forEach((item, i) => add("missingPoints", i, item));
    result.verificationNeeded.forEach((item, i) => add("verificationNeeded", i, item));
    result.modelAssessments.forEach((item, i) => add("models", i, `${item.responseId}\n${copy.strengths ?? "Strengths"}: ${item.strengths.join("\n")}\n${copy.cautions ?? "Cautions"}: ${item.cautions.join("\n")}`));
    if (result.synthesis) add("synthesis", 0, result.synthesis);
    cautions = [...result.verificationNeeded, ...result.limitations];
  } else if (source.kind === "quick") {
    for (const section of ["commonConclusions", "importantDifferences"] as const) source.review.result[section].forEach((item, i) => add(section, i, `${item.text}\n${cite(item.citations)}`));
    source.review.result.modelKeyClaims.forEach((item, i) => add("models", i, `${item.responseId}\n${item.claims.map(c => `${c.claim}\n${cite([{ ...c, responseId: item.responseId }])}`).join("\n")}`));
    source.review.result.verificationNeeded.forEach((item, i) => add("verificationNeeded", i, item));
    cautions = source.review.result.verificationNeeded;
  } else return null;
  if (selection && !blocks.some(b => b.section === selection.section && b.ordinal === selection.ordinal)) return null;
  const sourceUrl = `/review?conversation=${encodeURIComponent(source.conversationId)}`;
  const heading = [copy.reference, copy.quoteNote, `${copy.question}:\n${question}`, `${copy.sources}:\n${sourceUrl}\n${review.responseMap.map(row => `${row.responseId}: ${row.modelName} (${row.messageId})`).join("\n")}`,
    `${copy.reviewer}: ${entry?.reviewerModelId ?? review.reviewerModelId}${source.kind === "review" ? ` (${source.reviewer})` : " (Quick Summary)"}`,
    `${copy.limitations}:\n${cautions.join("\n") || copy.none}`, copy.external, copy.independent].join("\n\n");
  const ending = `\n\n${copy.request}:\n${request.trim()}`;
  const candidates = selection ? blocks.filter(b => b.section === selection.section && b.ordinal === selection.ordinal) : blocks;
  const included: string[] = [];
  let size = heading.length + ending.length + 150;
  if (size > REVIEW_CHAT_LIMIT) return null;
  for (const block of candidates) {
    if (size + block.text.length + 2 > REVIEW_CHAT_LIMIT) { if (selection) return null; continue; }
    included.push(block.text); size += block.text.length + 2;
  }
  if (candidates.length && !included.length) return null;
  const omitted = blocks.length - included.length;
  const omission = omitted ? copy.omitted.replace("{count}", String(omitted)) : "";
  const text = [heading, ...included, omission].filter(Boolean).join("\n\n") + ending;
  return text.length <= REVIEW_CHAT_LIMIT ? { text, omitted, sourceUrl } : null;
}

export type ReviewChatPacket = Readonly<{ id: string; identity: string; epoch: number; createdAt: number; text: string }>;
let owner: string | null = null;
let epoch = 0;
let pending: ReviewChatPacket | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const clearPending = () => { clearTimeout(expiryTimer); expiryTimer = undefined; pending = null; };
export function observeReviewChatIdentity(identity: string | null) {
  if (identity !== owner) { owner = identity; epoch++; clearPending(); }
  return epoch;
}
export function stageReviewChatPacket(identity: string, text: string, now = Date.now(), expectedEpoch = epoch) {
  if (owner !== identity || expectedEpoch !== epoch || !identity.startsWith("account:") || !text || text.length > REVIEW_CHAT_LIMIT) return null;
  clearPending();
  pending = Object.freeze({ id: crypto.randomUUID(), identity, epoch, createdAt: now, text });
  expiryTimer = setTimeout(clearPending, REVIEW_CHAT_TTL);
  if (typeof expiryTimer === "object") expiryTimer.unref();
  return pending;
}
export function peekReviewChatPacket(id: string, identity: string | null, now = Date.now()) {
  if (pending && now - pending.createdAt >= REVIEW_CHAT_TTL) clearPending();
  return pending?.id === id && identity === owner && pending.identity === identity && pending.epoch === epoch ? pending : null;
}
export function discardReviewChatPacket(id: string) { if (pending?.id === id) clearPending(); }
export function takeReviewChatPacket(id: string, identity: string) {
  const packet = peekReviewChatPacket(id, identity);
  if (packet) clearPending();
  return packet;
}
