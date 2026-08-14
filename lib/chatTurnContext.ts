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

/**
 * The one context builder preflight and `/api/chat` both use (§10, §31, §32).
 *
 * `buildChatMemoryContext` used to be that builder, and still is for memory.
 * Release C added two more blocks to the same system message — a profile's
 * instructions and its retrieved knowledge — and they have to be priced by
 * whatever prices memory, for the reason §10 gives: preflight reserves credit
 * against a prompt and chat sends one, so a block only one of them knows about
 * is a block the user is charged wrongly for.
 *
 * ## The order is §31's, and it is one message
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
    /** The §31 system message, or null when there is nothing to say. */
    systemPrompt: string | null;
    /** Priced by preflight, booked by chat. Zero when memory did not run. */
    memoryTokens: number;
    /** The profile's own blocks, counted apart from memory's. */
    profileTokens: number;
    /** Everything the §32 bundle binds. */
    fingerprintInput: ContextBundleFingerprintInput;
    fingerprint: string;
    /** Completed once memory use is known. Null when no profile ran. */
    binding: ProfileRuntimeBinding | null;
};

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
}): Promise<ChatTurnContext> {
    const profile = input.profileVersionId
        ? await buildChatProfileContext({
              userId: input.userId,
              profileVersionId: input.profileVersionId,
              query: input.query,
              plan: input.plan ?? null,
              entitledTools:
                  input.entitledTools ?? { webSearch: true, deepResearch: true },
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
