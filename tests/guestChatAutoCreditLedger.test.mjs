import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  systemAuditActionAllowed,
  SYSTEM_AUDIT_ACTORS,
} from "@/lib/adminAuditSystemActors";
import {
  classifyGuestAutoCreditClaim,
  guestAutoCreditRequestKeyCore,
} from "@/lib/guestChatAutoCreditClaim";
import {
  GuestAutoCreditLedgerError,
  guestAutoUsageBucketCount,
  isGuestAutoCreditLedgerError,
} from "@/lib/guestChatAutoCreditLedger";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read(
  "prisma/migrations/20261012040000_guest_chat_auto_credit_phase/migration.sql",
);
const ledger = read("lib/guestChatAutoCreditLedger.ts");
const security = read("lib/chatSecurity.ts");
const analytics = read("lib/adminUsageAnalytics.ts");

test("Guest Auto phase is additive and every historical row remains exact", () => {
  assert.match(schema, /phase\s+String\s+@default\("exact"\)/);
  assert.match(
    migration,
    /ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'exact'/,
  );
  assert.match(
    migration,
    /CHECK \("phase" IN \('exact', 'guest_auto_prehold'\)\)/,
  );
  assert.match(schema, /clientTurnId\s+String\?/);
  assert.match(schema, /@@unique\(\[subjectKey, clientTurnId\]\)/);
});

test("Guest Auto migration rejects missing JSON provenance under SQL three-valued logic", () => {
  for (const field of [
    "authorityId",
    "candidateDigest",
    "reachableCandidateDigest",
    "sourceCommitSha",
    "runtimeDeploymentId",
    "activationPairDigest",
    "configDigest",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `\\(\\(NEW\\.\\"reservationPayload\\" ->> '${field}'\\) ~ [^\\n]+\\) IS DISTINCT FROM TRUE`,
      ),
    );
  }
  assert.match(
    migration,
    /jsonb_typeof\(NEW\."reservationPayload" -> 'minuteEntries'\) IS DISTINCT FROM 'array'/,
  );
  assert.match(
    migration,
    /jsonb_typeof\(NEW\."reservationPayload" -> 'creditEntries'\) IS DISTINCT FROM 'array'/,
  );
  assert.match(
    migration,
    /jsonb_typeof\(new_entries\) IS DISTINCT FROM 'array'/,
  );
});

test("Guest Auto claim binds authority and logical turn independently", () => {
  const subject = `guest:${"a".repeat(64)}`;
  const otherSubject = `guest:${"b".repeat(64)}`;
  const authority = "00000000-0000-4000-8000-000000000001";
  const otherAuthority = "00000000-0000-4000-8000-000000000002";
  const turn = "00000000-0000-4000-8000-000000000003";
  const otherTurn = "00000000-0000-4000-8000-000000000004";
  const requestKey = guestAutoCreditRequestKeyCore(subject, authority);
  const existing = { id: "reservation-1", subjectKey: subject,
    clientTurnId: turn, idempotencyKey: requestKey,
    status: "guest_auto_preheld" };

  assert.equal(classifyGuestAutoCreditClaim({ subjectKey: subject,
    clientTurnId: turn, requestKey, byAuthority: existing,
    byTurn: existing }), "replay_preheld");
  assert.equal(classifyGuestAutoCreditClaim({ subjectKey: subject,
    clientTurnId: turn,
    requestKey: guestAutoCreditRequestKeyCore(subject, otherAuthority),
    byAuthority: null, byTurn: existing }), "conflict");
  assert.equal(classifyGuestAutoCreditClaim({ subjectKey: subject,
    clientTurnId: otherTurn, requestKey, byAuthority: existing,
    byTurn: null }), "conflict");
  assert.equal(classifyGuestAutoCreditClaim({ subjectKey: otherSubject,
    clientTurnId: turn,
    requestKey: guestAutoCreditRequestKeyCore(otherSubject, authority),
    byAuthority: null, byTurn: null }), "new");
  assert.equal(classifyGuestAutoCreditClaim({ subjectKey: subject,
    clientTurnId: turn, requestKey,
    byAuthority: { ...existing, status: "guest_auto_unknown" },
    byTurn: { ...existing, status: "guest_auto_unknown" } }),
  "replay_terminal");
});

