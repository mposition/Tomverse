import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  DESKTOP_REMOTE_PASSKEY_LIMITS,
  type DesktopRemoteCommandRequest,
  type DesktopRemotePasskeyAssertion,
  type DesktopRemotePasskeyView,
} from "@/lib/desktopRemoteControlContract";
import { isAllowedRequestHost } from "@/lib/originProtection";
import { prisma } from "@/lib/prisma";
import { fromBase64url, toBase64url, verifyAssertion, verifyRegistration, WebAuthnError } from "@/lib/webauthnCore";

/**
 * Passkeys that confirm a remote approval (docs/ops/desktop-remote-control.md). The server keeps the public key and
 * checks a WebAuthn assertion over a single-use challenge that it bound to one command, so a signature made for one
 * answer cannot confirm another. It decides nothing on the PC: the PC still applies an answer only to the request on its
 * own screen.
 */

export class PasskeyRefused extends Error {
  constructor(readonly code: "RELYING_PARTY" | "LIMIT" | "NO_PASSKEY" | "CHALLENGE" | "INVALID" | "DUPLICATE" | "NOT_FOUND" | "CONFIRMATION_REQUIRED") {
    super("The passkey request was refused.");
  }
}

export type RelyingParty = { origin: string; rpId: string };

/**
 * The site the request came from, as WebAuthn needs it: the page's own origin, which must be one of this deployment's
 * hosts (https, or http on localhost outside production). A passkey is made for that host name and works nowhere else.
 */
