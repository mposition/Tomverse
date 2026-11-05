import type { HumanExclusion } from "./agentCredentialReachability.ts";

/** Owner-reviewed exceptions to credential reachability, pinned to exact
 * workflow blobs. This control-plane file is never eligible for T1 edits.
 * A changed workflow blob voids its exception in the analyzer. */
export const AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS = [] as const satisfies readonly HumanExclusion[];
