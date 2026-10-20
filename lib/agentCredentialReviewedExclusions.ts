import type { HumanExclusion } from "./agentCredentialReachability.ts";

/** Owner-reviewed exceptions to credential reachability, pinned to exact
 * workflow blobs. This control-plane file is never eligible for T1 edits.
 * A changed workflow blob voids its exception in the analyzer. */
export const AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS = [
  {
    workflowPath: ".github/workflows/feedback-autofix-promotion-pr.yml",
    jobId: "promotion-pr",
    blobSha: "71330b1c7331970304fc910360c059758f5847c2",
    reason: "The owner reviewed the exact blob: pull_request closed needs a merged feedback-autofix head, while the engineering Publisher creates only agent/engineering heads; workflow_dispatch is a separate operator trigger unavailable to its GitHub App token.",
    reviewedBy: "mposition",
  },
  {
    workflowPath: ".github/workflows/pr-ci-auto-fix.yml",
    jobId: "propose",
    blobSha: "b4064c6386be6da2c39932639c6e33716382290e",
    reason: "The owner approved this workflow on 2026-10-20 (AGENTS.md approval list: a new autonomous permission and a paid model call) and reviewed the exact blob: it runs on workflow_run, and its target job, from a trusted checkout of the default branch, serves only claude/to-develop/** and codex/to-develop/** heads, so an agent/engineering head the Publisher creates is refused before propose or publish runs; publish runs nothing from the pull request.",
    reviewedBy: "mposition",
  },
  {
    workflowPath: ".github/workflows/pr-ci-auto-fix.yml",
    jobId: "publish",
    blobSha: "b4064c6386be6da2c39932639c6e33716382290e",
    reason: "The owner approved this workflow on 2026-10-20 (AGENTS.md approval list: a new autonomous permission and a paid model call) and reviewed the exact blob: it runs on workflow_run, and its target job, from a trusted checkout of the default branch, serves only claude/to-develop/** and codex/to-develop/** heads, so an agent/engineering head the Publisher creates is refused before propose or publish runs; publish runs nothing from the pull request.",
    reviewedBy: "mposition",
  },
] as const satisfies readonly HumanExclusion[];