export function passkeyRelyingParty(request: Request): RelyingParty | null {
  const header = request.headers.get("origin");
  if (!header) return null;
  let url: URL;
  try { url = new URL(header); } catch { return null; }
  if (url.origin !== header || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.protocol === "http:" && url.hostname !== "localhost") return null;
  if (!isAllowedRequestHost(url.host)) return null;
  return { origin: url.origin, rpId: url.hostname };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What a challenge for one command is bound to: the command's kind, PC, task, request, digest, decision and the digest of a follow-up's text. */
export function commandBinding(command: DesktopRemoteCommandRequest): string {
  return sha256([
    "tomverse-remote-passkey-command-v1", command.kind, command.deviceId, command.taskKey,
    command.kind === "approval" ? command.approvalId : "-", command.kind === "approval" ? command.digest : "-",
    command.kind === "approval" ? command.decision : "-", command.kind === "follow_up" ? sha256(command.text) : "-",
  ].join("\n"));
}

export const removalBinding = (passkeyId: string) => sha256(`tomverse-remote-passkey-remove-v1\n${passkeyId}`);
/** What an existing passkey confirms when the account adds another: that one registration challenge. */
export const enrollmentBinding = (challengeId: string) => sha256(`tomverse-remote-passkey-enroll-v1\n${challengeId}`);

type PasskeyRow = { id: string; credentialId: string; label: string; createdAt: Date; lastUsedAt: Date | null; rpId: string };

const view = (row: Pick<PasskeyRow, "id" | "label" | "createdAt" | "lastUsedAt">): DesktopRemotePasskeyView => ({
  id: row.id, label: row.label, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

export async function listPasskeys(userId: string): Promise<DesktopRemotePasskeyView[]> {
  const rows = await prisma.desktopRemotePasskey.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: DESKTOP_REMOTE_PASSKEY_LIMITS.perAccount });
  return rows.map(view);
}

export const countPasskeys = (userId: string) => prisma.desktopRemotePasskey.count({ where: { userId } });

/** Starts one challenge. Old ones of this account are removed first, and an account never holds more than a few. */
type ChallengePurpose = "register" | "enroll" | "command" | "remove";

async function startChallenge(userId: string, purpose: ChallengePurpose, bindingHash: string | null) {
  await prisma.$executeRaw`DELETE FROM "DesktopRemotePasskeyChallenge" WHERE "userId" = ${userId} AND "expiresAt" <= now()`;
  await prisma.$executeRaw`
    DELETE FROM "DesktopRemotePasskeyChallenge" WHERE "id" IN (
      SELECT "id" FROM "DesktopRemotePasskeyChallenge" WHERE "userId" = ${userId} ORDER BY "createdAt" DESC OFFSET 9
    )
  `;
  const id = randomUUID();
  const challenge = toBase64url(randomBytes(32));
  await prisma.$executeRaw`
    INSERT INTO "DesktopRemotePasskeyChallenge" ("id", "userId", "purpose", "challenge", "bindingHash", "createdAt", "expiresAt")
    VALUES (${id}, ${userId}, ${purpose}, ${challenge}, ${bindingHash}, now(),
      now() + (${DESKTOP_REMOTE_PASSKEY_LIMITS.challengeTtlMs}::integer * interval '1 millisecond'))
  `;
  return { id, challenge };
}

/** Takes the challenge once. Whatever the signature turns out to be, this challenge is gone. */
async function takeChallenge(userId: string, id: string, purpose: ChallengePurpose, bindingHash: string | null): Promise<string> {
  const taken = await prisma.$queryRaw<Array<{ challenge: string }>>`
    DELETE FROM "DesktopRemotePasskeyChallenge"
    WHERE "id" = ${id} AND "userId" = ${userId} AND "purpose" = ${purpose} AND "expiresAt" > now()
      AND "bindingHash" IS NOT DISTINCT FROM ${bindingHash}
    RETURNING "challenge"
  `;
  if (!taken[0]) throw new PasskeyRefused("CHALLENGE");
  return taken[0].challenge;
}

const userHandle = (userId: string) => toBase64url(createHash("sha256").update(`tomverse-remote-passkey-user\n${userId}`).digest());

/**
 * The WebAuthn options for registering a passkey (the browser passes `publicKey` to `navigator.credentials.create`).
 * An account that has a passkey already also gets `confirm`: options for one assertion with an existing passkey over
 * this registration, so a session on its own cannot add a passkey of its own to an account that is protected.
 */
export async function registrationOptions(session: Session, rp: RelyingParty) {
  const userId = session.user.id;
  if ((await countPasskeys(userId)) >= DESKTOP_REMOTE_PASSKEY_LIMITS.perAccount) throw new PasskeyRefused("LIMIT");
  const existing = await prisma.desktopRemotePasskey.findMany({ where: { userId }, select: { credentialId: true, rpId: true } });
  const { id, challenge } = await startChallenge(userId, "register", null);
  const confirm = existing.length ? await assertionOptions(userId, rp, "enroll", enrollmentBinding(id)) : undefined;
  return {
    challengeId: id,
    ...(confirm ? { confirm } : {}),
    publicKey: {
      rp: { id: rp.rpId, name: "Tomverse" },
      user: { id: userHandle(userId), name: session.user.email ?? "Tomverse account", displayName: session.user.name ?? session.user.email ?? "Tomverse account" },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      timeout: DESKTOP_REMOTE_PASSKEY_LIMITS.challengeTtlMs,
      attestation: "none",
      authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
      excludeCredentials: existing.filter((row) => row.rpId === rp.rpId).map((row) => ({ type: "public-key", id: row.credentialId })),
    },
  };
}

/** The WebAuthn options for confirming one command or one removal (`navigator.credentials.get`). */
export async function assertionOptions(userId: string, rp: RelyingParty, purpose: "enroll" | "command" | "remove", bindingHash: string) {
  const usable = await prisma.desktopRemotePasskey.findMany({ where: { userId, rpId: rp.rpId }, select: { credentialId: true } });
  if (!usable.length) throw new PasskeyRefused("NO_PASSKEY");
  const { id, challenge } = await startChallenge(userId, purpose, bindingHash);
  return {
    challengeId: id,
    publicKey: {
      rpId: rp.rpId, challenge, timeout: DESKTOP_REMOTE_PASSKEY_LIMITS.challengeTtlMs, userVerification: "required",
      allowCredentials: usable.map((row) => ({ type: "public-key", id: row.credentialId })),
    },
  };
}

/** Registers the passkey the browser just made, with the person's audit entry in the same transaction. */
export async function registerPasskey(input: {
  session: Session; request: Request; rp: RelyingParty; label: string;
  challengeId: string; credentialId: string; clientDataJSON: string; attestationObject: string;
  /** An existing passkey's assertion over this registration; required when the account has one. */
  passkey?: DesktopRemotePasskeyAssertion;
}): Promise<DesktopRemotePasskeyView> {
  const userId = input.session.user.id;
  const challenge = await takeChallenge(userId, input.challengeId, "register", null);
  let confirmedBy: string | null = null;
  if ((await countPasskeys(userId)) > 0) {
    if (!input.passkey) throw new PasskeyRefused("CONFIRMATION_REQUIRED");
    confirmedBy = (await confirmPasskey({ userId, rp: input.rp, purpose: "enroll", bindingHash: enrollmentBinding(input.challengeId), assertion: input.passkey })).passkeyId;
  }
  let credential;
  try {
    credential = verifyRegistration({
      clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject,
      expected: { challenge, origin: input.rp.origin, rpId: input.rp.rpId },
    });
    // The id the browser reported is the one the authenticator signed for.
    if (fromBase64url(input.credentialId, 1023).toString("base64url") !== credential.credentialId) throw new WebAuthnError("malformed");
  } catch (error) {
    if (error instanceof WebAuthnError) throw new PasskeyRefused("INVALID");
    throw error;
  }
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await takeAuditChainLock(tx);
    if ((await tx.desktopRemotePasskey.count({ where: { userId } })) >= DESKTOP_REMOTE_PASSKEY_LIMITS.perAccount) throw new PasskeyRefused("LIMIT");
    if (await tx.desktopRemotePasskey.findUnique({ where: { credentialId: credential.credentialId }, select: { id: true } })) throw new PasskeyRefused("DUPLICATE");
    const row = await tx.desktopRemotePasskey.create({
      data: {
        id: randomUUID(), userId, credentialId: credential.credentialId, publicKey: credential.publicKey, alg: credential.alg,
        signCount: BigInt(credential.signCount), rpId: input.rp.rpId, label: input.label.slice(0, DESKTOP_REMOTE_PASSKEY_LIMITS.label),
      },
    });
    await writeAdminAuditLog({
      tx, session: input.session, request: input.request, action: "desktop_remote.passkey_registered", targetType: "DesktopRemotePasskey",
      targetId: row.id, summary: "Registered a passkey that confirms remote approvals", metadata: { passkeyId: row.id, alg: credential.alg, confirmedBy },
    });
    return view(row);
  });
}

