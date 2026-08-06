// The rules governing an account-export download link, with no Prisma and no
// environment, so every one of them is testable directly.
//
// A unified export is the single highest-value object this product can produce
// about a person: their conversations, their memories, what they paid. The
// download therefore does not behave like the other exports. It is a two-step
// flow -- a step-up-authenticated request that issues a short-lived single-use
// ticket, then a redemption that streams the file once -- and every refusal is
// recorded.
//
// Why a ticket at all, when the redemption still requires the session:
//
//   A URL leaks in ways a session does not. It lands in shell history, in a
//   proxy's access log, in a Referer header, in a screenshot, in a message to
//   someone helping with a problem. Session-only protection means a URL that
//   works for as long as the session does. Single-use plus a five-minute expiry
//   means a leaked URL is almost always already spent, and the audit row shows
//   the second attempt.
//
// The token is returned exactly once, in the response body of the request that
// created it. Only its HMAC is stored, so a database copy does not yield a
// working download.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Long enough that guessing is not a strategy: 32 random bytes is 256 bits,
 * and the ticket is single-use and expires in minutes besides.
 */
export const EXPORT_TICKET_TOKEN_BYTES = 32;

/**
 * Five minutes. Long enough for a browser to follow the link it was just
 * given, short enough that a URL found later is dead.
 */
export const EXPORT_TICKET_TTL_MS = 5 * 60 * 1_000;

/**
 * Audit rows outlive the ticket by a long way -- they are the record of who
 * downloaded an account's data and when, which is only useful if it covers more
 * than the last five minutes.
 */
export const EXPORT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type ExportTicketStatus = "issued" | "downloaded" | "refused";

export type ExportTicketRefusal =
  | "unknown_token"
  | "wrong_user"
  | "expired"
  | "already_used";

export type ExportTicketRow = {
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export const generateExportTicketToken = () =>
  randomBytes(EXPORT_TICKET_TOKEN_BYTES).toString("base64url");

/**
 * HMAC rather than a bare SHA-256: the token is a credential, and keying the
 * digest means a leaked database cannot be attacked with a precomputed table.
 */
export const hashExportTicketToken = (token: string, secret: string) =>
  createHmac("sha256", secret).update(`account-data-export:${token}`).digest("hex");

/** Constant-time, so a comparison cannot be turned into an oracle. */
export const exportTicketHashMatches = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const exportTicketExpiryFrom = (now: Date) =>
  new Date(now.getTime() + EXPORT_TICKET_TTL_MS);

/**
 * Why a redemption is refused, for the audit row.
 *
 * The caller is told none of this. A signed-in user presenting a bad token
 * learns only that the link is no longer usable, because "expired" and
 * "belongs to someone else" are different answers and the difference is worth
 * something to whoever is asking. The audit row keeps the distinction, since
 * the account's owner and an operator reading it later both need it.
 */
export const classifyExportTicketRefusal = ({
  ticket,
  userId,
  now,
}: {
  ticket: ExportTicketRow | null;
  userId: string;
  now: Date;
}): ExportTicketRefusal | null => {
  if (!ticket) return "unknown_token";
  if (ticket.userId !== userId) return "wrong_user";
  if (ticket.consumedAt) return "already_used";
  if (ticket.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
};

/**
 * Headers the download must carry, kept here rather than inline so the tests
 * pin them and a future edit to the route cannot quietly drop one.
 *
 *   no-store       -- not merely no-cache. A shared proxy or a browser's
 *                     back-forward cache holding this file re-serves an
 *                     account's entire history to whoever is next at the
 *                     machine.
 *   no-referrer    -- the token is in the path, and any link the file's viewer
 *                     follows would otherwise leak it in the Referer.
 *   nosniff        -- the body is user-controlled text inside JSON; a browser
 *                     deciding for itself that it is HTML would be an XSS on
 *                     this origin.
 *   attachment     -- with a filename, so it is saved rather than rendered.
 */
export const exportDownloadHeaders = (filename: string) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Content-Disposition": `attachment; filename="${filename}"`,
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** `tomverse-account-data-2026-08-06.json`. No user identifier in the name. */
export const exportDownloadFilename = (now: Date) =>
  `tomverse-account-data-${now.toISOString().slice(0, 10)}.json`;
