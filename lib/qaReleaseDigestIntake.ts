import "server-only";

import { z } from "zod";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { qaReleaseDigestSchema } from "@/lib/qaReleaseDigestSchemaCore";
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
    return admission.reason === "unauthorized"
      ? answer(401, { error: "unauthorized" })
      : answer(admission.reason === "control_revision_unavailable" ? 503 : 409, { error: admission.reason });
  }
  if (!control?.digestEnabled) return answer(409, { error: "digest_disabled" });

  let digest: z.infer<typeof qaReleaseDigestSchema>;
  try {
    digest = await readLimitedJson(request, BODY_MAX_BYTES, qaReleaseDigestSchema);
  } catch (error) {
    if (error instanceof ApiSecurityError) return answer(error.status, { error: "invalid_digest" });
    throw error;
  }

  const result = await recordAgentDigestItem({
    agentKey: "qa-release",
    kind: "daily_digest",
    schemaVersion: digest.schemaVersion,
    idempotencyKey: `qa-release:daily:${digest.digestDate}`,
    payload: digest,
  });
  switch (result.status) {
    case "created":
      return answer(201, { status: "created", id: result.id, payloadSha256: result.payloadSha256 });
    case "replayed":
      return answer(200, { status: "replayed", id: result.id, payloadSha256: result.payloadSha256 });
    case "conflict":
      return answer(409, { error: "digest_conflict" });
    case "refused":
      return answer(422, { error: result.reason });
  }
}
