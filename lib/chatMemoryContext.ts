import "server-only";

import { getMemoryExtractionRevokedPairs, isMemoryInjectionEnabled } from "@/lib/appSettings";
import { resolveProfileMemoryUse } from "@/lib/assistantProfileRuntime";
import type { AssistantMemoryPolicy } from "@/lib/assistantProfileVersioning";
import {
    contextFingerprint,
    memoryStateFingerprint,
    type ContextBundleFingerprintInput,
} from "@/lib/chatContextBundleCore";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { resolveConversationMemoryMode } from "@/lib/conversationMemoryMode";
import {
    buildMemoryContextPrompt,
    MEMORY_CONTEXT_PROMPT_VERSION,
    type MemoryContextPrompt,
} from "@/lib/memoryContextPrompt";
import {
    decideMemoryInjection,
    hasApprovedExtractionPair,
    injectableExtractionPairs,
    type MemoryInjectionDecision,
} from "@/lib/memoryInjectionGate";
import { MEMORY_RETRIEVAL_ALGORITHM_VERSION } from "@/lib/memoryRetrievalScoring";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { getMemorySettings } from "@/lib/memoryService";
import { STYLE_MEMORY_KINDS } from "@/lib/memoryValidatorCore";
import { prisma } from "@/lib/prisma";

/**
 * The one context builder preflight and `/api/chat` both use (policy §10).
 *
 * The policy requires it in those words — "preflight와 실제 chat은 동일한
 * context builder를 사용" — and the reason is not tidiness. Preflight prices a
 * prompt and reserves credits against it; chat sends one. Two builders that
 * agree today drift the first time one of them learns something the other did
 * not, and the user is charged for the difference. So the same function
 * answers both questions, and its output carries everything the §10 bundle
 * binds.
 *
 * It never decides admission, credit or concurrency. It answers exactly one
 * question — what memory context does this request have, and what is that
 * context's identity — and returns "none, because ..." rather than throwing
 * when the answer is nothing. Memory being unavailable is not an error: it is
 * the normal state of every request until §12.4's procedure has been
 * completed.
 */

export type ChatMemoryContext = {
    /** Why memory is or is not part of this request. */
    decision: MemoryInjectionDecision;
    /** The block to place in the system message, or null. */
    prompt: MemoryContextPrompt;
    /**
     * Input tokens the memory block contributes. Priced by preflight, booked
     * by chat, and included in the context-window check by both.
     */
    memoryTokens: number;
    fingerprintInput: ContextBundleFingerprintInput;
    /** The comparable value the §10 bundle carries and chat recomputes. */
    fingerprint: string;
    /** §22 observation, content-free. */
    consideredCount: number;
    /**
     * Whether the §9 budget cut a memory that had otherwise qualified — §22's
     * truncation ratio.
     *
     * Only the two size caps count. `below_relevance`, `expired` and
     * `duplicate` are the selection working as designed, and `source_cap` is a
     * diversity rule rather than a size one; reporting any of them as
     * truncation would say the context was too small for the request when it
     * was not.
     */
    truncatedByBudget: boolean;
};

/**
 * The empty context still has an identity.
 *
 * `memoryMode: "off"` is a *different* context, not an absent one (§10): a
 * request priced with memory and then run with the account toggle off must
 * fail the freshness check, and it only can if "off" is a value the
 * fingerprint carries.
 */
const EMPTY_PROMPT: MemoryContextPrompt = {
    promptVersion: MEMORY_CONTEXT_PROMPT_VERSION,
    text: null,
    usedCount: 0,
    factualCount: 0,
    styleCount: 0,
};

const buildEmpty = (decision: MemoryInjectionDecision): ChatMemoryContext => {
    const fingerprintInput: ContextBundleFingerprintInput = {
        memoryMode: "off",
        memoryVersion: memoryStateFingerprint({
            activeCount: 0,
            latestUpdatedAtMs: 0,
        }),
        styleVersion: memoryStateFingerprint({
            activeCount: 0,
            latestUpdatedAtMs: 0,
        }),
        // Both filled in by `buildChatTurnContext`, which is the only place
        // that knows whether a profile ran. A memory context on its own binds
        // no profile, and saying so with a value rather than leaving the field
        // out is what keeps "no profile" a context the bundle can compare.
        profileVersion: null,
        retrievalHash: "",
        retrievalVersion: MEMORY_RETRIEVAL_ALGORITHM_VERSION,
        promptVersion: MEMORY_CONTEXT_PROMPT_VERSION,
        knowledgeHash: "none",
    };
    return {
        decision,
        prompt: EMPTY_PROMPT,
        memoryTokens: 0,
        fingerprintInput,
        fingerprint: contextFingerprint(fingerprintInput),
        consideredCount: 0,
        truncatedByBudget: false,
    };
};

