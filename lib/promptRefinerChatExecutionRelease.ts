import { loadPromptRefinerProductRelease,
  loadPromptRefinerProductReleaseAdmission } from
  "@/lib/promptRefinerProductReleaseStore";
import { isPromptRefinerEnabled } from "@/lib/appSettings";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";

const closed = () => Object.freeze({ explicitEnabled: false,
  autoEnabled: false, runtimeCommitSha: null, runtimeDeploymentId: null,
  approvalAuditLogId: null });

/** Side-effect-free capability view; execution requires fresh admission. */
export async function promptRefinerChatExecutionRelease() {
  return readPromptRefinerChatExecutionRelease(false);
}

/** Revalidates live evidence and records a durable stop before execution. */
export async function promptRefinerChatExecutionAdmission() {
  return readPromptRefinerChatExecutionRelease(true);
}

async function readPromptRefinerChatExecutionRelease(admit: boolean) {
  if (promptRefinerKillSwitchEngaged(process.env) || isE2EDatabaseDisabled() ||
      !/^[0-9a-f]{40}$/.test(
        process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        process.env.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "")) {
    return closed();
  }
  try {
    // The ordinary rollout flag remains the first database-owned off gate.
    // It cannot replace deployment approval or the fresh execution proof.
    if (!await isPromptRefinerEnabled()) return closed();
    return await (admit ? loadPromptRefinerProductReleaseAdmission(process.env) :
      loadPromptRefinerProductRelease(process.env));
  } catch {
    // Database uncertainty closes both availability and execution admission
    // instead of turning a Chat request into a generic 500.
    return closed();
  }
}
