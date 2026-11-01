import "server-only";

import { zernioCall, type ZernioTransportPorts } from "@/lib/zernioStatusQuery";

/**
 * Zernio's comments on one post, for the comment monitor (policy 12.1).
 *
 * `GET /v1/inbox/comments/{postId}?accountId=...` -- read from the vendor's
 * generated client documentation, not from a call we have made: the field names
 * below are the ones that documentation lists (`message`, `created_time`,
 * `is_hidden`, `from`) and the parser accepts the spelling variants a generated
 * client tends to produce. The monitor is off until a person has done the legal
 * steps in 12.1, which is also when the first real response should be compared
 * with this reading.
 *
 * What this module will not do: keep an author. The author object is never read,
 * so no handle or id can leave this function. Comment bodies are returned to the
 * caller's memory and nowhere else; nothing here logs.
 */

export type ParsedZernioComment = { readonly text: string; readonly createdAt: Date | null };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const instant = (value: unknown): Date | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The comments in one response page, or null when the response is not a page of
 * comments at all. An empty list is an answer ("no comments"); a body that is
 * not a list is not, and the caller must not take it for one. Single items that
 * cannot be read are skipped, not guessed.
 */
export const parseZernioComments = (body: unknown): ParsedZernioComment[] | null =>
  readZernioCommentsPage(body)?.comments ?? null;

/** A page with the size it arrived at, before unreadable and hidden items were dropped. */
export const readZernioCommentsPage = (
  body: unknown,
): { comments: ParsedZernioComment[]; rawCount: number } | null => {
  const list = (body as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) return null;
  const comments: ParsedZernioComment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    // A comment the page owner already hid is not a new risk.
    if (record.is_hidden === true || record.isHidden === true) continue;
    const body = text(record.message) ?? text(record.text) ?? text(record.content);
    if (body === null) continue;
    comments.push({
      text: body,
      createdAt: instant(record.created_time ?? record.createdTime ?? record.createdAt),
    });
  }
  return { comments, rawCount: list.length };
};

export type ZernioCommentsResult =
  | {
      readonly kind: "ok";
      readonly comments: ParsedZernioComment[];
      /** True when more comments exist than were read: the caller must not call that a whole read. */
      readonly truncated: boolean;
    }
  | { readonly kind: "unavailable" };

const PAGE_SIZE = 50;
/** Pages followed per post and run. A thread longer than this is cut short, and says so. */
export const ZERNIO_COMMENTS_MAX_PAGES = 5;

/** `more` is null when the response does not say either way. */
const nextCursor = (body: unknown): { more: boolean | null; cursor: string | null } => {
  const pagination = (body as { pagination?: { hasMore?: unknown; cursor?: unknown } } | null)?.pagination;
  const cursor = typeof pagination?.cursor === "string" && pagination.cursor !== "" ? pagination.cursor : null;
  return {
    more: typeof pagination?.hasMore === "boolean" ? pagination.hasMore : null,
    cursor,
  };
};

/**
 * The comments of a post, page by page to the end of the thread. Stopping early
 * because of the page cap, or because a full page names no way to the next, is
 * reported as `truncated`: a read that left comments unread is not a whole read.
 * Nothing here assumes the vendor's order -- no page is skipped for looking old.
 */
export const zernioCommentsQuery = (ports: ZernioTransportPorts) => ({
  async fetchComments(externalPostId: string, externalAccountRef: string): Promise<ZernioCommentsResult> {
    const comments: ParsedZernioComment[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < ZERNIO_COMMENTS_MAX_PAGES; page += 1) {
      const result = await zernioCall(
        ports,
        `/v1/inbox/comments/${encodeURIComponent(externalPostId)}?accountId=${encodeURIComponent(externalAccountRef)}&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET" },
      );
      // A later page that fails keeps what was read: the comments already in hand
      // are still classified, and the read is reported as cut short.
      const page = result.kind === "response" && result.status === 200 ? readZernioCommentsPage(result.body) : null;
      if (page === null) {
        return comments.length > 0 ? { kind: "ok", comments, truncated: true } : { kind: "unavailable" };
      }
      comments.push(...page.comments);
      const next = nextCursor(result.body);
      // The end is something the response says (`hasMore: false`), or a page
      // shorter than asked for -- counted before hidden items were dropped. A full
      // page that says nothing is not known to be the end, and nothing guesses.
      if (next.more === false || (next.more === null && page.rawCount < PAGE_SIZE)) {
        return { kind: "ok", comments, truncated: false };
      }
      if (next.more === null || next.cursor === null) return { kind: "ok", comments, truncated: true };
      cursor = next.cursor;
    }
    return { kind: "ok", comments, truncated: true };
  },
});
