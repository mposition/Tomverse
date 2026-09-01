import "server-only";

/**
 * Issuing, rotating and revoking mobile sessions.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D5, D7, D8, D11, D14, D15 and section 4 option A, approved 2026-08-31.
 *
 * The decisions are not here. `lib/mobileRefreshRotationCore.ts` decides what a
 * presented refresh token means; this file performs whatever it decided, in one
 * transaction, and writes down what happened. Keeping the two apart is what
 * makes D5's order testable without a database and this file's atomicity
 * testable without reasoning about order.
 *
 * ## Three things that are easy to get wrong and are pinned here
 *
 * 1. **Reuse detection commits even though the answer is 401** (D8's commit
 *    contract). An implementation that threw, and rolled the revocation back
 *    with the response, would leave replay detection doing nothing at all.
 * 2. **Every refusal answers the same way.** Expired, forged, replayed, wrong
 *    secret -- one code, because the client's next action is the same in all
 *    four and telling them apart tells an attacker which one they hit. The real
 *    reason goes to the audit row.
 * 3. **Logout always answers 204.** Anything else turns the endpoint into an
 *    oracle for whether a token is real, and there is nothing a caller could do
 *    differently with the answer.
 *
 * Nothing in this file writes a token, a fragment of one, a digest, or a record
 * id into a log, an audit row or a response. D15's forbidden list is the reason
 * `MobileAuthEvent` has no column that could hold one.
 */

import type { Prisma } from "@prisma/client";

import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { mintMobileAccessToken } from "@/lib/mobileAccessToken";
import {
  MOBILE_AUTH_RATE_LIMITS,
  MOBILE_REFRESH_ABSOLUTE_SECONDS,
  MOBILE_REFRESH_IDLE_SECONDS,
  type MobileAuthEventName,
  type MobileDevicePlatform,
} from "@/lib/mobileAuthContract";
import {
  decideMobileRefresh,
  type MobileRefreshRecord,
} from "@/lib/mobileRefreshRotationCore";
import {
  mintMobileRefreshToken,
  mobileRefreshSecretMatches,
  parseMobileRefreshToken,
} from "@/lib/mobileRefreshToken";
import { invalidateMobileSessionSnapshots } from "@/lib/mobileSessionAuthorization";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

const IDLE_WINDOW_MS = MOBILE_REFRESH_IDLE_SECONDS * 1000;
const ABSOLUTE_WINDOW_MS = MOBILE_REFRESH_ABSOLUTE_SECONDS * 1000;

/** What a device gets back. The refresh token never leaves the native layer (D19). */
export type MobileSessionTokens = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  deviceId: string;
};

export type MobileRefusal = { ok: false; reason: string };

const refuse = (reason: string): MobileRefusal => ({ ok: false, reason });

/**
 * One audit row and one structured log line, from one call.
 *
 * Both, not either: the row is what an operator queries ninety days later, and
 * the log line is what an alert watches now. The row's `reason` is a short
 * machine token by constraint of the schema, and neither carries a credential.
 */
const record = async (
  event: MobileAuthEventName,
  details: {
    userId?: string | null;
    deviceId?: string | null;
    familyId?: string | null;
    reason?: string | null;
    outcome?: "success" | "denied" | "failure";
    tx?: Prisma.TransactionClient;
  }
) => {
  const client = details.tx ?? prisma;
  // The CHECK constraint refuses a row that names a device or a family without
  // naming the account, because such a row would outlive the cascade meant to
  // remove every identifier of a person. Dropping the narrower ids is the right
  // answer for an event with no resolvable account -- they identify nobody
  // useful without it anyway.
  const userId = details.userId ?? null;
  await client.mobileAuthEvent.create({
    data: {
      event,
      userId,
      deviceId: userId ? (details.deviceId ?? null) : null,
      familyId: userId ? (details.familyId ?? null) : null,
      reason: details.reason ?? null,
    },
  });
  logSecurityAuditEvent(event, {
    userId,
    resourceId: details.familyId ?? details.deviceId ?? null,
    outcome: details.outcome ?? "success",
    reason: details.reason ?? null,
  });
};

/**
 * A brand-new device, family and refresh token, in one transaction.
 *
 * Reinstalling is a new device (approved decision 15): nothing here looks for
 * an existing row to adopt, because a design that silently reattached would be
 * a design that reattached to the wrong account the day two people share a
 * restored backup.
 */