/**
 * Checks the person's assertion for one purpose and one binding. The challenge is taken first and is gone whatever
 * follows. Returns the passkey that signed. The counter moves only if it is still what was read (a race is a refusal).
 */
export async function confirmPasskey(input: {
  userId: string; rp: RelyingParty; purpose: "enroll" | "command" | "remove"; bindingHash: string; assertion: DesktopRemotePasskeyAssertion;
}): Promise<{ passkeyId: string }> {
  const challenge = await takeChallenge(input.userId, input.assertion.challengeId, input.purpose, input.bindingHash);
  const stored = await prisma.desktopRemotePasskey.findFirst({ where: { credentialId: input.assertion.credentialId, userId: input.userId } });
  if (!stored || stored.rpId !== input.rp.rpId) throw new PasskeyRefused("INVALID");
  let signCount: number;
  try {
    ({ signCount } = verifyAssertion({
      clientDataJSON: input.assertion.clientDataJSON, authenticatorData: input.assertion.authenticatorData, signature: input.assertion.signature,
      expected: { challenge, origin: input.rp.origin, rpId: input.rp.rpId },
      stored: { publicKey: stored.publicKey, alg: stored.alg, signCount: Number(stored.signCount) },
    }));
  } catch (error) {
    if (error instanceof WebAuthnError) throw new PasskeyRefused("INVALID");
    throw error;
  }
  const moved = await prisma.desktopRemotePasskey.updateMany({
    where: { id: stored.id, userId: input.userId, signCount: stored.signCount },
    data: { signCount: BigInt(signCount), lastUsedAt: new Date() },
  });
  if (moved.count !== 1) throw new PasskeyRefused("INVALID");
  return { passkeyId: stored.id };
}

/** Removes one of the account's passkeys, with the person's audit entry in the same transaction. */
export async function removePasskey(input: { session: Session; request: Request; passkeyId: string; confirmedBy: string }) {
  const userId = input.session.user.id;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await takeAuditChainLock(tx);
    const removed = await tx.desktopRemotePasskey.deleteMany({ where: { id: input.passkeyId, userId } });
    if (removed.count !== 1) throw new PasskeyRefused("NOT_FOUND");
    await writeAdminAuditLog({
      tx, session: input.session, request: input.request, action: "desktop_remote.passkey_removed", targetType: "DesktopRemotePasskey",
      targetId: input.passkeyId, summary: "Removed a passkey that confirms remote approvals",
      metadata: { passkeyId: input.passkeyId, confirmedBy: input.confirmedBy },
    });
  });
}

/** Maintenance: challenges past their two minutes. */
export async function purgeDesktopRemotePasskeyChallenges() {
  return prisma.$executeRaw`DELETE FROM "DesktopRemotePasskeyChallenge" WHERE "expiresAt" <= now()`;
}