const stateVersion = async (userId: string, kinds?: readonly string[]) => {
    const aggregate = await prisma.memoryItem.aggregate({
        where: {
            userId,
            status: "active",
            ...(kinds ? { kind: { in: [...kinds] } } : {}),
        },
        _count: { _all: true },
        _max: { updatedAt: true },
    });
    return memoryStateFingerprint({
        activeCount: aggregate._count._all,
        latestUpdatedAtMs: aggregate._max.updatedAt?.getTime() ?? 0,
    });
};

export async function buildChatMemoryContext(input: {
    /** Null for a guest, who has no account memory to inject. */
    userId: string | null;
    /** The request text retrieval is scored against. */
    query: string;
    /**
     * The conversation's *stored* mode (§8.1 invariant 1), including
     * `inherit`. Resolution happens here rather than at the caller because
     * this is where the account default is already loaded, and one resolution
     * site is what keeps the two chat entry points from disagreeing.
     * Undefined for a request with no conversation, which inherits too.
     */
    conversationMode?: string | null;
    /**
     * Release C (§45). What the running profile version asked for, or null
     * when no profile ran.
     *
     * Applied through `resolveProfileMemoryUse` — the AND that lets a profile
     * turn memory off for its own conversations and never on — and applied
     * here rather than at the caller so the retrieval below is skipped
     * entirely. A profile that opted out should not pay for a query whose
     * result is discarded.
     */
    profileMemoryPolicy?: AssistantMemoryPolicy | null;
    now?: Date;
}): Promise<ChatMemoryContext> {
    if (!input.userId) {
        return buildEmpty({ allowed: false, reason: "guest" });
    }

    const [injectionFlagEnabled, revokedPairs, settings] = await Promise.all([
        isMemoryInjectionEnabled(),
        getMemoryExtractionRevokedPairs(),
        getMemorySettings(input.userId),
    ]);

    const decision = decideMemoryInjection({
        isAuthenticated: true,
        injectionFlagEnabled,
        hasApprovedExtractionPair: hasApprovedExtractionPair(revokedPairs),
        accountMasterEnabled: settings.masterEnabled,
        conversationMode: resolveConversationMemoryMode(
            input.conversationMode,
            settings.defaultConversationMode
        ),
    });
    if (!decision.allowed) return buildEmpty(decision);

    // §45's AND, in its one implementation. Ordered after the account gate on
    // purpose: `resolveProfileMemoryUse` takes the account's answer as an
    // input, so asking it first would mean deciding memory twice.
    if (
        input.profileMemoryPolicy &&
        !resolveProfileMemoryUse({
            memoryPolicy: input.profileMemoryPolicy,
            memoryAllowedByAccount: decision.allowed,
        })
    ) {
        return buildEmpty({ allowed: false, reason: "profile_off" });
    }

    // Approved *and* not revoked. Reading the register alone was a real gap:
    // revoking one pair while another stayed approved left the account-level
    // gate open, and this list — the query's actual filter — still admitted
    // the revoked pair's memories. §12.4 revokes a pair, not an account.
    const approvedPairs = injectableExtractionPairs(revokedPairs);

    const [retrieval, memoryVersion, styleVersion] = await Promise.all([
        retrieveMemoryContext({
            userId: input.userId,
            query: input.query,
            now: input.now,
            approvedPairs,
        }),
        stateVersion(input.userId),
        stateVersion(input.userId, STYLE_MEMORY_KINDS),
    ]);

    const prompt = buildMemoryContextPrompt(retrieval);
    const fingerprintInput: ContextBundleFingerprintInput = {
        // Still "on": the account permits memory even on a request where
        // retrieval happened to select nothing. Reporting "off" here would
        // make an empty selection indistinguishable from a disabled account,
        // and the two must price and re-check differently.
        memoryMode: "on",
        memoryVersion,
        styleVersion,
        profileVersion: null,
        retrievalHash: retrieval.resultHash,
        retrievalVersion: retrieval.algorithmVersion,
        promptVersion: prompt.promptVersion,
        knowledgeHash: "none",
    };

    return {
        decision,
        prompt,
        // The block is what is sent, so the block is what is counted --
        // including its rules preamble, which is not free.
        memoryTokens: prompt.text ? estimatePromptTokens(prompt.text) : 0,
        fingerprintInput,
        fingerprint: contextFingerprint(fingerprintInput),
        consideredCount: retrieval.consideredCount,
        truncatedByBudget:
            retrieval.omitted.token_budget + retrieval.omitted.item_cap > 0,
    };
}
