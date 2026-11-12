import "server-only";

import { buildProfileSystemPrompt } from "@/lib/assistantProfilePrompt";
import {
    profileRuntimeBinding,
    resolveProfileMemoryUse,
    type ProfileRuntimeBinding,
} from "@/lib/assistantProfileRuntime";
import type { AssistantToolPolicy } from "@/lib/assistantProfileVersioning";
import {
    contextFingerprint,
    type ContextBundleFingerprintInput,
} from "@/lib/chatContextBundleCore";
import {
    buildChatMemoryContext,
    type ChatMemoryContext,
} from "@/lib/chatMemoryContext";
import {
    buildChatProfileContext,
    NO_PROFILE_CONTEXT,
    type ChatProfileContext,
} from "@/lib/chatProfileContext";
import type { ModelTier } from "@/lib/models";
import { anySemanticRetrievalReady } from "@/lib/semanticRetrieval";
import type { SemanticCallMode } from "@/lib/semanticRetrievalCore";

/**
 * Policy: docs/policy/external-conversation-import-and-memory.md.
 * The one context builder preflight and `/api/chat` both use (§10, §9.1).
 *
 * `buildChatMemoryContext` used to be that builder, and still is for memory.
 * Release C added two more blocks to the same system message — a profile's
 * instructions and its retrieved knowledge — and they have to be priced by
 * whatever prices memory, for the reason §10 gives: preflight reserves credit
 * against a prompt and chat sends one, so a block only one of them knows about
 * is a block the user is charged wrongly for.
 *
 * ## The order is §9.1's, and it is one message
 *
 * Instructions, then memory, then knowledge, assembled by
 * `buildProfileSystemPrompt` into a single system message. Three messages
 * would leave their order to the provider, and not every provider keeps it.
 *
 * ## A profile narrows memory; it never widens it
 *
 * The profile's memory policy is applied here, through
 * `resolveProfileMemoryUse` — the AND, not a fallback. It is applied *before*
 * memory is retrieved rather than after, so a profile that opted out does not
 * quietly pay for a retrieval whose result is thrown away, and so the refusal
 * the caller reports (`profile_off`) is the same kind of fact as every other
 * memory refusal reason.
 */

export type ChatTurnContext = {
    memory: ChatMemoryContext;
    profile: ChatProfileContext;
    /** The §9.1 system message, or null when there is nothing to say. */
    systemPrompt: string | null;
    /** Priced by preflight, booked by chat. Zero when memory did not run. */
    memoryTokens: number;
    /** The profile's own blocks, counted apart from memory's. */
    profileTokens: number;
    /** Everything the §10 bundle binds. */
    fingerprintInput: ContextBundleFingerprintInput;
    fingerprint: string;
    /** Completed once memory use is known. Null when no profile ran. */
    binding: ProfileRuntimeBinding | null;
};

/** One mode for the whole turn, or one each for memory and knowledge. */
export type SemanticTurnMode =
    | SemanticCallMode
    | { memory: SemanticCallMode; knowledge: SemanticCallMode };

/**
 * The modes the verifying route may have to try, in order.
 *
 * A bundle does not say whether it was signed over a semantic selection or a
 * lexical one, and the shared cache cannot say it either: an issue that fell
 * back to lexical (the provider failed, the budget refused, the cache could
 * not be written) may be followed by another issue of the same question that
 * stored a ranking. So the bundle's own fingerprint decides. The cached
 * selection is tried first; if that is not what was signed, the lexical one
 * is, and then the two mixes, since memory and knowledge fall back
 * independently. None of these calls the provider.
 */
const VERIFYING_MODES: readonly SemanticTurnMode[] = [
    "cached_only",
    "off",
    { memory: "cached_only", knowledge: "off" },
    { memory: "off", knowledge: "cached_only" },
];

/**
 * Rebuilds a turn's context for the route that verifies a bundle, and returns
 * the build the bundle was signed over together with its verification.
 *
 * `build` is the route's own call to `buildChatTurnContext` with the mode
 * filled in; `verify` is its bundle check, run exactly once per build; and
 * `isStale` says whether a verification failed only because the fingerprint
 * differs -- the one failure another build can cure. When no build verifies,
 * the first build and its verification are returned, so the caller reports the
 * mismatch as it always did. While no retrieval switch is on there is exactly
 * one build and one check, as before.
 */
