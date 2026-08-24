import "server-only";

import { canUseModelWithPlan, getModel, type ModelTier } from "@/lib/models";
import { parseStoredNewConversationModelIds } from "@/lib/newConversationModels";
import { prisma } from "@/lib/prisma";
import { suppressionCheck } from "@/lib/emailSuppression";
import {
    audienceExclusion,
    stillAffected,
    summariseAudience,
    type AudienceCohort,
    type AudienceMember,
    type AudienceSummary,
} from "@/lib/modelRetirementAudienceCore";

/**
 * Who a model retirement actually affects, read from the database.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.
 *
 * `lib/modelRetirementAudienceCore.ts` decides what the numbers mean; this
 * decides who is in them. Split because the rules are worth testing without a
 * database and the queries are worth testing with one, and because a cohort
 * definition that lives inside a query is a cohort definition nobody can read.
 *
 * Paged by user id, ascending, for the same reason the expansion pass is: this
 * feeds it, and a fan-out that cannot resume is a fan-out that must not start.
 */

export type AudienceCandidate = {
    userId: string;
    email: string | null;
    language: string | null;
    plan: string;
    accountStatus: string;
    accountDeletionScheduledFor: Date | null;
    cohorts: AudienceCohort[];
    malformed: boolean;
};

/**
 * Whether a conversation's stored selection really names the model.
 *
 * `selectedModels` is a JSON string in a `String` column, so the database can
 * only offer a substring match. That is a prefilter, not an answer: searching
 * for `gpt-5` matches every row that selected `gpt-5-4-mini`, and a retirement
 * notice sent on that basis would reach people whose model is not going
 * anywhere. The array is parsed and compared element by element.
 */
const selectionNames = (raw: string, modelId: string): boolean => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }
    return Array.isArray(parsed) && parsed.some((entry) => entry === modelId);
};

/**
 * One page of people the retiring model *might* affect.
 *
 * The three cohorts are asked for in one query so a person appears once, and
 * the `OR` is what makes this the audience rather than the whole user table: an
 * account with no link to the model is never read, so the cost is the size of
 * the audience and not the size of the product.
 *
 * It is a prefilter, not the answer. `selectedModels` is a JSON array inside a
 * `String` column, so the only condition the database can offer is a substring
 * match, and a search for `gpt-5-4-mini` also returns rows that selected
 * `gpt-5-4-mini-preview`. Membership is `cohorts.length > 0` on the returned
 * rows -- `stillAffected()` in the core says the same thing.
 *
 * Non-members are returned rather than dropped so the caller's cursor advances
 * past them. Filtering here would let a page of nothing but near-misses look
 * like the end of the audience.
 */
/**
 * Turns raw rows into candidates, deciding each person's cohorts.
 *
 * Shared by the two ways this is asked. The audience query returns people who
 * *are* affected; a reminder asks about people who *were*, and has to be told
 * when the answer is now "none" -- so it needs the same computation over a list
 * that includes people with no cohort left.
 */
const candidatesFrom = (
    rows: readonly CandidateRow[],
    targetModelId: string,
    selectedBy: ReadonlySet<string>
): AudienceCandidate[] =>
    rows.map((row) => {
        const cohorts: AudienceCohort[] = [];
        if (row.settings?.defaultModel === targetModelId) {
            cohorts.push("default_model");
        }

        const stored = parseStoredNewConversationModelIds(
            row.settings?.newConversationModelIds
        );
        if (stored.modelIds?.includes(targetModelId)) {
            cohorts.push("new_conversation_lead");
        }

        if (selectedBy.has(row.id)) cohorts.push("conversation_selection");

        return {
            userId: row.id,
            email: row.email,
            language: row.settings?.language ?? null,
            plan: row.plan,
            accountStatus: row.accountStatus,
            accountDeletionScheduledFor: row.accountDeletionScheduledFor,
            cohorts,
            malformed: stored.malformed,
        };
    });

type CandidateRow = {
    id: string;
    email: string | null;
    plan: string;
    accountStatus: string;
    accountDeletionScheduledFor: Date | null;
    settings: {
        language: string;
        defaultModel: string;
        newConversationModelIds: unknown;
    } | null;
};

