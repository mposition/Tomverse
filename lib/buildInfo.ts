import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEPLOYMENT_ENVIRONMENTS,
  resolveDeploymentEnvironment,
  validateEnvironment,
  type DeploymentEnvironment,
} from "@/lib/deploymentEnvironment";

// Single source of truth for "what is actually running right now" (STG-F010,
// extended by AUD-R002). commitSha/environment/deploymentId are read live
// from process.env at call time, matching the existing
// sentry.server.config.ts / sentry.edge.config.ts precedent
// (`process.env.RAILWAY_GIT_COMMIT_SHA`) and Next.js's own documented
// "runtime environment variables" pattern -- these values are fixed for the
// lifetime of a Railway deployment, so reading them per-call is not the same
// as recomputing them; it never changes without a new deploy. builtAt is
// the one value Railway does not expose anywhere, so it is captured once at
// build time by scripts/generate-build-info.mjs and read here from its
// output file -- never computed at request time.
//
// deploymentStartedAt/deployedAt/deploymentStatus (AUD-R002) come from a
// single Railway GraphQL lookup of the *current* deployment
// (RAILWAY_DEPLOYMENT_ID), using the same backboard.railway.com/graphql/v2
// endpoint and RAILWAY_API_TOKEN already used by lib/infrastructureMonitoring.ts.
// The result is cached for the lifetime of this process (a new deployment is
// always a new process, so the cache is effectively "one lookup per
// deployment" -- the permanent, deployment-scoped cache this feature calls
// for) and never re-fetched per request. A failed lookup backs off for
// FAILED_LOOKUP_COOLDOWN_MS and returns nulls rather than a stale guess or a
// 500 -- this is a diagnostics affordance, never load-bearing.

// The same list, resolved the same way, as every other caller that needs to
// know which deployment this is. Kept as aliases rather than a second copy:
// two definitions of "which environment am I" drift, and the one that drifted
// last time gave staging production's Stripe rule.
export const BUILD_ENVIRONMENTS = DEPLOYMENT_ENVIRONMENTS;

export type BuildEnvironment = DeploymentEnvironment;

export { validateEnvironment };

export type DeploymentStatus = "success" | "in_progress" | "failed" | "unknown";

export type PublicBuildInfo = {
  environment: BuildEnvironment;
  commitSha: string | null;
  shortCommitSha: string | null;
  builtAt: string | null;
  deploymentId: string | null;
  // Railway's precise deployment-start timestamp (Path B) -- always filled
  // in whenever the deployment lookup itself succeeds, regardless of
  // whether the deployment has also reached a terminal SUCCESS yet.
  deploymentStartedAt: string | null;
  // Only ever filled once Railway reports this exact deployment ID as
  // terminal SUCCESS (Path A). Never derived from builtAt, process start
  // time, or request time -- see resolveDeploymentTimeline below.
  deployedAt: string | null;
  deploymentStatus: DeploymentStatus;
};

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const SHORT_SHA_LENGTH = 7;
const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const RAILWAY_API_TIMEOUT_MS = 5_000;
const FAILED_LOOKUP_COOLDOWN_MS = 30_000;
// Reject a deployment timestamp that predates this feature existing by a
// wide margin, or that lands in the future beyond ordinary clock skew --
// either signals a corrupted/garbage value, never a real deploy time.
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_DEPLOYMENT_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

type GeneratedBuildInfo = {
  buildTimestamp?: unknown;
  gitCommitShaFallback?: unknown;
};