export async function rebuildTurnContextForBundle<Verification>(
    build: (semantic: SemanticTurnMode) => Promise<ChatTurnContext>,
    verify: (context: ChatTurnContext) => Verification,
    isStale: (verification: Verification) => boolean
): Promise<{ turnContext: ChatTurnContext; verification: Verification }> {
    const turnContext = await build(VERIFYING_MODES[0]);
    const verification = verify(turnContext);
    if (!isStale(verification) || !(await anySemanticRetrievalReady())) {
        return { turnContext, verification };
    }
    for (const mode of VERIFYING_MODES.slice(1)) {
        const candidate = await build(mode);
        const checked = verify(candidate);
        if (!isStale(checked)) return { turnContext: candidate, verification: checked };
    }
    return { turnContext, verification };
}

export async function buildChatTurnContext(input: {
    /** Null for a guest, who has neither account memory nor a profile. */
    userId: string | null;
    query: string;
    conversationMode?: string | null;
    /** The conversation's bound profile version, or null when it names none. */
    profileVersionId?: string | null;
    plan?: ModelTier | null;
    /** What the caller's plan already permits. A profile intersects with it. */
    entitledTools?: AssistantToolPolicy;
    now?: Date;
    /**
     * Whether semantic retrieval may call its provider on this build
     * (docs/policy/external-conversation-import-and-memory.md §9a).
     *
     * The routes that issue a context bundle leave this unset. The route that
     * verifies one and sends passes "cached_only": it reuses the outcome the
     * issuing route stored and otherwise stays lexical, so it reproduces the
     * signed selection whatever happened to the provider or the cache in
     * between, and the send path never waits on or pays that provider. It
     * does so through `rebuildTurnContextForBundle`, which supplies the mode.
     */
    semantic?: SemanticTurnMode;
}): Promise<ChatTurnContext> {
    const semantic =
        typeof input.semantic === "object"
            ? input.semantic
            : { memory: input.semantic, knowledge: input.semantic };
    const profile = input.profileVersionId
        ? await buildChatProfileContext({
              userId: input.userId,
              profileVersionId: input.profileVersionId,
              query: input.query,
              plan: input.plan ?? null,
              entitledTools:
                  input.entitledTools ?? { webSearch: true, deepResearch: true },
              semantic: semantic.knowledge,
          })
        : NO_PROFILE_CONTEXT;

    const memory = await buildChatMemoryContext({
        userId: input.userId,
        query: input.query,
        conversationMode: input.conversationMode,
        // Null when no profile ran, which leaves the account's own answer
        // untouched. A profile that never loaded must not be able to turn
        // memory off by absence.
        profileMemoryPolicy: profile.memoryPolicy,
        now: input.now,
        semantic: semantic.memory,
    });

    const systemPrompt = buildProfileSystemPrompt({
        instructions: profile.instructionsPrompt,
        memory: memory.prompt.text,
        knowledge: profile.knowledgePrompt,
    });

    const fingerprintInput: ContextBundleFingerprintInput = {
        ...memory.fingerprintInput,
        profileVersion: profile.profileVersion,
        knowledgeHash: profile.knowledgeHash,
    };

    return {
        memory,
        profile,
        systemPrompt,
        memoryTokens: memory.memoryTokens,
        profileTokens: profile.profileTokens,
        fingerprintInput,
        fingerprint: contextFingerprint(fingerprintInput),
        binding: profile.version
            ? profileRuntimeBinding({
                  ...profile.version,
                  // The resolved AND, not the request: a bundle that recorded
                  // what the profile asked for would verify against a later
                  // turn where the account had turned memory off.
                  memoryUsed: resolveProfileMemoryUse({
                      memoryPolicy: profile.memoryPolicy ?? {
                          useAccountMemory: false,
                      },
                      memoryAllowedByAccount: memory.decision.allowed,
                  }),
                  tools: profile.tools ?? {
                      webSearch: false,
                      deepResearch: false,
                  },
              })
            : null,
    };
}
