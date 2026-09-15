import "server-only";

import {
  DEPLOYMENT_SAMPLES_PER_PASS,
  isFreshResponse,
  type BuildInfoSample,
  type ControlPlaneDeployment,
  type DeploymentPassObservation,
} from "@/lib/feedbackAutoFixDeploymentObservation";

/**
 * Collects one observer pass's facts about a deployment, for
 * judgeDeploymentObservation() to decide on. Reads only.
 *
 *  - Railway's control plane: the service's recent deployments in the target
 *    environment, with status and commit, through the same GraphQL endpoint
 *    and RAILWAY_API_TOKEN lib/buildInfo.ts already uses.
 *  - The environment's public `/api/build-info`, sampled several times, and
 *    (production only) `/api/ready`. Each request carries a unique query
 *    string and `no-store`, refuses redirects, and goes only to the fixed
 *    environment origin -- a cached or redirected answer is a failed sample,
 *    not a sighting (independent review, round 1 N6).
 *
 * Staging's `/api/ready` sits behind Cloudflare Access and cannot be read, so
 * staging observation uses the control plane and build-info only; the policy
 * records that gap (docs/policy/trace-feedback-automation.md §9.3).
 */

type FetchLike = typeof fetch;

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const REQUEST_TIMEOUT_MS = 5_000;
/** Recent deployments read per environment -- enough to see an old one
 * still draining beside the newest. */
const CONTROL_PLANE_DEPLOYMENTS = 10;

export type PromotionEnvironment = "staging" | "production";

export const promotionEnvironmentUrl = (environment: PromotionEnvironment) =>
  environment === "production"
    ? process.env.PRODUCTION_APP_URL || "https://tomverse.app"
    : process.env.STAGING_APP_URL || "https://staging.tomverse.app";

const railwayEnvironmentId = (environment: PromotionEnvironment) =>
  (environment === "production"
    ? process.env.FEEDBACK_AUTOFIX_PRODUCTION_RAILWAY_ENVIRONMENT_ID
    : process.env.FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID
  )?.trim() || "";

const railwayServiceId = () =>
  process.env.FEEDBACK_AUTOFIX_RAILWAY_SERVICE_ID?.trim() ||
  process.env.RAILWAY_SERVICE_ID?.trim() ||
  "";

const railwayProjectId = () => process.env.RAILWAY_PROJECT_ID?.trim() || "";

/** What is missing before deployments can be observed at all. */
export const deploymentProbeConfigurationProblems = (): string[] => {
  const problems: string[] = [];
  if (!process.env.RAILWAY_API_TOKEN?.trim()) problems.push("RAILWAY_API_TOKEN");
  if (!railwayProjectId()) problems.push("RAILWAY_PROJECT_ID");
  if (!railwayServiceId()) problems.push("FEEDBACK_AUTOFIX_RAILWAY_SERVICE_ID");
  if (!railwayEnvironmentId("staging")) {
    problems.push("FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID");
  }
  if (!railwayEnvironmentId("production")) {
    problems.push("FEEDBACK_AUTOFIX_PRODUCTION_RAILWAY_ENVIRONMENT_ID");
  }
  return problems;
};

const readControlPlane = async (
  environment: PromotionEnvironment,
  fetchImpl: FetchLike
): Promise<ControlPlaneDeployment[] | null> => {
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  if (!token || deploymentProbeConfigurationProblems().length > 0) return null;
  try {
    const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query TomverseAutoFixDeployments($input: DeploymentListInput!, $first: Int) {
            deployments(input: $input, first: $first) {
              edges { node { id status meta } }
            }
          }
        `,
        variables: {
          input: {
            projectId: railwayProjectId(),
            serviceId: railwayServiceId(),
            environmentId: railwayEnvironmentId(environment),
          },
          first: CONTROL_PLANE_DEPLOYMENTS,
        },
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: {
        deployments?: {
          edges?: Array<{
            node?: { id?: unknown; status?: unknown; meta?: { commitHash?: unknown } | null };
          }>;
        };
      };
      errors?: unknown;
    };
    const edges = payload.data?.deployments?.edges;
    if (payload.errors || !Array.isArray(edges)) return null;
    const deployments: ControlPlaneDeployment[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      if (typeof node?.id !== "string" || typeof node.status !== "string") return null;
      deployments.push({
        id: node.id,
        status: node.status,
        commitSha:
          typeof node.meta?.commitHash === "string"
            ? node.meta.commitHash.toLowerCase()
            : null,
      });
    }
    return deployments;
  } catch {
    return null;
  }
};

const sampleUrl = (environment: PromotionEnvironment, path: string, index: number) => {
  const url = new URL(path, promotionEnvironmentUrl(environment));
  url.searchParams.set("autofix_probe", `${Date.now()}-${index}`);
  return url;
};

const noStoreInit = (): RequestInit => ({
  method: "GET",
  cache: "no-store",
  redirect: "manual",
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
});

const readBuildInfo = async (
  environment: PromotionEnvironment,
  index: number,
  fetchImpl: FetchLike
): Promise<BuildInfoSample | null> => {
  try {
    const response = await fetchImpl(sampleUrl(environment, "/api/build-info", index), noStoreInit());
    // A redirect (e.g. an Access login page) or a cache hit is not a sighting.
    if (!isFreshResponse(response)) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return {
      commitSha: typeof body.commitSha === "string" ? body.commitSha.toLowerCase() : null,
      deploymentId: typeof body.deploymentId === "string" ? body.deploymentId : null,
      deploymentStatus:
        typeof body.deploymentStatus === "string" ? body.deploymentStatus : null,
    };
  } catch {
    return null;
  }
};

const readReady = async (
  environment: PromotionEnvironment,
  index: number,
  fetchImpl: FetchLike
): Promise<boolean> => {
  try {
    const response = await fetchImpl(sampleUrl(environment, "/api/ready", index), noStoreInit());
    // The same freshness rule as build-info: a cached 200 from an earlier,
    // healthy deployment says nothing about this one (review round 2, N1).
    return isFreshResponse(response);
  } catch {
    return false;
  }
};

export const observeDeployment = async (
  environment: PromotionEnvironment,
  fetchImpl: FetchLike = fetch
): Promise<DeploymentPassObservation> => {
  const controlPlane = await readControlPlane(environment, fetchImpl);
  const buildInfo: Array<BuildInfoSample | null> = [];
  const ready: boolean[] = [];
  for (let index = 0; index < DEPLOYMENT_SAMPLES_PER_PASS; index += 1) {
    buildInfo.push(await readBuildInfo(environment, index, fetchImpl));
    if (environment === "production") {
      ready.push(await readReady(environment, index, fetchImpl));
    }
  }
  return { controlPlane, buildInfo, ready };
};
