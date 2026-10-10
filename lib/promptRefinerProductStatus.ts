import "server-only";

import {
  AUTO_ROLLOUT_READINESS_VERSION,
  autoRolloutReadiness,
} from "@/lib/autoRolloutReadiness";
import { isPromptRefinerEnabled } from "@/lib/appSettings";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  promptRefinerChatExecutionRelease,
} from "@/lib/promptRefinerChatExecutionRelease";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";
import {
  PROMPT_REFINER_PRODUCT_STATUS_VERSION,
  type PromptRefinerProductStatus,
} from "@/lib/promptRefinerProductStatusContract";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ProductRelease = Awaited<
  ReturnType<typeof promptRefinerChatExecutionRelease>
>;

type ProductStatusDependencies = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  readRollout?: () => Promise<boolean>;
  readRelease?: () => Promise<ProductRelease>;
};

const servingIdentity = (env: Record<string, string | undefined>) => {
  const commitCandidate = env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
  const deploymentCandidate =
    env.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "";
  const commitSha = SHA.test(commitCandidate) ? commitCandidate : null;
  const deploymentId = deploymentCandidate.length >= 1 &&
    deploymentCandidate.length <= 128
    ? deploymentCandidate
    : null;
  return {
    commitSha,
    deploymentId,
    exactProductIdentity:
      commitSha !== null && deploymentId !== null && UUID.test(deploymentId),
  };
};

const unavailableRelease = (state: PromptRefinerProductStatus["release"]["state"]):
PromptRefinerProductStatus["release"] => ({
  state,
  explicitEnabled: null,
  autoEnabled: null,
  approvalAuditLogId: null,
});

/**
 * Content-free serving-process readback. It is diagnostic only: this function
 * never admits a request, records an audit event, or turns a release gate on.
 */
export async function readPromptRefinerProductStatus(
  dependencies: ProductStatusDependencies = {}
): Promise<PromptRefinerProductStatus> {
  const env = dependencies.env ?? process.env;
  const observedAtMs = (dependencies.now ?? Date.now)();
  const serving = servingIdentity(env);
  const killSwitchEngaged = promptRefinerKillSwitchEngaged(env);
  const databaseDisabled = isE2EDatabaseDisabled();
  const readiness = autoRolloutReadiness(undefined, () => observedAtMs);

  let rollout: PromptRefinerProductStatus["controls"]["rollout"] = "unknown";
  if (!killSwitchEngaged && !databaseDisabled) {
    try {
      rollout = await (dependencies.readRollout ?? isPromptRefinerEnabled)()
        ? "enabled"
        : "disabled";
    } catch {
      // A failed settings read is not evidence that rollout is off.
    }
  }

  let release: PromptRefinerProductStatus["release"];
  if (killSwitchEngaged) {
    release = {
      state: "blocked_by_kill_switch",
      explicitEnabled: false,
      autoEnabled: false,
      approvalAuditLogId: null,
    };
  } else if (rollout === "unknown") {
    release = unavailableRelease("unavailable");
  } else if (rollout === "disabled") {
    release = {
      state: "disabled_by_rollout",
      explicitEnabled: false,
      autoEnabled: false,
      approvalAuditLogId: null,
    };
  } else if (!serving.exactProductIdentity) {
    release = unavailableRelease("runtime_identity_unavailable");
  } else {
    try {
      const current = await (
        dependencies.readRelease ?? promptRefinerChatExecutionRelease
      )();
      if (!current.explicitEnabled && !current.autoEnabled) {
        // The established release reader intentionally folds database errors
        // into its closed shape. Do not turn that uncertainty into an "off"
        // or "gate failed" claim in an operator status screen.
        release = unavailableRelease("closed_or_unavailable");
      } else if (
        current.runtimeCommitSha !== serving.commitSha ||
        current.runtimeDeploymentId !== serving.deploymentId ||
        typeof current.approvalAuditLogId !== "string" ||
        current.approvalAuditLogId.length < 1 ||
        current.approvalAuditLogId.length > 128
      ) {
        release = unavailableRelease("unavailable");
      } else {
        release = {
          state: "recorded",
          explicitEnabled: current.explicitEnabled,
          autoEnabled: current.autoEnabled,
          approvalAuditLogId: current.approvalAuditLogId,
        };
      }
    } catch {
      release = unavailableRelease("unavailable");
    }
  }

  return {
    version: PROMPT_REFINER_PRODUCT_STATUS_VERSION,
    observedAt: new Date(observedAtMs).toISOString(),
    serving,
    controls: { rollout, killSwitchEngaged },
    release,
    router: {
      version: AUTO_ROLLOUT_READINESS_VERSION,
      ready: readiness.ready,
      outstanding: [...readiness.outstanding],
      problems: [...readiness.problems],
    },
    completionClaim: "not_established_by_status_readback",
  };
}
