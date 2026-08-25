import "server-only";

import {
    isAssistantKnowledgeEnabled,
    isAssistantProfilesEnabled,
} from "@/lib/appSettings";
import { assistantKnowledgeUsable } from "@/lib/assistantProfileAccess";
import {
    buildProfileInstructionPrompt,
    buildProfileKnowledgePrompt,
    knowledgeContextHash,
} from "@/lib/assistantProfilePrompt";
import {
    decideProfileRuntime,
    resolveProfileTools,
    type ProfileRuntimeRefusal,
} from "@/lib/assistantProfileRuntime";
import { retrieveKnowledgeContext } from "@/lib/assistantKnowledgeRetrieval";
import type {
    AssistantKnowledgeManifestEntry,
    AssistantMemoryPolicy,
    AssistantToolPolicy,
} from "@/lib/assistantProfileVersioning";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { canUseModelWithPlan, type ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

/**
 * What an assistant profile contributes to one turn (C3c).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §9.1, §10,
 * §14.
 *
 * Two blocks and an identity. The blocks are the version's instructions and
 * whichever knowledge excerpts this message retrieved; the identity is what
 * the §10 context bundle binds, so a profile that was republished or whose
 * files changed between preflight and send is a stale bundle rather than a
 * turn that quietly answers from a different assistant.
 *
 * ## It never decides memory
 *
 * The profile's memory *policy* is reported here and applied by the caller,
 * through `resolveProfileMemoryUse`. Applying it here would mean this module
 * had to know whether the account, the flag, the eval pair and the
 * conversation mode already allow memory — a second implementation of
 * `decideMemoryInjection`, which is the one thing §14 asks not to happen.
 *
 * ## Refusals are reported, not thrown
 *
 * Every refusal reason ends in the same place: the turn runs without the
 * profile. Throwing would turn "your profile names a model your plan no
 * longer includes" into a failed message, and the user would lose what they
 * typed to a problem they can only fix in another screen. The reason is
 * carried so the caller can say which one it was.
 */

export type ChatProfileContext = {
    /**
     * The version that ran, or null when none did — including when the
     * conversation named none.
     *
     * Deliberately not a `ProfileRuntimeBinding`: that shape records
     * `memoryUsed`, which is a decision this module is not allowed to make.
     * The caller ANDs the policy with the account's own answer and completes
     * the binding from these fields, so there is never a moment where a
     * binding says something about memory that nothing has decided.
     */
    version: {
        profileId: string;
        profileVersionId: string;
        revision: number;
        modelIds: string[];
        knowledgeFileIds: string[];
    } | null;
    /** Why the profile did not run, or null when it did (or none was asked for). */
    refusal: ProfileRuntimeRefusal | null;
    /** §9.1 step 2. */
    instructionsPrompt: string | null;
    /** §9.1 step 4. */
    knowledgePrompt: string | null;
    /** Input tokens the two blocks contribute, priced and booked as one figure. */
    profileTokens: number;
    /** `<versionId>:<revision>`, or null. Bound into the §10 bundle. */
    profileVersion: string | null;
    /** Identity of this turn's knowledge retrieval. `"none"` when empty. */
    knowledgeHash: string;
    /**
     * What the version asked for. The caller ANDs it with the account's own
     * answer; on its own it grants nothing.
     */
    memoryPolicy: AssistantMemoryPolicy | null;
    /** Already intersected with the caller's entitlement (§14). */
    tools: AssistantToolPolicy | null;
    /** §22-shaped observation, content-free. */
    knowledgeChunkCount: number;
};

/** The turn no profile is bound to, which is every turn today. */
export const NO_PROFILE_CONTEXT: ChatProfileContext = {
    version: null,
    refusal: null,
    instructionsPrompt: null,
    knowledgePrompt: null,
    profileTokens: 0,
    profileVersion: null,
    knowledgeHash: "none",
    memoryPolicy: null,
    tools: null,
    knowledgeChunkCount: 0,
};

const refused = (reason: ProfileRuntimeRefusal): ChatProfileContext => ({
    ...NO_PROFILE_CONTEXT,
    refusal: reason,
});

const manifestFileIds = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) =>
            entry &&
            typeof entry === "object" &&
            typeof (entry as AssistantKnowledgeManifestEntry).fileId === "string"
                ? (entry as AssistantKnowledgeManifestEntry).fileId
                : null
        )
        .filter((fileId): fileId is string => fileId !== null);
};

const storedModelIds = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

const storedToolPolicy = (value: unknown): AssistantToolPolicy => {
    const record = (value ?? {}) as Record<string, unknown>;
    return {
        webSearch: record.webSearch === true,
        deepResearch: record.deepResearch === true,
    };
};

const storedMemoryPolicy = (value: unknown): AssistantMemoryPolicy => {
    const record = (value ?? {}) as Record<string, unknown>;
    return { useAccountMemory: record.useAccountMemory === true };
};

