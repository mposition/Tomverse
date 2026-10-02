import "server-only";
import { resolveDeploymentEnvironment, validateEnvironment } from "./deploymentEnvironment";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RuntimeEnvironment = Pick<NodeJS.ProcessEnv,
    "APP_ENV" | "NODE_ENV" | "RAILWAY_ENVIRONMENT_NAME" | "RAILWAY_DEPLOYMENT_ID" |
    "RAILWAY_GIT_COMMIT_SHA" | "RAILWAY_API_TOKEN">;

/**
 * Read-only deployment observation. A SUCCESS response for one deployment
 * does not prove that it is still active or match a future stage approval.
 */
export async function observePromptRefinerVnextOneShotDeployment(
    options: { environment?: RuntimeEnvironment; fetchImpl?: typeof fetch } = {},
) {
    const environment = options.environment ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const deploymentId = environment.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "";
    const commitSha = environment.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
    const token = environment.RAILWAY_API_TOKEN?.trim() ?? "";
    const problems: string[] = [];
    if (validateEnvironment(environment.RAILWAY_ENVIRONMENT_NAME) !== "staging" ||
        resolveDeploymentEnvironment(environment) !== "staging") {
        problems.push("runtime_environment_not_staging");
    }
    if (!DEPLOYMENT_ID.test(deploymentId) || !SHA.test(commitSha)) {
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
                    query: `query PromptRefinerVnextDeployment($id: String!) {
                        deployment(id: $id) { id status meta }
                    }`,
                    variables: { id: deploymentId },
                }),
            });
            if (!response.ok) throw new Error("railway_http_error");
            const payload: unknown = await response.json();
            const result = payload as {
                data?: { deployment?: { id?: unknown; status?: unknown;
                    meta?: { commitHash?: unknown } | null } | null };
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
            }
        } catch {
            problems.push("railway_deployment_unavailable");
        }
    }
    return Object.freeze({
        deploymentId: DEPLOYMENT_ID.test(deploymentId) ? deploymentId : null,
        commitSha: SHA.test(commitSha) ? commitSha : null,
        runtimeAndRailwayAgree: problems.length === 0,
        // A superseded SUCCESS deployment is not necessarily the active one.
        activeDeploymentConfirmed: false as const,
        stageApprovalMatched: false as const,
        dispatchAuthorized: false as const,
        problems: Object.freeze(problems),
    });
}