const CANDIDATE_SELECT = {
    id: true,
    email: true,
    plan: true,
    accountStatus: true,
    accountDeletionScheduledFor: true,
    settings: {
        select: {
            language: true,
            defaultModel: true,
            newConversationModelIds: true,
        },
    },
} as const;

/**
 * Which of these people have a conversation that really names the model.
 *
 * Asked once for the whole page rather than per person: the substring prefilter
 * has to be checked against the parsed array anyway, and doing that one user at
 * a time turns a page into N round trips.
 */
const selectionsAmong = async (
    userIds: readonly string[],
    targetModelId: string
): Promise<Set<string>> => {
    const conversations = await prisma.conversation.findMany({
        where: {
            userId: { in: [...userIds] },
            selectedModels: { contains: targetModelId },
        },
        select: { userId: true, selectedModels: true },
    });
    const selectedBy = new Set<string>();
    for (const conversation of conversations) {
        if (selectionNames(conversation.selectedModels, targetModelId)) {
            selectedBy.add(conversation.userId);
        }
    }
    return selectedBy;
};

/**
 * One page of people the retiring model *might* affect.
 *
 * The three cohorts are asked for in one query so a person appears once, and
 * the `OR` is what makes this the audience rather than the whole user table: an
 * account with no link to the model is never read, so the cost is the size of
 * the audience and not the size of the product.
 *
 * It is a prefilter, not the answer. `selectedModels` is a JSON array inside a
 * `String` column, so the only condition the database can offer is a substring
 * match, and a search for `gpt-5-4-mini` also returns rows that selected
 * `gpt-5-4-mini-preview`. Membership is `cohorts.length > 0` on the returned
 * rows -- `stillAffected()` in the core says the same thing.
 *
 * Non-members are returned rather than dropped so the caller's cursor advances
 * past them. Filtering here would let a page of nothing but near-misses look
 * like the end of the audience.
 */
export const audienceCandidatePage = async (input: {
    targetModelId: string;
    after: string | null;
    take: number;
}): Promise<AudienceCandidate[]> => {
    const rows = await prisma.user.findMany({
        where: {
            ...(input.after ? { id: { gt: input.after } } : {}),
            OR: [
                { settings: { defaultModel: input.targetModelId } },
                {
                    settings: {
                        newConversationModelIds: {
                            array_contains: [input.targetModelId],
                        },
                    },
                },
                {
                    conversations: {
                        some: { selectedModels: { contains: input.targetModelId } },
                    },
                },
            ],
        },
        orderBy: { id: "asc" },
        take: input.take,
        select: CANDIDATE_SELECT,
    });

    if (rows.length === 0) return [];
    return candidatesFrom(
        rows,
        input.targetModelId,
        await selectionsAmong(
            rows.map((row) => row.id),
            input.targetModelId
        )
    );
};

/**
 * The same computation over people named explicitly, including ones the
 * audience query would no longer return.
 *
 * This is what makes `already_changed` observable. A reminder that re-ran the
 * audience query would simply not see the person who took the first notice's
 * advice, and "not seen" and "no longer affected" would be the same silence.
 */
export const audienceCandidatesByIds = async (input: {
    targetModelId: string;
    userIds: readonly string[];
}): Promise<AudienceCandidate[]> => {
    if (input.userIds.length === 0) return [];
    const rows = await prisma.user.findMany({
        where: { id: { in: [...input.userIds] } },
        orderBy: { id: "asc" },
        select: CANDIDATE_SELECT,
    });
    if (rows.length === 0) return [];
    return candidatesFrom(
        rows,
        input.targetModelId,
        await selectionsAmong(
            rows.map((row) => row.id),
            input.targetModelId
        )
    );
};

/**
 * Rows per cohort, before de-duplication.
 *
 * Reported beside the distinct counts because the gap between them is the
 * whole point of §11: a number sized from rows is not the number of people who
 * will receive anything, and the two being printed together is what makes that
 * visible rather than arguable.
 */
