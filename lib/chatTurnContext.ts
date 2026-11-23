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
import { buildChatProjectContext, NO_PROJECT_CONTEXT, type ChatProjectContext } from "@/lib/chatProjectContext";
import { turnMemoryScope, type ProjectTurnScope } from "@/lib/projectWorkspaceCore";
import { prisma } from "@/lib/prisma";
import type { MemorySemanticContextInput } from "@/lib/memoryQueryPlan";
import type { SemanticStepsUsed } from "@/lib/chatContextBundleCore";
import type { SemanticCallMode, SemanticStepModes } from "@/lib/semanticRetrievalCore";

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
 * ## Instructions and data have separate roles
 *
 * Profile instructions, app-authored memory rules and knowledge retain their
 * system block. Memory statements go separately into the user-role prelude,
 * before native history and the current request, including Deep Research.
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
    /** Project workspace: instructions and material for this turn, or none. */
    project: ChatProjectContext;
    /** The §9.1 system message, or null when there is nothing to say. */
    systemPrompt: string | null;
    /** Priced by preflight, booked by chat. Zero when memory did not run. */
    memoryTokens: number;
    /** The profile's own blocks, counted apart from memory's. */
    profileTokens: number;
    /** The project's own blocks, counted apart from memory's and the profile's. */
    projectTokens: number;
    /** Everything the §10 bundle binds. */
    fingerprintInput: ContextBundleFingerprintInput;
    fingerprint: string;
    /** Completed once memory use is known. Null when no profile ran. */
    binding: ProfileRuntimeBinding | null;
    /**
     * Which semantic retrieval steps shaped this context (§9a). The issuing
     * route signs it into the bundle; the verifying route rebuilds with it.
     */
    semanticSteps: SemanticStepsUsed;
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
    /**
     * How semantic retrieval may run on this build
     * (docs/policy/external-conversation-import-and-memory.md §9a).
     *
     * The routes that issue a context bundle leave this unset, and the steps
     * that actually ran come back as `semanticSteps` to be signed. The route
     * that verifies one and sends passes `verifyingSemanticModes(steps)`:
     * every step the bundle used is reproduced from its stored outcome and
     * every other step is off, so it rebuilds exactly the signed selection,
     * and the send path never waits on or pays the retrieval provider.
     */
    semantic?: SemanticCallMode | SemanticStepModes;
    /** Memory-only server context; profile knowledge continues to use `query`. */
    memorySemanticContext?: MemorySemanticContextInput;
    /**
     * The conversation's project, as the server read it (never a request
     * field). Null for no project; a project with context off is a folder and
     * contributes nothing.
     */
    project?: ProjectTurnScope | null;
    /** Explicit project references the user picked for this question. */
    projectReferences?: readonly string[];
}): Promise<ChatTurnContext> {
    const semantic: SemanticStepModes =
        typeof input.semantic === "object"
            ? input.semantic
            : {
                  memoryRerank: input.semantic ?? "allow",
                  knowledgeNeighbours: input.semantic ?? "allow",
                  knowledgeRerank: input.semantic ?? "allow",
                  projectNeighbours: input.semantic ?? "allow",
                  projectRerank: input.semantic ?? "allow",
              };
    const profile = input.profileVersionId
        ? await buildChatProfileContext({
              userId: input.userId,
              profileVersionId: input.profileVersionId,
              query: input.query,
              plan: input.plan ?? null,
              entitledTools:
                  input.entitledTools ?? { webSearch: true, deepResearch: true },
              semantic: {
                  neighbours: semantic.knowledgeNeighbours,
                  rerank: semantic.knowledgeRerank,
              },
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
        semantic: semantic.memoryRerank,
        memorySemanticContext: input.memorySemanticContext,
        // A project with context on decides which stored memories are in
        // reach: its own, plus personal ones only when the owner chose that.
        scope: turnMemoryScope(input.project ?? null),
    });

    // The profile's own documents are not sent a second time as project material.
    const profileKnowledgeDigests = profile.version && profile.version.knowledgeFileIds.length && input.userId && input.project?.contextEnabled
        ? new Set((await prisma.assistantKnowledgeFile.findMany({
              where: { userId: input.userId, id: { in: profile.version.knowledgeFileIds } },
              select: { digest: true },
          })).map((row) => row.digest))
        : undefined;
    const project = input.project?.contextEnabled
        ? await buildChatProjectContext({
              userId: input.userId,
              project: input.project,
              query: input.query,
              profileKnowledgeDigests,
              references: input.projectReferences,
              semantic: {
                  neighbours: semantic.projectNeighbours ?? "off",
                  rerank: semantic.projectRerank ?? "off",
              },
          })
        : NO_PROJECT_CONTEXT;

    const systemPrompt = buildProfileSystemPrompt({
        // Profile instructions first, then the project's: both are owner-written.
        instructions: [profile.instructionsPrompt, project.instructionsPrompt]
            .filter((part): part is string => Boolean(part)).join("\n\n") || null,
        memory: memory.prompt.rules,
        knowledge: [profile.knowledgePrompt, project.materialPrompt]
            .filter((part): part is string => Boolean(part)).join("\n\n") || null,
    });

    const fingerprintInput: ContextBundleFingerprintInput = {
        ...memory.fingerprintInput,
        profileVersion: profile.profileVersion,
        knowledgeHash: profile.knowledgeHash,
        ...(project.projectHash !== "none" ? { projectHash: project.projectHash } : {}),
    };

    return {
        memory,
        profile,
        project,
        semanticSteps: {
            memoryRerank: memory.semanticRerank,
            knowledgeNeighbours: profile.knowledgeSemanticSteps.neighbours,
            knowledgeRerank: profile.knowledgeSemanticSteps.rerank,
            ...(project.semanticSteps.neighbours ? { projectNeighbours: true } : {}),
            ...(project.semanticSteps.rerank ? { projectRerank: true } : {}),
        },
        systemPrompt,
        memoryTokens: memory.memoryTokens,
        profileTokens: profile.profileTokens,
        projectTokens: project.projectTokens,
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