const readGeneratedBuildInfo = (): GeneratedBuildInfo => {
  try {
    const raw = readFileSync(
      join(process.cwd(), "lib", "generated", "build-info.generated.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing in a fresh checkout before the first `npm run build`/`dev` --
    // every public field just falls back to null/unknown, never a crash.
    return {};
  }
};

export function validateCommitSha(value: unknown): string | null {
  return typeof value === "string" && SHA_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

export function formatShortCommitSha(sha: string | null): string | null {
  return sha ? sha.slice(0, SHORT_SHA_LENGTH) : null;
}

export function validateIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Stricter than validateIsoTimestamp: also rejects future timestamps (beyond
// ordinary clock skew) and implausibly old ones, since a real Railway
// deployment timestamp can never be either.
export function validateDeploymentTimestamp(
  value: unknown,
  now: number = Date.now()
): string | null {
  const iso = validateIsoTimestamp(value);
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (time > now + MAX_CLOCK_SKEW_MS) return null;
  if (now - time > MAX_DEPLOYMENT_AGE_MS) return null;
  return iso;
}

export function mapRailwayDeploymentStatus(status: unknown): DeploymentStatus {
  if (typeof status !== "string") return "unknown";
  switch (status.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
      return "in_progress";
    case "FAILED":
    case "CRASHED":
    case "REMOVED":
    case "SKIPPED":
    case "NEEDS_APPROVAL":
      return "failed";
    default:
      return "unknown";
  }
}

const resolveEnvironment = (): BuildEnvironment =>
  resolveDeploymentEnvironment();

type DeploymentTimeline = {
  deploymentStartedAt: string | null;
  deployedAt: string | null;
  deploymentStatus: DeploymentStatus;
};

const UNKNOWN_TIMELINE: DeploymentTimeline = {
  deploymentStartedAt: null,
  deployedAt: null,
  deploymentStatus: "unknown",
};

export type FetchLike = typeof fetch;

// Module-level cache: resolved once per deployment ID and never re-fetched
// for the rest of this process's lifetime (a new deployment is always a new
// process). A failed lookup is cached only briefly, so a transient Railway
// API outage doesn't get hammered on every request but does self-heal.
let cachedForDeploymentId: string | null = null;
let cachedTimeline: DeploymentTimeline | null = null;
let lastFailureAt = 0;

// Exposed for tests only, so each test starts from a clean cache.
export function resetDeploymentTimelineCacheForTests(): void {
  cachedForDeploymentId = null;
  cachedTimeline = null;
  lastFailureAt = 0;
}

async function resolveDeploymentTimeline(
  deploymentId: string | null,
  commitSha: string | null,
  fetchImpl: FetchLike = fetch
): Promise<DeploymentTimeline> {
  if (!deploymentId) return UNKNOWN_TIMELINE;

  if (cachedForDeploymentId === deploymentId && cachedTimeline) {
    return cachedTimeline;
  }
  // A new deployment ID invalidates any cached result from a previous one.
  if (cachedForDeploymentId !== deploymentId) {
    cachedForDeploymentId = null;
    cachedTimeline = null;
  }

  const token = process.env.RAILWAY_API_TOKEN?.trim();
  if (!token) return UNKNOWN_TIMELINE;

  if (lastFailureAt && Date.now() - lastFailureAt < FAILED_LOOKUP_COOLDOWN_MS) {
    return UNKNOWN_TIMELINE;
  }

  try {
    const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(RAILWAY_API_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query TomverseCurrentDeployment($id: String!) {
            deployment(id: $id) {
              id
              status
              createdAt
              statusUpdatedAt
              meta
            }
          }
        `,
        variables: { id: deploymentId },
      }),
    });
    if (!response.ok) throw new Error(`Railway API responded ${response.status}`);
    const payload = (await response.json()) as {
      data?: {
        deployment?: {
          id?: unknown;
          status?: unknown;
          createdAt?: unknown;
          statusUpdatedAt?: unknown;
          meta?: { commitHash?: unknown } | null;
        } | null;
      };
      errors?: Array<{ message?: unknown }>;
    };
    const deployment = payload.data?.deployment;
    if (!deployment || deployment.id !== deploymentId) {
      throw new Error("Railway deployment lookup returned no matching deployment.");
    }

    // Never surface timestamps for a deployment whose reported commit
    // conflicts with what this process is actually running -- something is
    // stale or mismatched, and a wrong timestamp is worse than none.
    const remoteCommitSha = validateCommitSha(deployment.meta?.commitHash);
    if (commitSha && remoteCommitSha && remoteCommitSha !== commitSha) {
      lastFailureAt = Date.now();
      return UNKNOWN_TIMELINE;
    }

    const deploymentStatus = mapRailwayDeploymentStatus(deployment.status);
    const deploymentStartedAt = validateDeploymentTimestamp(deployment.createdAt);
    const deployedAt =
      deploymentStatus === "success"
        ? validateDeploymentTimestamp(deployment.statusUpdatedAt)
        : null;

    const timeline: DeploymentTimeline = {
      deploymentStartedAt,
      deployedAt,
      deploymentStatus,
    };
    cachedForDeploymentId = deploymentId;
    cachedTimeline = timeline;
    return timeline;
  } catch {
    // Railway API hiccup, timeout, or malformed response -- this is a
    // diagnostics affordance, so fail safe to nulls rather than a 500 or a
    // fabricated timestamp, and back off briefly before retrying.
    lastFailureAt = Date.now();
    return UNKNOWN_TIMELINE;
  }
}

export async function getPublicBuildInfo(
  fetchImpl: FetchLike = fetch
): Promise<PublicBuildInfo> {
  const generated = readGeneratedBuildInfo();

  const commitSha =
    validateCommitSha(process.env.RAILWAY_GIT_COMMIT_SHA) ||
    validateCommitSha(generated.gitCommitShaFallback) ||
    null;

  const deploymentId =
    typeof process.env.RAILWAY_DEPLOYMENT_ID === "string" &&
    process.env.RAILWAY_DEPLOYMENT_ID.trim()
      ? process.env.RAILWAY_DEPLOYMENT_ID.trim()
      : null;

  const timeline = await resolveDeploymentTimeline(deploymentId, commitSha, fetchImpl);

  return {
    environment: resolveEnvironment(),
    commitSha,
    shortCommitSha: formatShortCommitSha(commitSha),
    builtAt: validateIsoTimestamp(generated.buildTimestamp),
    deploymentId,
    deploymentStartedAt: timeline.deploymentStartedAt,
    deployedAt: timeline.deployedAt,
    deploymentStatus: timeline.deploymentStatus,
  };
}