export async function buildChatProfileContext(input: {
    /** Null for a guest, who has no profile of their own to run (§14). */
    userId: string | null;
    /** The conversation's bound version, or null when it names none. */
    profileVersionId: string | null;
    /** The current user message, which knowledge is retrieved against. */
    query: string;
    /** The account's plan, for the version's own model check. */
    plan: ModelTier | null;
    /** What the caller's plan already permits. A profile intersects with it. */
    entitledTools: AssistantToolPolicy;
}): Promise<ChatProfileContext> {
    if (!input.profileVersionId) return NO_PROFILE_CONTEXT;
    if (!input.userId) return refused("guest");

    const [profilesEnabled, knowledgeEnabled] = await Promise.all([
        isAssistantProfilesEnabled(),
        isAssistantKnowledgeEnabled(),
    ]);
    if (!profilesEnabled) return refused("flag_off");

    // Ownership is part of the query, not a check after it: a version fetched
    // by id alone is a version another account's conversation id could name.
    const version = await prisma.assistantProfileVersion.findFirst({
        where: { id: input.profileVersionId, userId: input.userId },
        select: {
            id: true,
            profileId: true,
            revision: true,
            instructions: true,
            models: true,
            toolPolicy: true,
            memoryPolicy: true,
            knowledgeManifest: true,
            promptFormatVersion: true,
        },
    });
    // The version the conversation names, whether or not it is still the
    // profile's current one. A conversation pinned to a superseded revision
    // runs that revision -- pinning that stops applying the moment the owner
    // edits the profile is not pinning, and §14's "소급 적용 금지, 이동은
    // 명시적 사용자 동작" says the move is the user's to make.
    //
    // This used to refuse, on the reasoning that running a replaced revision
    // answers under instructions the owner has edited away. The cost of that
    // reading was found in staging on 2026-08-25: publishing a revision left
    // every existing conversation on the old one silently without a profile.
    // Not the current version's instructions and not the pinned version's --
    // none at all, with the API and the picker still reporting the profile as
    // attached and running. Answering under the revision the conversation was
    // pinned to is the behaviour the owner can see and reason about; answering
    // under no profile while the screen says otherwise is not.
    //
    // Only "the row is gone" is left, which is a profile deleted out from
    // under the conversation (§G-1 covers what the conversation does then).
    if (!version) return refused("no_active_version");

    const modelIds = storedModelIds(version.models);
    const primaryModelId = modelIds[0];
    // Only when there is one to resolve. A version that names no model has no
    // model claim to check (§14.0a), and reading the catalogue to decide
    // nothing would be a query per turn for an answer that is already known.
    const model =
        primaryModelId === undefined
            ? undefined
            : (
                  await getRuntimeModels({ includeCatalogDeleted: true })
              ).find((entry) => entry.id === primaryModelId);
    const decision = decideProfileRuntime({
        isAuthenticated: true,
        profilesFlagEnabled: profilesEnabled,
        hasActiveVersion: true,
        namedModel:
            primaryModelId === undefined
                ? null
                : {
                      enabled: Boolean(model?.enabled) && !model?.catalogDeleted,
                      permittedByPlan: model
                          ? canUseModelWithPlan(input.plan ?? "Free", model)
                          : false,
                  },
        promptFormatVersion: version.promptFormatVersion,
    });
    if (!decision.allowed) return refused(decision.reason);

    const knowledgeFileIds = assistantKnowledgeUsable({
        profilesEnabled,
        knowledgeEnabled,
    })
        ? manifestFileIds(version.knowledgeManifest)
        : [];
    // The manifest is the candidate set and the query decides the rest: the
    // retrieval already restricts to this account's files that finished
    // processing, so a file deleted since publish simply returns nothing
    // rather than needing a second existence check here (§14).
    const selection = await retrieveKnowledgeContext({
        userId: input.userId,
        fileIds: knowledgeFileIds,
        query: input.query,
    });

    const tools = resolveProfileTools({
        toolPolicy: storedToolPolicy(version.toolPolicy),
        entitled: input.entitledTools,
    });
    const instructionsPrompt = buildProfileInstructionPrompt(
        version.instructions
    );
    const knowledgePrompt = buildProfileKnowledgePrompt(
        selection.chunks.map((chunk) => ({
            fileName: chunk.fileName,
            ordinal: chunk.ordinal,
            content: chunk.content,
        }))
    );

    return {
        version: {
            profileId: version.profileId,
            profileVersionId: version.id,
            revision: version.revision,
            modelIds,
            knowledgeFileIds: selection.fileIds,
        },
        refusal: null,
        instructionsPrompt,
        knowledgePrompt,
        // The blocks as sent, including their rules preambles, which are not
        // free -- the same reason the memory context counts its own.
        profileTokens:
            (instructionsPrompt ? estimatePromptTokens(instructionsPrompt) : 0) +
            (knowledgePrompt ? estimatePromptTokens(knowledgePrompt) : 0),
        profileVersion: `${version.id}:${version.revision}`,
        knowledgeHash: knowledgeContextHash({
            excerpts: selection.chunks,
            // The result's own version, not the constant: a selection made by
            // a different algorithm than the one this build ships would
            // otherwise be recorded under this build's number.
            retrievalVersion: selection.retrievalVersion,
        }),
        memoryPolicy: storedMemoryPolicy(version.memoryPolicy),
        tools,
        knowledgeChunkCount: selection.chunks.length,
    };
}
