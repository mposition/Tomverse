import type { HumanExclusion } from "./agentCredentialReachability.ts";

/** Owner-reviewed exceptions to credential reachability, pinned to exact
 * workflow blobs. This control-plane file is never eligible for T1 edits.
 * A changed workflow blob voids its exception in the analyzer. */
export const AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS = [
  {
    workflowPath: ".github/workflows/feedback-autofix-promotion-pr.yml",
    jobId: "promotion-pr",
    blobSha: "71330b1c7331970304fc910360c059758f5847c2",
    reason: "The owner reviewed the closed-PR head guard: only merged feedback-autofix branches can enter the credentialed job; the engineering agent can publish only agent/engineering branches.",
    reviewedBy: "mposition",
  },
] as const satisfies readonly HumanExclusion[];
