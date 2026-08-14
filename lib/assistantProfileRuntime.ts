/**
 * Whether a profile version may run, and what it is allowed to bring (C3a).
 *
 * docs/policy/external-conversation-import-and-memory.md §14 ("runtime 검증"),
 * §14, §8.1's invariants, which a profile is explicitly not allowed to
 * step around.
 *
 * Pure, in the `decideMemoryInjection` mould: every input is supplied, and the
 * refusal reason is carried rather than discarded, because "the flag is off"
 * and "the model this profile names was retired" send a user to two different
 * places.
 *
 * ## The one thing this module exists to make structural
 *
 * §14's sentence is that a profile cannot bypass plan and model entitlement,
 * the account master toggle, the conversation memory mode, the feature flag,
 * or a source lock. A profile is a *request*, and every function here is
 * shaped so the profile can only ever narrow:
 *
 *   * memory use is `profileWants && memoryAllowed` — an AND, never a
 *     fallback, so a profile asking for memory on an account that has it off
 *     gets nothing;
 *   * tools are an intersection with what the plan already permits, so a
 *     profile cannot grant a tool the account does not have;
 *   * the model is checked against the registry and the plan, and a profile
 *     whose model is gone is *refused* rather than silently rehomed onto
 *     another one.
 *
 * That last one is worth stating plainly: there is no substitution anywhere in
 * this file. `ASSISTANT_PROFILE_MODEL_UNAVAILABLE` exists precisely so a
 * conversation never quietly changes which model it runs on, which is the same
 * rule the fallback layer holds for chat.
 */

import {
    ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
    ASSISTANT_PROMPT_FORMAT_VERSION,
    ASSISTANT_RETRIEVAL_VERSION,
    type AssistantMemoryPolicy,
    type AssistantToolPolicy,
} from "@/lib/assistantProfileVersioning";

export const ASSISTANT_PROFILES_DISABLED = "ASSISTANT_PROFILES_DISABLED";
export const ASSISTANT_PROFILE_NO_ACTIVE_VERSION =
    "ASSISTANT_PROFILE_NO_ACTIVE_VERSION";
export const ASSISTANT_PROFILE_FORMAT_UNSUPPORTED =
    "ASSISTANT_PROFILE_FORMAT_UNSUPPORTED";

export type ProfileRuntimeRefusal =
    | "guest"
    | "flag_off"
    | "no_active_version"
    | "model_unavailable"
    | "format_unsupported";

export type ProfileRuntimeDecision =
    | { allowed: true }
    | { allowed: false; reason: ProfileRuntimeRefusal; code: string };

const REFUSAL_CODES: Record<ProfileRuntimeRefusal, string> = {
    guest: ASSISTANT_PROFILES_DISABLED,
    flag_off: ASSISTANT_PROFILES_DISABLED,
    no_active_version: ASSISTANT_PROFILE_NO_ACTIVE_VERSION,
    model_unavailable: ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
    format_unsupported: ASSISTANT_PROFILE_FORMAT_UNSUPPORTED,
};

const refuse = (reason: ProfileRuntimeRefusal): ProfileRuntimeDecision => ({
    allowed: false,
    reason,
    code: REFUSAL_CODES[reason],
});

/**
 * Whether this profile version may run this turn.
 *
 * The order is not arbitrary. A guest has no profile to run, so that is first
 * and the flag second — both are "this feature is not available to you", and
 * reporting a model problem to somebody who cannot use profiles at all would
 * be a message about the wrong thing. Only then does the version's own content
 * get judged.
 *
 * Guests are excluded outright rather than degraded: §8.1's exclusion is
 * about memory, but a profile carries instructions, a model choice and
 * knowledge that all belong to an account, and there is no guest-shaped
 * version of that which is not a new feature.
 */
