import { validateEnvironment } from "@/lib/deploymentEnvironment";

export type RoutingApplicationIdentity = {
  applicationCommitSha: string | null;
  applicationDeploymentId: string | null;
  applicationEnvironment: string | null;
};

const FULL_SHA = /^[a-f0-9]{40}$/i;
const DEPLOYMENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Writer-reported provenance, never a reconstruction of an older row. */
export function routingApplicationIdentity(
  environment: Record<string, string | undefined> = process.env
): RoutingApplicationIdentity {
  const commit = environment.RAILWAY_GIT_COMMIT_SHA?.trim();
  const deployment = environment.RAILWAY_DEPLOYMENT_ID?.trim();
  const name = validateEnvironment(environment.APP_ENV) ??
    validateEnvironment(environment.RAILWAY_ENVIRONMENT_NAME);
  if (!commit || !FULL_SHA.test(commit) || !deployment ||
      !DEPLOYMENT_ID.test(deployment) || !name) {
    return { applicationCommitSha: null, applicationDeploymentId: null,
      applicationEnvironment: null };
  }
  return { applicationCommitSha: commit.toLowerCase(),
    applicationDeploymentId: deployment.toLowerCase(), applicationEnvironment: name };
}