test("Guest Auto narrows real BIGINT bucket counts and rejects coercion", () => {
  assert.equal(guestAutoUsageBucketCount(0n), 0);
  assert.equal(guestAutoUsageBucketCount(50n), 50);
  assert.equal(
    guestAutoUsageBucketCount(BigInt(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of [
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    "50",
    -1n,
    Number.NaN,
  ]) {
    assert.throws(
      () => guestAutoUsageBucketCount(value),
      (error) => error?.code === "integrity_unavailable",
    );
  }
});

test("Guest Auto ledger predicate accepts only the module error class", () => {
  assert.equal(
    isGuestAutoCreditLedgerError(
      new GuestAutoCreditLedgerError("transition_invalid"),
    ),
    true,
  );
  assert.equal(
    isGuestAutoCreditLedgerError({
      name: "GuestAutoCreditLedgerError",
      code: "transition_invalid",
    }),
    false,
  );
  assert.equal(isGuestAutoCreditLedgerError(new Error("transition_invalid")), false);
});

test("Guest Auto prehold is content-free, undispatched and one-way", () => {
  for (const required of [
    "guest_auto_preheld",
    "guest_auto_released",
    "guest_auto_unknown",
    "providerRequestId\" IS NULL",
    "reservedCostMicroUsd\" = 0",
    "NEW.\"phase\" <> 'exact'",
    "NEW.\"status\" <> 'reserved'",
    "cannot return to a prehold",
    "already terminal",
    "heldCredits}' IS DISTINCT FROM OLD.\"reservedCredits\"::TEXT",
    "exactCredits}' IS DISTINCT FROM NEW.\"reservedCredits\"::TEXT",
  ]) {
    assert.match(migration, new RegExp(required));
  }
  const payloadWriter = ledger.slice(
    ledger.indexOf("const payload: PreholdPayload"),
    ledger.indexOf("const created =", ledger.indexOf("const payload: PreholdPayload")),
  );
  assert.doesNotMatch(
    payloadWriter,
    /prompt|proposal|attachment|reachableCandidates|cookie/i,
  );
});

test("Guest Auto reserve reads both subject and IP windows inside the locked transaction", () => {
  const transaction = ledger.slice(
    ledger.indexOf("return prisma.$transaction", ledger.indexOf("reserveGuestAutoCreditPrehold")),
    ledger.indexOf("export async function convertGuestAutoCreditPrehold"),
  );
  assert.ok(transaction.indexOf("takeAuditChainLock") <
    transaction.indexOf("chat-lease:${input.access.subjectKey}"));
  assert.ok(transaction.indexOf("chat-lease:${input.access.subjectKey}") <
    transaction.indexOf("chat-lease:${input.access.ipKey}"));
  for (const period of ["day", "month", "guest-ip-day", "guest-ip-month"]) {
    assert.match(transaction, new RegExp(`readUsage\\([\\s\\S]*?"${period}"`));
  }
  assert.ok(transaction.indexOf("buildPrehold") <
    transaction.indexOf("holdChatUsageBucket"));
  assert.match(transaction, /minuteEntries\.length|minuteEntries/);
  assert.match(transaction, /creditEntries/);
  assert.match(transaction, /claim: "replay_preheld"/);
  assert.match(transaction, /claim: "new"/);
});

test("Guest Auto conversion reuses the hold and ordinary exact settlement", () => {
  assert.match(security, /if \(guestAutoPrehold\) continue;/);
  assert.match(security, /!claimedAdmissionSlot && !guestAutoPrehold/);
  assert.match(security, /phase: "exact"/);
  assert.match(security, /canonical\.guestAuto\?\.requestKey/);
  assert.match(security, /heldCredits: guestAutoPrehold\.heldCredits/);
  assert.match(security, /exactCredits: budget\.usageCredits/);
  assert.match(
    security,
    /status: "reserved",[\s\S]{0,120}?clientTurnId: null,[\s\S]{0,120}?expiresAt: \{ lte: now \}/,
  );
  assert.doesNotMatch(
    security.slice(
      security.indexOf("reconcileExpiredChatCreditReservations"),
    ),
    /guest_auto_preheld|guest_auto_unknown/,
  );
});

test("Guest Auto known release refunds credit but retains paid Refiner request throttle", () => {
  const release = ledger.slice(
    ledger.indexOf("export type GuestAutoCreditReleaseReason"),
    ledger.indexOf("export async function markGuestAutoCreditUnknown"),
  );
  assert.match(
    release,
    /authority_refused: "pre_paid_full"/,
  );
  assert.match(
    release,
    /refiner_confirmed_undispatched: "paid_refiner_financial_only"/,
  );
  assert.match(
    release,
    /router_refused_before_dispatch: "paid_refiner_financial_only"/,
  );
  assert.match(
    release,
    /releaseScope === "pre_paid_full"[\s\S]{0,100}?\.\.\.payload\.minuteEntries[\s\S]{0,100}?payload\.creditEntries/,
  );
  assert.match(
    release,
    /: payload\.creditEntries/,
  );
  assert.match(
    release,
    /requestThrottle:[\s\S]{0,100}?"released"[\s\S]{0,100}?"retained"/,
  );
});

test("Guest Auto system writer has a closed audit action surface", () => {
  assert.ok(SYSTEM_AUDIT_ACTORS.includes("guest-chat-auto-credit"));
  for (const action of [
    "guest_chat.auto_credit_preheld",
    "guest_chat.auto_credit_converted",
    "guest_chat.auto_credit_released",
    "guest_chat.auto_credit_unknown",
  ]) {
    assert.equal(
      systemAuditActionAllowed(
        "guest-chat-auto-credit",
        action,
        "ChatCreditReservation",
      ),
      true,
    );
    assert.equal(
      systemAuditActionAllowed("guest-chat-auto-credit", action, "User"),
      false,
    );
  }
  assert.equal(
    systemAuditActionAllowed(
      "guest-chat-auto-credit",
      "guest_chat.auto_credit_refunded",
      "ChatCreditReservation",
    ),
    false,
  );
});

test("Admin usage analytics count only exact reservations", () => {
  const reservationReads = analytics.match(
    /FROM "ChatCreditReservation"(?:\s+r)?[\s\S]{0,420}?(?=FROM |GROUP BY|\)\)|`;)/g,
  ) ?? [];
  assert.equal(reservationReads.length, 10);
  for (const query of reservationReads) {
    assert.match(query, /"phase"\s*=\s*'exact'/);
  }
});