export const issueMobileSession = async (input: {
  request: Request;
  userId: string;
  deviceLabel: string;
  platform: MobileDevicePlatform;
  appVersion?: string | null;
  now?: Date;
}): Promise<{ ok: true; tokens: MobileSessionTokens }> => {
  await consumeApiRateLimit(
    input.request,
    input.userId,
    "mobile-exchange",
    MOBILE_AUTH_RATE_LIMITS.exchange
  );

  const now = input.now ?? new Date();
  const minted = mintMobileRefreshToken();

  const { deviceId, familyId } = await prisma.$transaction(async (tx) => {
    const device = await tx.mobileDevice.create({
      data: {
        userId: input.userId,
        label: input.deviceLabel,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        createdAt: now,
        lastSeenAt: now,
      },
      select: { id: true },
    });
    const family = await tx.mobileTokenFamily.create({
      data: {
        userId: input.userId,
        deviceId: device.id,
        createdAt: now,
        lastRotatedAt: now,
        absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_WINDOW_MS),
      },
      select: { id: true },
    });
    await tx.mobileRefreshRotation.create({
      data: {
        id: minted.recordId,
        familyId: family.id,
        secretDigest: minted.secretDigest,
        pepperKid: minted.pepperKid,
        createdAt: now,
        expiresAt: new Date(now.getTime() + IDLE_WINDOW_MS),
      },
    });
    await record("mobile_auth.exchanged", {
      userId: input.userId,
      deviceId: device.id,
      familyId: family.id,
      tx,
    });
    return { deviceId: device.id, familyId: family.id };
  });

  const access = mintMobileAccessToken({
    userId: input.userId,
    deviceId,
    familyId,
    now,
  });

  return {
    ok: true,
    tokens: {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: minted.token,
      deviceId,
    },
  };
};

type LoadedRotation = {
  record: MobileRefreshRecord;
  storedDigest: string;
  family: {
    familyId: string;
    deviceId: string;
    userId: string;
    createdAtMs: number;
    lastRotatedAtMs: number;
    absoluteExpiresAtMs: number;
    revokedAtMs: number | null;
    deviceRevokedAtMs: number | null;
    accountStatus: string;
  } | null;
};

const loadRotation = async (recordId: string): Promise<LoadedRotation | null> => {
  const row = await prisma.mobileRefreshRotation.findUnique({
    where: { id: recordId },
    select: {
      id: true,
      familyId: true,
      pepperKid: true,
      secretDigest: true,
      expiresAt: true,
      consumedAt: true,
      invalidatedAt: true,
      family: {
        select: {
          id: true,
          userId: true,
          deviceId: true,
          createdAt: true,
          lastRotatedAt: true,
          absoluteExpiresAt: true,
          revokedAt: true,
          device: { select: { revokedAt: true } },
          user: { select: { accountStatus: true } },
        },
      },
    },
  });
  if (!row) return null;

  return {
    record: {
      id: row.id,
      familyId: row.familyId,
      pepperKid: row.pepperKid,
      expiresAtMs: row.expiresAt.getTime(),
      consumedAtMs: row.consumedAt?.getTime() ?? null,
      invalidatedAtMs: row.invalidatedAt?.getTime() ?? null,
    },
    storedDigest: row.secretDigest,
    family: row.family
      ? {
          familyId: row.family.id,
          deviceId: row.family.deviceId,
          userId: row.family.userId,
          createdAtMs: row.family.createdAt.getTime(),
          lastRotatedAtMs: row.family.lastRotatedAt.getTime(),
          absoluteExpiresAtMs: row.family.absoluteExpiresAt.getTime(),
          revokedAtMs: row.family.revokedAt?.getTime() ?? null,
          deviceRevokedAtMs: row.family.device.revokedAt?.getTime() ?? null,
          accountStatus: row.family.user.accountStatus,
        }
      : null,
  };
};

/**
 * Destroys a family after a replay, and commits.
 *
 * Separated from the caller's error path on purpose. D8's commit contract says
 * the revocation must survive the 401 that accompanies it, and the way that
 * gets broken is by throwing from inside the transaction so the response and
 * the revocation roll back together.
 */
