import "server-only";

import {
  classifyAmuxV22DeploymentReadback,
  type AmuxV22ExternalReadback,
} from "@/lib/amux/v22ExternalAuthorityCore";
import {
  DEPLOYMENT_SAMPLES_PER_PASS,
  servingDeployment,
  type DeploymentPassObservation,
} from "@/lib/feedbackAutoFixDeploymentObservation";
import {
  observeDeployment,
  type PromotionEnvironment,
} from "@/lib/feedbackAutoFixDeploymentProbe";

/** Diagnostic only. An absent deployment never authorizes another deploy. */
export async function readAmuxV22DeploymentOutcome(input: {
  deploymentId: string;
  commitSha: string;
  environment: PromotionEnvironment;
}, observe: typeof observeDeployment = observeDeployment): Promise<AmuxV22ExternalReadback> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.deploymentId) || !/^[0-9a-f]{40}$/i.test(input.commitSha) ||
      (input.environment !== "staging" && input.environment !== "production")) {
    return { status: "outcome_unknown", reason: "invalid_binding" };
  }
  let observation: DeploymentPassObservation;
  try {
    observation = await observe(input.environment);
  } catch {
    return { status: "outcome_unknown", reason: "readback_unavailable" };
  }
  // The reused Railway probe requests only ten rows and has no page cursor.
  // A full page cannot prove that another serving deployment is absent.
  if (observation.controlPlane && observation.controlPlane.length >= 10) {
    return { status: "outcome_unknown", reason: "readback_incomplete" };
  }
  const serving = servingDeployment(observation.controlPlane);
  if ("reason" in serving) {
    return { status: "outcome_unknown", reason: serving.reason };
  }
  const active = serving.deployment;
  if (active.id !== input.deploymentId ||
      active.commitSha?.toLowerCase() !== input.commitSha.toLowerCase() ||
      observation.buildInfo.length !== DEPLOYMENT_SAMPLES_PER_PASS ||
      observation.buildInfo.some((sample) => !sample ||
        sample.deploymentId !== active.id ||
        sample.commitSha?.toLowerCase() !== input.commitSha.toLowerCase() ||
        sample.deploymentStatus !== "success") ||
      (input.environment === "production" &&
        (observation.ready.length !== DEPLOYMENT_SAMPLES_PER_PASS ||
          observation.ready.some((ready) => ready !== true)))) {
    return { status: "outcome_unknown", reason: "deployment_not_confirmed" };
  }
  return classifyAmuxV22DeploymentReadback({
    expectedDeploymentId: input.deploymentId,
    expectedCommitSha: input.commitSha,
    expectedEnvironment: input.environment,
    observed: {
      deploymentId: active.id,
      commitSha: active.commitSha ?? "",
      environment: input.environment,
      status: "success",
    },
  });
}
