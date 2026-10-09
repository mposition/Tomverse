/**
 * The merge lane service's Railway port (docs/policy/qa-release-agent.md
 * version 4, section 8 item 4): every staging service's recent deployments,
 * read with a project token scoped to staging. Reads only.
 *
 * The token names its own environment (`projectToken`); the port refuses to
 * read anything unless that environment is called "staging" -- a token for
 * another environment is a configuration error, never a smaller staging.
 * Like the merge train, it also refuses an environment where no service
 * deploys from this repository, which would otherwise read as idle.
 *
 * Any answer that is not the expected shape is null: the round treats that as
 * unread and neither merges nor closes anything on it.
 */
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import type { QaReleaseDeployment, QaReleaseMergeLanePorts } from "./qaReleaseMergeLaneServiceCore.ts";

export const QA_RELEASE_RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const REPOSITORY = "mposition/Tomverse";
/** The merge train's depth per service (scripts/merge-train.mjs). */
const DEPLOYMENTS_PER_SERVICE = 25;
const MAX_SERVICES = 40;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("railway_shape");
  return value as Json;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("railway_shape");
  return value;
};
const edges = (connection: unknown): Json[] => {
  const list = record(connection).edges;
  if (!Array.isArray(list)) throw new Error("railway_shape");
  return list.map((edge) => record(record(edge).node));
};

export function createQaReleaseRailwayPorts(input: { http: QaReleaseHttp; token: string }): QaReleaseMergeLanePorts["railway"] {
  const query = async (text: string, variables: Json = {}): Promise<Json> => {
    const response = await input.http({
      method: "POST",
      url: QA_RELEASE_RAILWAY_API,
      headers: { "content-type": "application/json", "project-access-token": input.token },
      body: JSON.stringify({ query: text, variables }),
    });
    if (response.status !== 200) throw new Error(`railway_${response.status}`);
    const body = record(JSON.parse(response.text));
    if (body.errors !== undefined) throw new Error("railway_errors");
    return record(body.data);
  };

  return {
    async stagingDeployments(): Promise<QaReleaseDeployment[] | null> {
      try {
        const scope = record((await query("query { projectToken { projectId environmentId } }")).projectToken);
        const projectId = str(scope.projectId);
        const environmentId = str(scope.environmentId);
        if (!ID.test(projectId) || !ID.test(environmentId)) return null;
        const environment = record(
          (
            await query(
              `query($id: String!) { environment(id: $id) { id name serviceInstances { edges { node { serviceId serviceName source { repo } } } } } }`,
              { id: environmentId },
            )
          ).environment,
        );
        if (environment.name !== "staging") return null;
        const services = edges(environment.serviceInstances);
        if (services.length === 0 || services.length > MAX_SERVICES) return null;
        if (!services.some((service) => service.source !== null && record(service.source).repo === REPOSITORY)) return null;

        const deployments: QaReleaseDeployment[] = [];
        for (const service of services) {
          const serviceId = str(service.serviceId);
          if (!ID.test(serviceId)) return null;
          const serviceName = str(service.serviceName);
          const data = await query(
            `query($input: DeploymentListInput!, $first: Int) { deployments(input: $input, first: $first) { edges { node { id status createdAt meta } } } }`,
            { input: { projectId, environmentId, serviceId }, first: DEPLOYMENTS_PER_SERVICE },
          );
          for (const node of edges(data.deployments)) {
            const meta = node.meta === null || node.meta === undefined ? {} : record(node.meta);
            deployments.push({
              serviceId,
              serviceName,
              status: str(node.status),
              createdAt: str(node.createdAt),
              meta: {
                commitHash: typeof meta.commitHash === "string" ? meta.commitHash : undefined,
                branch: typeof meta.branch === "string" ? meta.branch : undefined,
              },
            });
          }
        }
        return deployments;
      } catch {
        return null;
      }
    },
  };
}