export const audienceCohortRows = async (
    targetModelId: string
): Promise<Record<AudienceCohort, number>> => {
    const [defaultModel, leads, conversations] = await Promise.all([
        prisma.userSettings.count({ where: { defaultModel: targetModelId } }),
        prisma.userSettings.count({
            where: {
                newConversationModelIds: { array_contains: [targetModelId] },
            },
        }),
        prisma.conversation.findMany({
            where: { selectedModels: { contains: targetModelId } },
            select: { selectedModels: true },
        }),
    ]);

    return {
        default_model: defaultModel,
        new_conversation_lead: leads,
        conversation_selection: conversations.filter((row) =>
            selectionNames(row.selectedModels, targetModelId)
        ).length,
    };
};

/**
 * Whether the replacement is reachable on this account's plan.
 *
 * An unknown replacement is not usable. Answering "yes, they can reach it"
 * about a model the catalogue does not describe would put an unfounded promise
 * in the notice, and §13.3 condition 4 is one of the twelve the automatic
 * transition sentence depends on.
 */
const planAllowsReplacement = (plan: string, replacementModelId: string) => {
    const replacement = getModel(replacementModelId);
    if (!replacement) return false;
    return canUseModelWithPlan(plan as ModelTier, replacement);
};

const accountActive = (candidate: AudienceCandidate) =>
    candidate.accountStatus === "active" &&
    candidate.accountDeletionScheduledFor === null;

/**
 * Turns one page of candidates into audience members, asking the suppression
 * list about each address.
 *
 * `purpose` is passed so a purpose-scoped suppression counts: somebody who
 * unsubscribed from lifecycle mail specifically is suppressed for this send
 * even though they are not suppressed globally.
 */
export const audienceMembersFor = async (input: {
    candidates: readonly AudienceCandidate[];
    replacementModelId: string;
    purpose?: string | null;
    classification: Parameters<typeof suppressionCheck>[0]["classification"];
}): Promise<AudienceMember[]> =>
    Promise.all(
        input.candidates.map(async (candidate) => {
            // `allowed: false` is the suppression answer for this send's own
            // classification, which is the question being asked -- a hard
            // bounce stops even legal mail, while a complaint does not stop
            // transactional. Reading a generic "is this address suppressed"
            // instead would give the wrong answer for both.
            const suppressed = candidate.email
                ? !(
                      await suppressionCheck({
                          emailAddress: candidate.email,
                          classification: input.classification,
                          ...(input.purpose === undefined
                              ? {}
                              : { purpose: input.purpose }),
                      })
                  ).allowed
                : false;

            return {
                userId: candidate.userId,
                cohorts: candidate.cohorts,
                hasEmail: Boolean(candidate.email),
                accountActive: accountActive(candidate),
                suppressed,
                planAllowsReplacement: planAllowsReplacement(
                    candidate.plan,
                    input.replacementModelId
                ),
                malformed: candidate.malformed,
            };
        })
    );

export const audienceExclusionFor = audienceExclusion;

/**
 * The whole audience, counted.
 *
 * Reads every page rather than sampling, because the number this produces is
 * quoted to a person deciding whether to send. `pageSize` exists for tests and
 * for an operator bounding a first look, not as a sampling knob -- a partial
 * count reported as a total is exactly the confidence §11 warns about.
 */
export const summariseRetirementAudience = async (input: {
    targetModelId: string;
    replacementModelId: string;
    purpose?: string | null;
    classification: Parameters<typeof suppressionCheck>[0]["classification"];
    pageSize?: number;
}): Promise<AudienceSummary> => {
    const take = input.pageSize ?? 200;
    const members: AudienceMember[] = [];
    let after: string | null = null;

    for (;;) {
        const page: AudienceCandidate[] = await audienceCandidatePage({
            targetModelId: input.targetModelId,
            after,
            take,
        });
        if (page.length === 0) break;
        members.push(
            ...(await audienceMembersFor({
                // The prefilter's near-misses are read so the cursor can pass
                // them, and are not part of the count.
                candidates: page.filter((candidate) => stillAffected(candidate)),
                replacementModelId: input.replacementModelId,
                ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                classification: input.classification,
            }))
        );
        after = page[page.length - 1].userId;
        if (page.length < take) break;
    }

    return summariseAudience(members, await audienceCohortRows(input.targetModelId));
};

export type { AudienceSummary };