const revokeFamily = async (input: {
  familyId: string;
  userId: string;
  deviceId: string;
  reason: "logout" | "device_revoked" | "reuse_detected" | "account_deleted";
  event: MobileAuthEventName;
  now: Date;
}) => {
  await prisma.$transaction(async (tx) => {
    await tx.mobileTokenFamily.updateMany({
      where: { id: input.familyId, revokedAt: null },
      data: {
        revokedAt: input.now,
        revokedReason: input.reason,
        // The generation D12 reads on both sides of a lookup, so a revocation
        // that lands mid-query is detected rather than overwritten.
        epoch: { increment: 1 },
      },
    });
    await tx.mobileRefreshRotation.updateMany({
      where: { familyId: input.familyId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: input.now },
    });
    await record(input.event, {
      userId: input.userId,
      deviceId: input.deviceId,
      familyId: input.familyId,
      reason: input.reason,
      outcome: input.reason === "reuse_detected" ? "denied" : "success",
      tx,
    });
  });
  invalidateMobileSessionSnapshots(input.userId);
};

/**
 * One refresh, in D5's order.
 *
 * The decision is `decideMobileRefresh`'s; what happens here is the performing
 * of it. The conditional UPDATE in the rotate branch is D7 ⓑ: it repeats the
 * state test inside the transaction, so two requests racing on the same token
 * cannot both mint a successor -- the loser sees zero rows affected and is
 * refused. That is option A, strict single use, with no window and no
 * idempotency key.
 */
export const rotateMobileSession = async (input: {
  request: Request;
  refreshToken: string;
  now?: Date;
}): Promise<{ ok: true; tokens: MobileSessionTokens } | MobileRefusal> => {
  const now = input.now ?? new Date();
  const presented = parseMobileRefreshToken(input.refreshToken);
  if (!presented) {
    await record("mobile_auth.refresh_rejected", { reason: "malformed", outcome: "denied" });
    return refuse("malformed");
  }

  const loaded = await loadRotation(presented.recordId);
  const decision = decideMobileRefresh({
    record: loaded?.record ?? null,
    // A thunk, called by the decision at step 2 -- before any state is judged.
    // Passing a boolean would let this file compute it in the wrong order and
    // the decision would never know.
    secretMatches: (row) =>
      mobileRefreshSecretMatches({
        secret: presented.secret,
        storedDigest: loaded?.storedDigest ?? "",
        pepperKid: row.pepperKid,
      }),
    family: loaded?.family ?? null,
    nowMs: now.getTime(),
    idleWindowMs: IDLE_WINDOW_MS,
  });

  if (decision.kind === "reuse_detected") {
    const family = loaded?.family;
    if (family) {
      await revokeFamily({
        familyId: family.familyId,
        userId: family.userId,
        deviceId: family.deviceId,
        reason: "reuse_detected",
        event: "mobile_auth.reuse_detected",
        now,
      });
    }
    return refuse("reuse_detected");
  }

  if (decision.kind === "reject") {
    await record("mobile_auth.refresh_rejected", {
      userId: loaded?.family?.userId ?? null,
      deviceId: loaded?.family?.deviceId ?? null,
      familyId: loaded?.family?.familyId ?? null,
      reason: decision.reason,
      outcome: "denied",
    });
    return refuse(decision.reason);
  }

  const family = decision.family;
  // Keyed on the device, and only now that the secret has matched. Keying it on
  // the record id a caller supplied would let anyone who learned an id throttle
  // somebody else's phone.
  await consumeApiRateLimit(
    input.request,
    family.deviceId,
    "mobile-refresh",
    MOBILE_AUTH_RATE_LIMITS.refresh
  );

  const successor = mintMobileRefreshToken();
  const rotated = await prisma.$transaction(async (tx) => {
    // ⓐ lock the family, so two racing refreshes serialize here rather than
    // both reading an unconsumed row.
    await tx.$queryRaw`SELECT "id" FROM "MobileTokenFamily" WHERE "id" = ${family.familyId} FOR UPDATE`;

    // ⓑ the conditional UPDATE. Exactly one row, or this refresh did not
    // happen -- the state is re-tested here because the read above is not a
    // promise about now.
    const consumed = await tx.mobileRefreshRotation.updateMany({
      where: {
        id: decision.record.id,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now, supersededById: successor.recordId },
    });
    if (consumed.count !== 1) return null;

    // ⓒ the successor, under the *current* pepper generation, which is how a
    // retired pepper drains instead of being cut off.
    await tx.mobileRefreshRotation.create({
      data: {
        id: successor.recordId,
        familyId: family.familyId,
        secretDigest: successor.secretDigest,
        pepperKid: successor.pepperKid,
        createdAt: now,
        expiresAt: new Date(now.getTime() + IDLE_WINDOW_MS),
      },
    });

    // ⓓ the family's idle clock.
    await tx.mobileTokenFamily.update({
      where: { id: family.familyId },
      data: { lastRotatedAt: now },
    });
    await tx.mobileDevice.update({
      where: { id: family.deviceId },
      data: { lastSeenAt: now },
    });
    await record("mobile_auth.refreshed", {
      userId: family.userId,
      deviceId: family.deviceId,
      familyId: family.familyId,
      tx,
    });
    return true;
  });

  if (!rotated) {
    // The loser of a race. Not reuse: this token was legitimate and simply
    // arrived second, so the family stands and the client retries with the
    // successor its single-flight sibling received.
    await record("mobile_auth.refresh_rejected", {
      userId: family.userId,
      deviceId: family.deviceId,
      familyId: family.familyId,
      reason: "lost_rotation_race",
      outcome: "denied",
    });
    return refuse("lost_rotation_race");
  }

  const access = mintMobileAccessToken({
    userId: family.userId,
    deviceId: family.deviceId,
    familyId: family.familyId,
    now,
  });

  return {
    ok: true,
    tokens: {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: successor.token,
      deviceId: family.deviceId,
    },
  };
};

