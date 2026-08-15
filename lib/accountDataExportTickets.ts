import "server-only";

// The database side of the account-export download ticket. The rules live in
// lib/accountDataExportTicketCore.ts; this file is the part that needs Prisma.

import { createHmac } from "node:crypto";

import { getAnonymousClientKey } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import {
  EXPORT_AUDIT_RETENTION_MS,
  classifyExportTicketRefusal,
  exportTicketExpiryFrom,
  generateExportTicketToken,
  hashExportTicketToken,
  type ExportTicketRefusal,
} from "@/lib/accountDataExportTicketCore";

const secret = () => {
  const value = process.env.NEXTAUTH_SECRET;
  if (!value) {
    // Failing closed matters more here than anywhere else in the product: an
    // unkeyed digest would make the stored hash a lookup table away from a
    // working download link for somebody's entire account.
    throw new Error("NEXTAUTH_SECRET is required to issue account export tickets.");
  }
  return value;
};

const hashContext = (scope: string, value: string) =>
  createHmac("sha256", secret()).update(`account-data-export:${scope}:${value}`).digest("hex");

/**
 * Request context, hashed. The audit needs to answer "was this the same place
 * the account normally signs in from", which a hash answers, rather than "where
 * was this person", which it does not.
 */
const requestContext = (request: Request) => ({
  ipHash: hashContext("ip", getAnonymousClientKey(request)),
  userAgentHash: hashContext("ua", request.headers.get("user-agent") ?? ""),
});

export type IssuedExportTicket = {
  /** Returned to the caller once and never stored. */
  token: string;
  expiresAt: Date;
};

export const issueAccountDataExportTicket = async ({
  userId,
  request,
  now = new Date(),
}: {
  userId: string;
  request: Request;
  now?: Date;
}): Promise<IssuedExportTicket> => {
  const token = generateExportTicketToken();
  const context = requestContext(request);
  const expiresAt = exportTicketExpiryFrom(now);

  await prisma.accountDataExportRequest.create({
    data: {
      userId,
      tokenHash: hashExportTicketToken(token, secret()),
      status: "issued",
      expiresAt,
      issuedIpHash: context.ipHash,
      issuedUserAgentHash: context.userAgentHash,
    },
  });

  return { token, expiresAt };
};

export type RedeemedExportTicket =
  | { ok: true; ticketId: string }
  | { ok: false; reason: ExportTicketRefusal };

/**
 * Claims the ticket, once.
 *
 * The claim is a single conditional UPDATE rather than a read followed by a
 * write: two tabs opening the same link, or a retry racing the original, must
 * produce one download and one refusal, not two downloads. Postgres decides
 * that, not this process.
 *
 * The read beforehand exists only to name the refusal for the audit row. It is
 * never the gate -- a row that passes the read and loses the UPDATE is still
 * refused.
 */
export const redeemAccountDataExportTicket = async ({
  token,
  userId,
  request,
  now = new Date(),
}: {
  token: string;
  userId: string;
  request: Request;
  now?: Date;
}): Promise<RedeemedExportTicket> => {
  const tokenHash = hashExportTicketToken(token, secret());
  const context = requestContext(request);

  const existing = await prisma.accountDataExportRequest.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  const refusal = classifyExportTicketRefusal({ ticket: existing, userId, now });
  if (refusal) {
    // An unknown token has no row to annotate. Everything else does, and the
    // annotation is the point: a refused redemption is the signal that someone
    // is holding a link they should not have.
    if (existing) {
      await prisma.accountDataExportRequest.update({
        where: { id: existing.id },
        data: {
          // A ticket already spent keeps its "downloaded" status; the refusal
          // reason records the second attempt without erasing the first.
          status: existing.consumedAt ? undefined : "refused",
          refusalReason: refusal,
          consumedIpHash: context.ipHash,
          consumedUserAgentHash: context.userAgentHash,
        },
      });
    }
    return { ok: false, reason: refusal };
  }

  const claimed = await prisma.accountDataExportRequest.updateMany({
    where: { tokenHash, userId, consumedAt: null, expiresAt: { gt: now } },
    data: {
      status: "downloaded",
      consumedAt: now,
      consumedIpHash: context.ipHash,
      consumedUserAgentHash: context.userAgentHash,
    },
  });

  // Lost the race. The winner is serving the file; this caller gets nothing.
  if (claimed.count !== 1) return { ok: false, reason: "already_used" };

  return { ok: true, ticketId: existing!.id };
};

/**
 * What the download contained, recorded after the fact.
 *
 * Never the data. Counts and a byte length are enough for an operator to answer
 * "did this download carry an account's whole history or an empty envelope"
 * without the audit trail becoming a second copy of the thing being audited.
 */
export const recordAccountDataExportDelivery = async ({
  ticketId,
  exportSchemaVersion,
  includedDomainCount,
  filteredDomainCount,
  byteLength,
}: {
  ticketId: string;
  exportSchemaVersion: number;
  includedDomainCount: number;
  filteredDomainCount: number;
  byteLength: number;
}) => {
  await prisma.accountDataExportRequest.update({
    where: { id: ticketId },
    data: { exportSchemaVersion, includedDomainCount, filteredDomainCount, byteLength },
  });
};

/** How many rows the history endpoint returns. Ninety days is the retention. */
export const EXPORT_HISTORY_LIMIT = 50;

/**
 * The account's own view of its export history.
 *
 * The projection is the point. The token hash is the download credential and
 * the request-context hashes identify a device, so neither leaves this file --
 * the same allowlist reasoning as the export itself, applied to the table that
 * records the export.
 */
export const listAccountDataExportHistory = async (userId: string) =>
  prisma.accountDataExportRequest.findMany({
    where: { userId },
    select: {
      id: true,
      status: true,
      refusalReason: true,
      expiresAt: true,
      consumedAt: true,
      byteLength: true,
      includedDomainCount: true,
      filteredDomainCount: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: EXPORT_HISTORY_LIMIT,
  });

/**
 * Ninety days, not five minutes.
 *
 * The ticket stops working at its expiry; the row is what tells an account
 * owner their data was downloaded last month. Purging it with the ticket would
 * leave the audit trail covering only the last five minutes, which is the same
 * as having none.
 */
export const purgeExpiredAccountDataExportRequests = async (now = new Date()) => {
  const result = await prisma.accountDataExportRequest.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - EXPORT_AUDIT_RETENTION_MS) } },
  });
  return result.count;
};
