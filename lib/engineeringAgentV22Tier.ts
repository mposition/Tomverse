import { CONVENTION_VERSIONS } from "@/lib/agentAuthorityFiles";
import { cacheIsolationRecordSignature } from "@/lib/agentCacheIsolationRecord";
import { analyseCredentialReachability, credentialForbiddenPaths } from
  "@/lib/agentCredentialReachability";
import { AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS } from
  "@/lib/agentCredentialReviewedExclusions";
import { computeControlPlaneSlice } from "@/lib/agentControlPlaneSlice";
import { decideTier, policyNamedTestPaths,
  type TierInput, type TierVerdict } from "@/lib/agentPushPolicy";
import { judgeAgentPrCacheIsolation } from
  "@/scripts/agent-pr-cache-isolation-policy.mjs";

type Changes = TierInput["changes"];
type BaseFiles = Parameters<typeof computeControlPlaneSlice>[0]["baseFiles"];
type Workflows = Parameters<typeof analyseCredentialReachability>[0]["workflows"];

/** The final T1 judgement consumes verified source and image evidence; it
 * never trusts a worker-supplied tier, workflow list, or excluded prefix. The
 * caller must establish those bindings before invoking this pure function. */
export function decideEngineeringAgentV22Tier(input: {
  changes: Changes;
  baseFiles: BaseFiles;
  workflows: Workflows;
  installedVersions: Readonly<Record<keyof typeof CONVENTION_VERSIONS,
    string | null>>;
  policyDocuments: readonly string[];
  deployExcludedPrefixes: readonly string[];
}): TierVerdict {
  const blind = analyseCredentialReachability({
    workflows: input.workflows,
    exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS,
    cacheIsolationRecorded: false,
  });
  const cache = judgeAgentPrCacheIsolation(blind);
  const signature = cacheIsolationRecordSignature();
  const isolationRecorded = signature.signed && cache.status === "judged" &&
    cache.held === true;
  const credential = isolationRecorded ? analyseCredentialReachability({
    workflows: input.workflows,
    exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS,
    cacheIsolationRecorded: true,
  }) : blind;
  const slice = computeControlPlaneSlice({
    baseFiles: input.baseFiles, changes: input.changes,
    deployExcludedPrefixes: input.deployExcludedPrefixes,
  });
  return decideTier({
    changes: input.changes,
    policyNamedTests: policyNamedTestPaths(input.policyDocuments),
    installedVersions: input.installedVersions,
    credential: credential.status === "analysed" ? {
      status: "analysed", forbidsAll: credential.forbidsAll,
      forbiddenPaths: credentialForbiddenPaths(credential,
        input.changes.map((entry) => entry.path)),
    } : { status: "failed" },
    slice: slice.status === "analysed" ? {
      status: "analysed", slicePaths: slice.slicePaths,
    } : { status: "failed" },
  });
}