/**
 * Ends one session.
 *
 * Answers nothing to its caller, by design: the route replies 204 whatever
 * happened here, so the endpoint cannot be used to ask whether a token is real.
 * A wrong secret still revokes nothing -- D5's order applies here exactly as it
 * does to a refresh.
 */
export const logoutMobileSession = async (input: {
  request: Request;
  refreshToken: string;
  now?: Date;
}): Promise<void> => {
  const now = input.now ?? new Date();
  const presented = parseMobileRefreshToken(input.refreshToken);
  if (!presented) return;

  const loaded = await loadRotation(presented.recordId);
  const decision = decideMobileRefresh({
    record: loaded?.record ?? null,
    secretMatches: (row) =>
      mobileRefreshSecretMatches({
        secret: presented.secret,
        storedDigest: loaded?.storedDigest ?? "",
        pepperKid: row.pepperKid,
      }),
    family: loaded?.family ?? null,
    nowMs: now.getTime(),
    idleWindowMs: IDLE_WINDOW_MS,
  });

  const family = loaded?.family;
  if (!family) return;

  if (decision.kind === "reuse_detected") {
    // A replayed token presented at logout is still a replay. The family ends
    // either way; what differs is the reason recorded, and recording "logout"
    // for it would erase the only evidence that a copy exists.
    await revokeFamily({
      familyId: family.familyId,
      userId: family.userId,
      deviceId: family.deviceId,
      reason: "reuse_detected",
      event: "mobile_auth.reuse_detected",
      now,
    });
    return;
  }
  if (decision.kind === "reject") return;

  await consumeApiRateLimit(
    input.request,
    family.deviceId,
    "mobile-logout",
    MOBILE_AUTH_RATE_LIMITS.logout
  );
  await revokeFamily({
    familyId: family.familyId,
    userId: family.userId,
    deviceId: family.deviceId,
    reason: "logout",
    event: "mobile_auth.logged_out",
    now,
  });
};

/**
 * Ends every mobile session on the account.
 *
 * D11's widest row: a forced sign-out, a suspension, or a scheduled deletion
 * takes every family, every device's and the web session together. Called from
 * `revokeAllUserSessions`, and it has to be -- without it a global sign-out
 * would stop the *access* tokens (their `iat` predates the stamp) and leave the
 * refresh tokens working, so the next refresh would mint an access token
 * stamped after the sign-out and the session would quietly come back.
 *
 * The devices themselves are left standing. They are the person's list of their
 * own phones, and a forced sign-out is not a decision to forget which phones
 * they have; only a deletion is, and that removes them by cascade.
 */
