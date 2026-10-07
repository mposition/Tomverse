import "server-only";

import { z } from "zod";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { qaReleaseDigestSchema } from "@/lib/qaReleaseDigestSchemaCore";
import { QA_RELEASE_DIGEST_HARD_TIMEOUT_MS } from "@/lib/qaReleaseDigestServiceCore";
import { queueQaReleaseIntakeAttention } from "@/lib/qaReleaseMonitor";
import { readLatestQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import {
  QA_RELEASE_CONTROL_REVISION_HEADER,
  admitQaReleaseRouteCall,
  isQaReleaseRouteSecret,
} from "@/lib/qaReleaseRouteAuthCore";

/**
 * The digest submission (docs/policy/qa-release-agent.md sections 1, 4 and 6).
 *
 * Order: authenticate the Digest service's own secret, then the operator
 * control revision, then whether the newest revision has the digest enabled,
 * then the closed schema, then the single writer. Every answer is a fixed
 * code; nothing from the request body is echoed.
 *
 * One digest per UTC day: the idempotency key is derived from the digest's
 * own date, so a retried submission of the same bytes is a replay and a
 * different body for the same day is a conflict.
 */

/** Room for whitespace around a body the schema caps at 16 KiB compact. */
const BODY_MAX_BYTES = 64 * 1024;

export type QaReleaseDigestIntakeAnswer = { status: number; body: Record<string, unknown> };

const answer = (status: number, body: Record<string, unknown>): QaReleaseDigestIntakeAnswer => ({ status, body });

export async function receiveQaReleaseDigest(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<QaReleaseDigestIntakeAnswer> {
  // Unauthenticated callers are answered before anything is read: the
  // revision is not theirs to learn.
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!isQaReleaseRouteSecret("digest", bearer, env)) return answer(401, { error: "unauthorized" });

  let control: Awaited<ReturnType<typeof readLatestQaReleaseOperatorControl>>;
  try {
    control = await readLatestQaReleaseOperatorControl();
  } catch {
    control = null;
  }
  const admission = admitQaReleaseRouteCall({
    role: "digest",
    authorization,
    revisionHeader: request.headers.get(QA_RELEASE_CONTROL_REVISION_HEADER),
    latestRevision: control?.revision ?? null,
    env,
  });
  if (!admission.ok) {
    if (admission.reason === "unauthorized") return answer(401, { error: "unauthorized" });
    // Policy section 6: a call on another revision is refused and the operator
    // is told (section 7's needs-a-check alert, once per UTC day).
    if (admission.reason === "control_revision_mismatch") await queueQaReleaseIntakeAttention("control_revision_mismatch");
    return answer(admission.reason === "control_revision_unavailable" ? 503 : 409, { error: admission.reason });
  }
  if (!control?.digestEnabled) return answer(409, { error: "digest_disabled" });

  let digest: z.infer<typeof qaReleaseDigestSchema>;
  try {
    digest = await readLimitedJson(request, BODY_MAX_BYTES, qaReleaseDigestSchema);
  } catch (error) {
    if (error instanceof ApiSecurityError) return answer(error.status, { error: "invalid_digest" });
    throw error;
  }

  // The first check above answers early; this one decides. It runs inside
  // the write transaction after the audit chain lock, which the operator
  // control writer also takes first, so a revision recorded while the body
  // was still arriving is seen here and the digest is not stored under it.
  const admittedRevision = admission.revision;
  const result = await recordAgentDigestItem(
    {
      agentKey: "qa-release",
      kind: "daily_digest",
      schemaVersion: digest.schemaVersion,
      idempotencyKey: `qa-release:daily:${digest.digestDate}`,
      payload: digest,
    },
    undefined,
    async (tx) => {
      const newest = await readLatestQaReleaseOperatorControl(tx);
      if (newest?.revision !== admittedRevision) return "control_revision_mismatch";
      return newest.digestEnabled ? null : "digest_disabled";
    },
    // The transaction's last statement, after the row and its audit entry: a
    // run past its own hard deadline is not recorded as a success (policy
    // section 3). The database clock decides, and a late answer rolls both
    // writes back. Admission and this check keep the created path at the
    // policy's nine statements (AGENT_DIGEST_STORE_TIMEOUTS.statements).
    // The deadline comes from the service, so it is also bounded here: one
    // further away than the service's whole hard timeout from the database
    // clock cannot be the deadline of a run that is still going, and is
    // treated as passed (policy section 3).
    async (tx) => {
      const clock = await tx.$queryRaw<{ late: boolean }[]>`SELECT
        clock_timestamp() >= ${new Date(digest.runDeadline)}::timestamptz
        OR ${new Date(digest.runDeadline)}::timestamptz > clock_timestamp() + make_interval(secs => ${QA_RELEASE_DIGEST_HARD_TIMEOUT_MS / 1000})
        AS late`;
      return clock[0]?.late === false ? null : "run_deadline_passed";
    },
  );
  switch (result.status) {
    case "created":
      return answer(201, { status: "created", id: result.id, payloadSha256: result.payloadSha256 });
    case "replayed":
      return answer(200, { status: "replayed", id: result.id, payloadSha256: result.payloadSha256 });
    case "conflict":
      // Policy section 7: a submission conflict needs a check.
      await queueQaReleaseIntakeAttention("digest_conflict");
      return answer(409, { error: "digest_conflict" });
    case "refused":
      return answer(422, { error: result.reason });
    case "not_admitted":
      if (result.reason === "control_revision_mismatch") await queueQaReleaseIntakeAttention("control_revision_mismatch");
      return answer(409, { error: result.reason });
  }
}
