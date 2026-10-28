import "server-only";
import { resolveDeploymentEnvironment, validateEnvironment } from "./deploymentEnvironment";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RuntimeEnvironment = Pick<NodeJS.ProcessEnv,
    "APP_ENV" | "NODE_ENV" | "RAILWAY_ENVIRONMENT_NAME" | "RAILWAY_DEPLOYMENT_ID" |
    "RAILWAY_GIT_COMMIT_SHA" | "RAILWAY_PROJECT_ID" | "RAILWAY_SERVICE_ID" |
    "RAILWAY_ENVIRONMENT_ID" | "RAILWAY_API_TOKEN">;

/**
 * Read-only deployment observation. The exact SUCCESS deployment must also
 * match Railway's latest active successful deployment for this service.
 * This does not match a future stage approval or authorize dispatch.
 */
export async function observePromptRefinerVnextOneShotDeployment(
    options: { environment?: RuntimeEnvironment; fetchImpl?: typeof fetch } = {},
) {
    const environment = options.environment ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const deploymentId = environment.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "";
    const commitSha = environment.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
    const projectId = environment.RAILWAY_PROJECT_ID?.trim().toLowerCase() ?? "";
    const serviceId = environment.RAILWAY_SERVICE_ID?.trim().toLowerCase() ?? "";
    const environmentId = environment.RAILWAY_ENVIRONMENT_ID?.trim().toLowerCase() ?? "";
    const token = environment.RAILWAY_API_TOKEN?.trim() ?? "";
    const problems: string[] = [];
    if (validateEnvironment(environment.RAILWAY_ENVIRONMENT_NAME) !== "staging" ||
        resolveDeploymentEnvironment(environment) !== "staging") {
        problems.push("runtime_environment_not_staging");
    }
    if (!DEPLOYMENT_ID.test(deploymentId) || !SHA.test(commitSha) ||
        !DEPLOYMENT_ID.test(projectId) || !DEPLOYMENT_ID.test(serviceId) ||
        !DEPLOYMENT_ID.test(environmentId)) {
        problems.push("runtime_identity_unavailable");
    }
    if (!token) problems.push("railway_read_credentials_unavailable");
    if (problems.length === 0) {
        try {
            const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
                method: "POST",
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.timeout(5_000),
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `query PromptRefinerVnextDeployment(
                        $id: String!, $input: DeploymentListInput!
                    ) {
                        deployment(id: $id) { id status meta }
                        deployments(input: $input, first: 1) {
                            edges { node { id status } }
                        }
                    }`,
                    variables: {
                        id: deploymentId,
                        input: {
                            projectId, serviceId, environmentId,
                            status: { in: ["SUCCESS"] },
                        },
                    },
                }),
            });
            if (!response.ok) throw new Error("railway_http_error");
            const payload: unknown = await response.json();
            const result = payload as {
                data?: {
                    deployment?: { id?: unknown; status?: unknown;
                        meta?: { commitHash?: unknown } | null } | null;
                    deployments?: { edges?: Array<{ node?: {
                        id?: unknown; status?: unknown } | null }> } | null;
                };
                errors?: unknown;
            };
            const deployment = result.data?.deployment;
            const remoteSha = typeof deployment?.meta?.commitHash === "string"
                ? deployment.meta.commitHash.toLowerCase() : "";
            if (result.errors || deployment?.id !== deploymentId || !SHA.test(remoteSha)) {
                problems.push("railway_deployment_unavailable");
            } else {
                if (remoteSha !== commitSha) problems.push("railway_commit_mismatch");
                if (deployment.status !== "SUCCESS") problems.push("railway_deployment_not_success");
                const edges = result.data?.deployments?.edges;
                if (!Array.isArray(edges) || edges.length !== 1 ||
                    typeof edges[0]?.node?.id !== "string" ||
                    !DEPLOYMENT_ID.test(edges[0].node.id) ||
                    edges[0].node.status !== "SUCCESS") {
                    problems.push("railway_active_deployment_unavailable");
                } else if (edges[0].node.id !== deploymentId) {
                    problems.push("railway_active_deployment_mismatch");
                }
            }
        } catch {
            problems.push("railway_deployment_unavailable");
        }
    }
    return Object.freeze({
        deploymentId: DEPLOYMENT_ID.test(deploymentId) ? deploymentId : null,
        commitSha: SHA.test(commitSha) ? commitSha : null,
        runtimeAndRailwayAgree: problems.length === 0,
        activeDeploymentConfirmed: problems.length === 0,
        stageApprovalMatched: false as const,
        dispatchAuthorized: false as const,
        problems: Object.freeze(problems),
    });
}
