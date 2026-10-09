/**
 * Who may call the QA-release agent's internal routes, and whether the call
 * carries the current operator control revision.
 *
 * docs/policy/qa-release-agent.md sections 3 and 6: the Digest, Monitor and
 * Merge Lane services each hold their own secret, and every call carries the
 * revision number the operator set on all three services; the app refuses a
 * call whose number is not the latest recorded revision. Same rules as the
 * engineering agent's routes (lib/engineeringAgentRouteAuth.ts): a secret
 * shorter than 32 characters authenticates nothing, comparison is between
 * SHA-256 digests in constant time, and a secret shared with another role
 * authenticates neither -- otherwise one service could call another's routes.
 *
 * No database: the caller reads the latest revision and passes it in.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const QA_RELEASE_ROUTE_SECRET_ENV = Object.freeze({
  digest: "QA_RELEASE_DIGEST_SECRET",
  monitor: "QA_RELEASE_MONITOR_SECRET",
  mergeLane: "QA_RELEASE_MERGE_LANE_SECRET",
} as const);

export type QaReleaseRouteRole = keyof typeof QA_RELEASE_ROUTE_SECRET_ENV;

export const QA_RELEASE_CONTROL_REVISION_HEADER = "x-qa-release-control-revision";

const MIN_SECRET_LENGTH = 32;
const REVISION = /^[1-9][0-9]{0,8}$/;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export type QaReleaseRouteAdmission =
  | { ok: true; revision: number }
  | {
      ok: false;
      /** 401: no usable secret, or the wrong one. */
      reason:
        | "unauthorized"
        /** 409: the call names no revision, or not the latest one. */
        | "control_revision_mismatch"
        /** 503: the app has no revision recorded yet, or could not read it. */
        | "control_revision_unavailable";
    };

/** Whether `provided` is this role's secret, and that secret is usable. */
export function isQaReleaseRouteSecret(
  role: QaReleaseRouteRole,
  provided: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const own = env[QA_RELEASE_ROUTE_SECRET_ENV[role]] ?? "";
  if (own.length < MIN_SECRET_LENGTH || provided.length === 0) return false;
  for (const other of Object.keys(QA_RELEASE_ROUTE_SECRET_ENV) as QaReleaseRouteRole[]) {
    if (other === role) continue;
    const value = env[QA_RELEASE_ROUTE_SECRET_ENV[other]] ?? "";
    if (value.length > 0 && timingSafeEqual(digest(own), digest(value))) return false;
  }
  return timingSafeEqual(digest(own), digest(provided));
}

/**
 * The admission decision for one call. Authentication is decided first, so an
 * unauthenticated caller learns nothing about the revision.
 */
export function admitQaReleaseRouteCall(input: {
  role: QaReleaseRouteRole;
  authorization: string | null;
  revisionHeader: string | null;
  /** The latest recorded revision; null when none exists or the read failed. */
  latestRevision: number | null;
  env: Readonly<Record<string, string | undefined>>;
}): QaReleaseRouteAdmission {
  const authorization = input.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return { ok: false, reason: "unauthorized" };
  if (!isQaReleaseRouteSecret(input.role, authorization.slice("Bearer ".length), input.env)) {
    return { ok: false, reason: "unauthorized" };
  }
  if (input.latestRevision === null || !Number.isSafeInteger(input.latestRevision) || input.latestRevision < 1) {
    return { ok: false, reason: "control_revision_unavailable" };
  }
  const header = input.revisionHeader ?? "";
  if (!REVISION.test(header) || Number(header) !== input.latestRevision) {
    return { ok: false, reason: "control_revision_mismatch" };
  }
  return { ok: true, revision: input.latestRevision };
}
