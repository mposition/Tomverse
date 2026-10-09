import { loadPromptRefinerProductRelease } from
  "@/lib/promptRefinerProductReleaseStore";
import { isPromptRefinerEnabled } from "@/lib/appSettings";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";

const closed = () => Object.freeze({ explicitEnabled: false,
  autoEnabled: false, runtimeCommitSha: null, runtimeDeploymentId: null,
  approvalAuditLogId: null });

/** Exact-deployment release facts only; the checked-in registry is empty. */
export async function promptRefinerChatExecutionRelease() {
  if (promptRefinerKillSwitchEngaged(process.env) || isE2EDatabaseDisabled() ||
      !/^[0-9a-f]{40}$/.test(
        process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        process.env.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "")) {
    return closed();
  }
  try {
    // The ordinary rollout flag remains the first database-owned off gate.
    // It cannot replace the exact deployment approval checked below.
    if (!await isPromptRefinerEnabled()) return closed();
    return await loadPromptRefinerProductRelease(process.env);
  } catch {
    // A release read is an authorization read. Database uncertainty disables
    // the product instead of turning a Chat request into a generic 500.
    return closed();
  }
}
