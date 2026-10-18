import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Prisma } from "@prisma/client";

import { sealAmuxContent } from "@/lib/amux/ideaCrypto";
import { readAmuxSessionCheckoutReferenceInTx } from
  "@/lib/amux/ideaSessionCheckoutReferenceRead";

const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const input = { ideaId, reservationId: "dc86a25b-919f-4714-a3d8-45ef5a18b175",
  claimId: "bc86a25b-919f-4714-a3d8-45ef5a18b175", referenceOrdinal: 0 };
const a = "a".repeat(40);
const b = "b".repeat(40);
const keys = { masterKeyId: "synthetic", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest",
  digestKey: randomBytes(32) };
const stored = { version: 1, idea: "Add guarded read path.",
  repositories: ["owner/repo"],
  pullRequests: [{ repository: "owner/private", number: 37 }] };
const sealed = sealAmuxContent(Buffer.from(JSON.stringify(stored), "utf8"),
  "idea_raw", ideaId, keys);

function fixture() {
  const metadata = { systemActor: "amux-session-intake",
    actorScope: "session-submission-v1", policyVersion: 19,
    rawDigest: sealed.digest, rawDigestKeyId: sealed.digestKeyId,
    ideaBytes: Buffer.byteLength(stored.idea, "utf8"),
    repositoryCount: 1, pullRequestCount: 1,
    pinnedCommitShas: [a, b] };
  const audit = { id: "audit-1", action: "amux.idea.session_submitted",
    targetType: "AmuxIdeaSubmission", targetId: ideaId,
    entryHash: "synthetic-entry-hash", actorUserId: null, actorEmail: null,
    ipAddress: null, userAgent: null, metadata };
  const idea = { id: ideaId, submissionAuditLogId: audit.id,
    rawCiphertext: sealed.ciphertext, rawKeyId: sealed.keyId,
    rawKeyVersion: sealed.keyVersion, rawDigest: sealed.digest,
    rawDigestKeyId: sealed.digestKeyId };
  let clockReads = 0;
  const tx = { $queryRaw: async () => {
    clockReads += 1;
    return clockReads === 2 ? [{ now: new Date("2026-10-18T00:00:00Z") }] : [];
  }, amuxIdeaOperatingScopeSetting: { findFirst: async () => ({ id: "scope-1" }) },
  amuxIdeaSessionAnalysisReservation: { findFirst: async () => ({ idea }) },
  adminAuditLog: { findUnique: async () => audit } } as unknown as Prisma.TransactionClient;
  return { tx, metadata, idea };
}

test("a digest-verified sealed idea and the complete audit select one target", async () => {
  const { tx } = fixture();
  assert.deepEqual(await readAmuxSessionCheckoutReferenceInTx(tx, input,
    { referenceCount: 2, pinnedCommitSha: a }, keys), {
    referenceCount: 2, kind: "repository", repository: "owner/repo",
    pullRequestNumber: null, pinnedCommitSha: a,
  });
});

test("audit digest, reference split and sibling SHA divergence deny checkout", async () => {
  for (const mutate of [
    (metadata: Record<string, unknown>) => { metadata.rawDigest = "f".repeat(64); },
    (metadata: Record<string, unknown>) => { metadata.rawDigestKeyId = "other"; },
    (metadata: Record<string, unknown>) => { metadata.repositoryCount = 0;
      metadata.pullRequestCount = 2; },
    (metadata: Record<string, unknown>) => { metadata.ideaBytes = 1; },
    (metadata: Record<string, unknown>) => { metadata.pinnedCommitShas = [a, "bad-sha"]; },
  ]) {
    const { tx, metadata } = fixture();
    mutate(metadata);
    assert.equal(await readAmuxSessionCheckoutReferenceInTx(tx, input,
      { referenceCount: 2, pinnedCommitSha: a }, keys), null);
  }
});