export const revokeAllMobileSessions = async (input: {
  userId: string;
  reason: "logout" | "account_deleted";
  now?: Date;
}) => {
  const now = input.now ?? new Date();
  const families = await prisma.mobileTokenFamily.findMany({
    where: { userId: input.userId, revokedAt: null },
    select: { id: true },
  });
  if (families.length === 0) {
    invalidateMobileSessionSnapshots(input.userId);
    return { revokedFamilies: 0 };
  }

  const ids = families.map((family) => family.id);
  await prisma.$transaction(async (tx) => {
    await tx.mobileTokenFamily.updateMany({
      where: { id: { in: ids } },
      data: { revokedAt: now, revokedReason: input.reason, epoch: { increment: 1 } },
    });
    await tx.mobileRefreshRotation.updateMany({
      where: { familyId: { in: ids }, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await record("mobile_auth.family_revoked", {
      userId: input.userId,
      reason: input.reason,
      tx,
    });
  });
  invalidateMobileSessionSnapshots(input.userId);
  return { revokedFamilies: ids.length };
};

/**
 * The one mobile auth record that survives an account deletion, naming nobody.
 *
 * Approved decision 9 says deletion removes the rows and identifiers naming the
 * user, their devices and their families, and that only de-identified
 * aggregates may be kept. This is that aggregate: one row saying mobile
 * sessions were ended by a deletion, with no account, device or family on it.
 *
 * Written *inside* the deletion transaction and before the `User` row goes, so
 * that it either happens with the deletion or not at all. Written with a null
 * `userId` deliberately -- a row naming the account would be taken by the same
 * cascade a moment later, which would make the record exist for the length of
 * one transaction and then not at all.
 *
 * Skipped when the account had no mobile session. A row on every deletion would
 * be a counter of deletions rather than of mobile sessions ended, and an
 * operator reading it would draw the wrong number.
 */
export const recordMobileSessionsEndedByDeletion = async (
  tx: Prisma.TransactionClient,
  userId: string
) => {
  const families = await tx.mobileTokenFamily.count({ where: { userId } });
  if (families === 0) return { recorded: false as const };

  await tx.mobileAuthEvent.create({
    data: {
      event: "mobile_auth.revoked_on_account_deletion",
      reason: "account_deleted",
    },
  });
  logSecurityAuditEvent("mobile_auth.revoked_on_account_deletion", {
    // The account is being deleted; naming it in a log line that outlives the
    // row would undo the deletion in the one place nobody looks.
    userId: null,
    reason: "account_deleted",
  });
  return { recorded: true as const };
};

/** What the account's own device list shows (D16). */
export const listMobileDevices = async (userId: string) => {
  const devices = await prisma.mobileDevice.findMany({
    where: { userId, revokedAt: null },
    select: {
      // The list is a control surface, so it carries the handle the revoke call
      // needs. That is why the id is here and not in the data export, which is
      // a record rather than a way to act.
      id: true,
      label: true,
      platform: true,
      appVersion: true,
      createdAt: true,
      lastSeenAt: true,
    },
    orderBy: { lastSeenAt: "desc" },
  });
  // No IP, truncated or otherwise (approved decision 8), and no field the
  // device did not choose to send.
  return devices;
};

/**
 * Releases one device.
 *
 * Scoped by `userId` in the `where`, so another account's device is "not found"
 * rather than "refused" -- there is no branch that could report the difference,
 * which is the same discipline the attachment and artifact routes use.
 */
export const revokeMobileDevice = async (input: {
  userId: string;
  deviceId: string;
  now?: Date;
}): Promise<{ ok: true } | MobileRefusal> => {
  const now = input.now ?? new Date();
  const device = await prisma.mobileDevice.findFirst({
    where: { id: input.deviceId, userId: input.userId },
    select: { id: true, revokedAt: true },
  });
  if (!device) return refuse("not_found");

  await prisma.$transaction(async (tx) => {
    await tx.mobileDevice.updateMany({
      where: { id: device.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: "user_revoked" },
    });
    const families = await tx.mobileTokenFamily.findMany({
      where: { deviceId: device.id, revokedAt: null },
      select: { id: true },
    });
    await tx.mobileTokenFamily.updateMany({
      where: { deviceId: device.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: "device_revoked", epoch: { increment: 1 } },
    });
    await tx.mobileRefreshRotation.updateMany({
      where: {
        familyId: { in: families.map((family) => family.id) },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
    await record("mobile_auth.device_revoked", {
      userId: input.userId,
      deviceId: device.id,
      reason: "user_revoked",
      tx,
    });
  });
  // D11: this reaches the named device's families and nothing else. The other
  // devices keep working and so does the web session.
  invalidateMobileSessionSnapshots(input.userId);
  return { ok: true };
};
