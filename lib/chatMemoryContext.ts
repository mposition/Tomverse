import "server-only";

import { getMemoryExtractionRevokedPairs, isMemoryInjectionEnabled } from "@/lib/appSettings";
import {
    contextFingerprint,
    memoryStateFingerprint,
    type ContextBundleFingerprintInput,
} from "@/lib/chatContextBundleCore";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import {
    buildMemoryContextPrompt,
    MEMORY_CONTEXT_PROMPT_VERSION,
    type MemoryContextPrompt,
} from "@/lib/memoryContextPrompt";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "@/lib/memoryExtractionEvalRegister";
import {
    decideMemoryInjection,
    hasApprovedExtractionPair,
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
        profileVersion: null,
        retrievalHash: "",
        retrievalVersion: MEMORY_RETRIEVAL_ALGORITHM_VERSION,
        promptVersion: MEMORY_CONTEXT_PROMPT_VERSION,
    };
    return {
        decision,
        prompt: EMPTY_PROMPT,
        memoryTokens: 0,
        fingerprintInput,
        fingerprint: contextFingerprint(fingerprintInput),
        consideredCount: 0,
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
     * This conversation's memory mode. Callers that have no per-conversation
     * value pass the account default, which is what `UserMemorySettings`
     * already resolves.
     */
    conversationMode?: "on" | "off";
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
        // Anything that is not the stored "off" reads as on: the column is a
        // string, and an unreadable value must not silently disable a
        // control the user believes is on. "off" is the explicit choice.
        conversationMode:
            (input.conversationMode ?? settings.defaultConversationMode) ===
            "off"
                ? "off"
                : "on",
    });
    if (!decision.allowed) return buildEmpty(decision);

    const approvedPairs = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
        (entry) => entry.status === "approved"
    ).map((entry) => ({
        extractionModelId: entry.extractionModelId,
        promptVersion: entry.promptVersion,
    }));

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
    };
}