export function decideProfileRuntime(input: {
    isAuthenticated: boolean;
    profilesFlagEnabled: boolean;
    /** False when the profile has never published a version. */
    hasActiveVersion: boolean;
    /** The version's model, resolved against the registry by the caller. */
    modelEnabled: boolean;
    /** Whether the caller's plan permits that model. */
    modelPermittedByPlan: boolean;
    /** The stored `promptFormatVersion` of the version being run. */
    promptFormatVersion: string;
}): ProfileRuntimeDecision {
    if (!input.isAuthenticated) return refuse("guest");
    if (!input.profilesFlagEnabled) return refuse("flag_off");
    if (!input.hasActiveVersion) return refuse("no_active_version");
    // Both halves are the same refusal on purpose: from the owner's side
    // "this model is gone" and "your plan no longer includes it" are one
    // problem with one fix, which is to pick a different model. Nothing here
    // picks one for them.
    if (!input.modelEnabled || !input.modelPermittedByPlan) {
        return refuse("model_unavailable");
    }
    if (input.promptFormatVersion !== ASSISTANT_PROMPT_FORMAT_VERSION) {
        return refuse("format_unsupported");
    }
    return { allowed: true };
}

/**
 * Whether this turn actually uses account memory.
 *
 * An AND of what the profile asked for and what the account already allows.
 * The parameter is called `memoryAllowedByAccount` rather than being computed
 * here because it is `decideMemoryInjection`'s answer — flag, approved pair,
 * master toggle and conversation mode, all of it — and recomputing any of it
 * here would be a second implementation of a rule that must have exactly one.
 *
 * The asymmetry is the contract: a profile that says no turns memory off for
 * this conversation, and a profile that says yes changes nothing on an account
 * that has it off.
 */
export function resolveProfileMemoryUse(input: {
    memoryPolicy: AssistantMemoryPolicy;
    memoryAllowedByAccount: boolean;
}): boolean {
    return input.memoryPolicy.useAccountMemory && input.memoryAllowedByAccount;
}

/**
 * The tools this turn may use.
 *
 * An intersection, so a profile can turn a tool off but never on. A profile
 * that asked for deep research on a plan without it is not an error worth
 * refusing the whole turn over — the profile still answers, without that tool
 * — but it is also not a grant.
 */
export function resolveProfileTools(input: {
    toolPolicy: AssistantToolPolicy;
    entitled: AssistantToolPolicy;
}): AssistantToolPolicy {
    return {
        webSearch: input.toolPolicy.webSearch && input.entitled.webSearch,
        deepResearch:
            input.toolPolicy.deepResearch && input.entitled.deepResearch,
    };
}

/**
 * Which knowledge files this turn may retrieve from.
 *
 * The version's manifest decides the candidate set and the *current* state of
 * each file decides the rest, which is §14's rule that a manifest is audit
 * metadata: it can say a file was listed, and it cannot make a deleted one
 * readable. A locked or suspended source is excluded here for the same reason
 * §14 names source locks — the profile does not get to see through one.
 */
export function resolveProfileKnowledgeFiles(input: {
    manifestFileIds: readonly string[];
    /** Files that exist now, are owned by this account, and are processed. */
    availableFileIds: readonly string[];
    knowledgeFlagEnabled: boolean;
}): string[] {
    if (!input.knowledgeFlagEnabled) return [];
    const available = new Set(input.availableFileIds);
    return input.manifestFileIds.filter((fileId) => available.has(fileId));
}

/**
 * Everything the runtime needs to bind into a §10 context bundle.
 *
 * Gathered into one shape so the bundle carries the *decisions* rather than
 * the inputs. A bundle that recorded "the profile asked for memory" would
 * verify against a later turn where the account had turned memory off; one
 * that records "memory was used" is a fact about the turn it was issued for.
 */
export type ProfileRuntimeBinding = {
    profileId: string;
    profileVersionId: string;
    revision: number;
    modelIds: readonly string[];
    memoryUsed: boolean;
    tools: AssistantToolPolicy;
    knowledgeFileIds: readonly string[];
    promptFormatVersion: string;
    retrievalVersion: number;
};

export function profileRuntimeBinding(input: {
    profileId: string;
    profileVersionId: string;
    revision: number;
    modelIds: readonly string[];
    memoryUsed: boolean;
    tools: AssistantToolPolicy;
    knowledgeFileIds: readonly string[];
}): ProfileRuntimeBinding {
    return {
        ...input,
        // Recorded from the constants rather than from the row: a bundle says
        // which contract produced it, and a row that somehow carried a
        // different number would make the bundle agree with the row instead of
        // with the code that has to read it back.
        promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
        retrievalVersion: ASSISTANT_RETRIEVAL_VERSION,
    };
}
