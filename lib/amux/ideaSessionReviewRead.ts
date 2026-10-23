import "server-only";

import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { classifyAmuxSessionReviewAnswer, type AmuxSessionReview } from
  "./ideaSessionReviewCore.ts";

/** The answer stays readable for seven days after intake, or while an active
 * legal hold covers the idea; the retention worker's lag never extends it. */
async function ownerMayReadAnswer(actorUserId: string, ideaId: string,
  claimId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ allowed: boolean }>>`
    WITH clock AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "now")
    SELECT (r."bodyPurgedAt" IS NULL AND r."ciphertext" IS NOT NULL AND
      (i."submittedAt" + INTERVAL '7 days' > clock."now" OR
        EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
          WHERE h."ideaId" = i."id" AND h."releasedAt" IS NULL
            AND h."expiresAt" > clock."now"))) AS "allowed"
    FROM "AmuxIdeaSessionAnalysisResult" r
    JOIN "AmuxIdeaSubmission" i ON i."id" = r."ideaId"
    CROSS JOIN clock
    WHERE r."claimId" = ${claimId}::uuid AND r."ideaId" = ${ideaId}
      AND i."actorUserId" = ${actorUserId}
  `;
  return rows.length === 1 && rows[0].allowed === true;
}

/**
 * Owner-scoped Admin read of why a session idea's latest analysis answer made
 * no plan. Only an idea that is waiting for the owner after a session analysis
 * is read; null when there is none or its answer is past retention. Key
 * retrieval happens outside any DB transaction, as for the read manifest.
 */
export async function readAmuxSessionReviewForOwner(actorUserId: string,
  ideaId: string): Promise<AmuxSessionReview | null> {
  const result = await prisma.amuxIdeaSessionAnalysisResult.findFirst({
    where: { ideaId, idea: { actorUserId, submissionOrigin: "session",
      state: "awaiting_owner", cancelledAt: null } },
    orderBy: { createdAt: "desc" },
    select: { claimId: true, ciphertext: true, keyId: true, keyVersion: true,
      digest: true, digestKeyId: true },
  });
  if (!result || !await ownerMayReadAnswer(actorUserId, ideaId, result.claimId)) return null;
  if (!result.ciphertext || !result.keyId || !result.keyVersion) {
    throw new Error("session_review_integrity_unavailable");
  }
  const identity = { ideaId, purpose: "analysis_result" as const, subjectId: result.claimId };
  const keys = await loadAmuxContentUnitKeys(identity);
  const plain = openAmuxContent({ ciphertext: Buffer.from(result.ciphertext),
    keyId: result.keyId, keyVersion: result.keyVersion },
  "analysis_result", result.claimId, keys);
  try {
    if (!verifyAmuxContentDigest(plain, "analysis_result", result.claimId,
      result.digest, result.digestKeyId, keys)) {
      throw new Error("session_review_integrity_unavailable");
    }
    // Key retrieval and decryption can cross the deadline or a hold release.
    if (!await ownerMayReadAnswer(actorUserId, ideaId, result.claimId)) return null;
    return classifyAmuxSessionReviewAnswer(plain.toString("utf8"));
  } finally { plain.fill(0); }
}
