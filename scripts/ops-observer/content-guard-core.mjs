// What an ops-observer notification may say, and the check that runs on every
// message immediately before it is sent.
//
// docs/policy/sre-ops.md §3 rule 1 and §4 are the contract: a notification is
// one fixed sentence and at most one Admin link built from a fixed origin, a
// fixed path and a server-issued item id. Nothing else -- no signal name, key,
// band, time, count, commit SHA or URL parameter -- may ride along, because a
// sent message cannot be recalled. The renderers below produce the only allowed
// shapes, and `checkNotification()` re-derives them from the parsed text so a
// renderer bug cannot widen what goes out.
//
// Pure and dependency-free: the runner calls it before the webhook and the
// tests call it with hostile strings.

/** The page sentence (policy §4). Changing it is a policy version bump. */
export const PAGE_SENTENCE = "Tomverse 운영 감시: 확인이 필요한 장애 신호가 있습니다.";

/** The digest notice sentence (policy §4). */
export const DIGEST_SENTENCE = "Tomverse 운영 감시: 오늘의 운영 요약이 준비됐습니다.";

/** The weekly channel check sentence (policy §4). It never carries a link. */
export const CHANNEL_CHECK_SENTENCE =
  "Tomverse 주간 page 채널 점검: 휴대폰 푸시로 받았다면 점검 check-in을 여세요.";

/** The only origin a link may point at. */
export const PRODUCTION_ORIGIN = "https://tomverse.app";

/** The only path a link may take, followed by the item id and nothing else. */
export const ADMIN_ITEM_PATH_PREFIX = "/admin/agents/sre-ops/items/";

export const NOTIFICATION_KINDS = ["page", "digest", "channel_check"];

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lowercase, hyphenated RFC 4122/9562 UUID and nothing else. */
export function isCanonicalItemId(value) {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

/** The Admin link for one stored item. Throws on anything but a canonical id. */
export function adminItemLink(itemId) {
  if (!isCanonicalItemId(itemId)) {
    throw new Error("ops_observer_item_id_not_canonical");
  }
  return `${PRODUCTION_ORIGIN}${ADMIN_ITEM_PATH_PREFIX}${itemId}`;
}

/**
 * A page message: the page sentence and its link, and the channel check
 * sentence appended when the same run also owes the weekly check.
 */
export function renderPageMessage({ itemId, withChannelCheck = false }) {
  const lines = [PAGE_SENTENCE, adminItemLink(itemId)];
  if (withChannelCheck) lines.push(CHANNEL_CHECK_SENTENCE);
  return lines.join("\n");
}

/** The channel check on its own, for a run that owes nothing else. */
export function renderChannelCheckMessage() {
  return CHANNEL_CHECK_SENTENCE;
}

/** The digest notice: the digest sentence and its link. */
export function renderDigestNotice({ itemId }) {
  return [DIGEST_SENTENCE, adminItemLink(itemId)].join("\n");
}

/**
 * Decide whether `text` is exactly one of the shapes `kind` may send.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is an enum,
 * never an echo of the text, so a refusal can be logged without carrying what
 * it refused.
 */
export function checkNotification(kind, text) {
  if (!NOTIFICATION_KINDS.includes(kind)) return refuse("unknown_kind");
  if (typeof text !== "string") return refuse("not_text");
  if (text.length === 0) return refuse("empty");
  if (text !== text.normalize("NFC")) return refuse("not_nfc");
  if (/\r/.test(text)) return refuse("carriage_return");

  const lines = text.split("\n");

  if (kind === "digest") {
    if (lines.length !== 2) return refuse("line_count");
    if (lines[0] !== DIGEST_SENTENCE) return refuse("sentence");
    return linkVerdict(lines[1]);
  }

  if (kind === "channel_check") {
    return lines.length === 1 && lines[0] === CHANNEL_CHECK_SENTENCE
      ? { ok: true }
      : refuse(lines.length === 1 ? "sentence" : "line_count");
  }

  // page: sentence + link, optionally followed by the channel check sentence.
  if (lines.length !== 2 && lines.length !== 3) return refuse("line_count");
  if (lines[0] !== PAGE_SENTENCE) return refuse("sentence");
  const link = linkVerdict(lines[1]);
  if (!link.ok) return link;
  if (lines.length === 3 && lines[2] !== CHANNEL_CHECK_SENTENCE) return refuse("trailing_line");
  return { ok: true };
}

function linkVerdict(line) {
  const prefix = `${PRODUCTION_ORIGIN}${ADMIN_ITEM_PATH_PREFIX}`;
  if (!line.startsWith(prefix)) return refuse("link_origin_or_path");
  const itemId = line.slice(prefix.length);
  return isCanonicalItemId(itemId) ? { ok: true } : refuse("link_item_id");
}

function refuse(reason) {
  return { ok: false, reason };
}
