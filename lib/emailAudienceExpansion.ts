import "server-only";

import type { Prisma } from "@prisma/client";

import { emailTemplateDefinition } from "@/lib/emailTemplateDefinitions";
import { encryptSnapshot, readSnapshotKeyring } from "@/lib/emailSnapshotCrypto";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import { isLanguage } from "@/lib/language";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  EXPANSION_BATCH_SIZE,
  expansionRefusal,
  nextBatchPlan,
  readExpansionSpec,
  type ExpansionRefusalReason,
  type ExpansionResult,
} from "@/lib/emailAudienceExpansionCore";

/**
 * One event, many deliveries, resumably (EM-01).
 *
 * Contract: docs/policy/email-notifications.md §10.2,
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-01, §12.3, §12.4.
 *
 * ## What this does not do
 *
 * It does not decide who the audience is, and it does not schedule anything.
 * The spec arrives on the event; computing it is the caller's, and the campaign
 * workflow that owns approval and scheduling is a layer above this one.
 *
 * ## Why every recipient gets a row, including ones that will not be sent to
 *
 * The lane's own gates -- consent, suppression, jurisdiction -- already skip a
 * row and record why on it. Filtering those people out here instead would make
 * the send cheaper and the question "who did this actually reach, and why not
 * the rest" unanswerable from the table that is supposed to answer it. The one
 * exception is an account with no address: there is no row to write.
 *
 * ## Why this is safe to run twice
 *
 * `@@unique([eventId, recipientKey])` is what stops a second row, not any check
 * here. A pass that died halfway leaves `expanding` and a cursor; the next pass
 * resumes from the cursor, and anything it re-covers collides harmlessly.
 */

const recipientKeyFor = (userId: string) => `user:${userId}`;

/**
 * The same refusal the enqueue path makes, for the same reason: this lane
 * stores the personalisation inputs a message was rendered from, and storing
 * them unencrypted is not an option it offers.
 */
const snapshotKeyring = () => {
  const keyring = readSnapshotKeyring(process.env);
  if (!keyring) {
    throw new Error(
      "EMAIL_SNAPSHOT_KEYS is not configured, so a fan-out cannot store what " +
        "each message will be rendered from."
    );
  }
  return keyring;
};

type Candidate = {
  id: string;
  email: string | null;
  settings: { language: string | null } | null;
};

/**
 * The next page of the audience, ordered by id so a cursor means something.
 *
 * `user_segment` reads the ids the spec names; `all_users` reads everybody.
 * Both are the same query shape, which is what keeps the cursor logic single.
 */
const nextCandidates = async (input: {
  userIds?: readonly string[];
  after: string | null;
  take: number;
}): Promise<Candidate[]> =>
  prisma.user.findMany({
    where: {
      ...(input.userIds ? { id: { in: [...input.userIds] } } : {}),
      ...(input.after ? { id: { gt: input.after } } : {}),
    },
    orderBy: { id: "asc" },
    take: input.take,
    select: {
      id: true,
      email: true,
      settings: { select: { language: true } },
    },
  });

/**
 * What one expansion pass returns.
 *
 * Written out rather than inferred: TypeScript normalises a union of two object
 * literals by giving each member the other's keys as `?: undefined`, so
 * `"refused" in result` then narrows to `Detail | undefined` and every caller
 * has to re-check something the function already decided.
 */
export type ExpansionOutcome =
  | ExpansionResult
  | { refused: ExpansionRefusalReason };

/**
 * Expands one event into delivery rows.
 *
 * Returns what this pass did rather than what the event now totals: a resumed
 * pass that wrote nothing because everything was already there is a different
 * fact from a pass that found nobody, and only one of them is a problem.
 */
export async function expandEmailEvent(input: {
  eventId: string;
  /** Overrides the spec's cap, for an operator running a bounded first pass. */
  recipientCap?: number;
  batchSize?: number;
  /** Wall-clock budget, so a pass inside a cron cannot run past its tick. */
  timeBudgetMs?: number;
}): Promise<ExpansionOutcome> {
  const event = await prisma.emailEvent.findUnique({
    where: { id: input.eventId },
    select: {
      id: true,
      templateId: true,
      audienceKind: true,
      audienceSpec: true,
      status: true,
      expansionCursor: true,
      payload: true,
      template: { select: { key: true } },
    },
  });
  if (!event) return { refused: "not_found" };

  const refusal = expansionRefusal({
    audienceKind: event.audienceKind,
    status: event.status,
  });
  if (refusal) return { refused: refusal };

  const spec = readExpansionSpec(event.audienceSpec);
  const cap = input.recipientCap ?? spec.recipientCap;
  const deadline = Date.now() + (input.timeBudgetMs ?? 60_000);

  // Resolved once, outside every transaction, for the same reason the enqueue
  // path resolves them there: both may insert, and neither belongs inside a
  // batch that is holding rows for two hundred people.
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const definition = emailTemplateDefinition(event.template.key);

  await prisma.emailEvent.update({
    where: { id: event.id },
    data: { status: "expanding" },
  });

  const result: ExpansionResult = {
    expanded: 0,
    skipped: 0,
    alreadyPresent: 0,
    status: "expanding",
    capReached: false,
    cursor: event.expansionCursor,
  };

  // Counted from the table, not from this pass: a resumed run has to respect a
  // cap the run before it was already spending.
  let expandedSoFar = await prisma.emailDelivery.count({
    where: { eventId: event.id },
  });

  try {
    for (;;) {
      const plan = nextBatchPlan({
        expandedSoFar,
        ...(cap === undefined ? {} : { recipientCap: cap }),
        batchSize: input.batchSize ?? EXPANSION_BATCH_SIZE,
      });
      if (plan.capReached) {
        result.capReached = true;
        break;
      }

      const candidates = await nextCandidates({
        ...(spec.userIds ? { userIds: spec.userIds } : {}),
        after: result.cursor,
        take: plan.take,
      });
      if (candidates.length === 0) {
        result.status = "expanded";
        break;
      }

      for (const candidate of candidates) {
        if (!candidate.email) {
          // No address, so there is no row to write and nothing for the lane's
          // gates to record a reason on. Counted, never invented.
          result.skipped += 1;
          continue;
        }
        const language = isLanguage(candidate.settings?.language)
          ? candidate.settings.language
          : "en";
        const template = await ensureTemplateVersion({
          templateKey: event.template.key,
          language,
        });
        // Pinned per recipient at expansion, for the same reason the enqueue
        // path pins it: activating a policy version mid-fan-out must not change
        // what a row already written renders under.
        const resolved = await jurisdictionForUser({ userId: candidate.id });

        const written = await prisma.emailDelivery.createMany({
          data: [
            {
              eventId: event.id,
              userId: candidate.id,
              recipientKey: recipientKeyFor(candidate.id),
              lane: "standard",
              emailAddress: candidate.email,
              language,
              jurisdictionCountry: resolved?.countryCode ?? "ZZ",
              jurisdictionProfileKey: resolved?.profileKey ?? "ZZ",
              policyVersionId,
              templateVersionId: template.templateVersionId,
              idempotencyKey: `${event.id}:${recipientKeyFor(candidate.id)}`,
              // A dry run writes the same rows and marks them, so it answers
              // the question a dry run is asked. `dry_run` is already in the
              // skipReason CHECK and nothing has ever written it.
              ...(spec.dryRun
                ? { status: "skipped", skipReason: "dry_run", nextAttemptAt: null }
                : { status: "pending", nextAttemptAt: new Date() }),
              attempts: 0,
              renderDataSnapshot: encryptSnapshot(
                event.payload,
                snapshotKeyring()
              ) as Prisma.InputJsonValue,
            },
          ],
          // The unique index decides duplicates. A resumed pass re-covering
          // ground is the ordinary case, not an error.
          skipDuplicates: true,
        });

        if (written.count === 1) {
          result.expanded += 1;
          expandedSoFar += 1;
        } else {
          result.alreadyPresent += 1;
        }
      }

      // Cursor last, and in the same statement as nothing else: it is only
      // allowed to move once every row before it exists.
      result.cursor = candidates[candidates.length - 1].id;
      await prisma.emailEvent.update({
        where: { id: event.id },
        data: { expansionCursor: result.cursor },
      });

      // Checked after a batch rather than before one, so every pass makes
      // progress. Checked first, a budget smaller than one batch takes -- a
      // slow database, a large batch size, a tick that was already late --
      // would leave the fan-out advancing zero rows on every run, forever, and
      // reporting success each time.
      if (Date.now() >= deadline) break;
    }
  } catch (error) {
    await prisma.emailEvent.update({
      where: { id: event.id },
      data: { status: "failed" },
    });
    await reportOperationalIncident({
      code: "EMAIL_AUDIENCE_EXPANSION_FAILED",
      title: "A fan-out stopped partway and did not finish",
      error,
      severity: "error",
      context: {
        component: "email-audience-expansion",
        eventId: event.id,
        templateKey: event.template.key,
        classification: definition.classification,
        expanded: result.expanded,
        // The cursor is the resume point, so it is the one value somebody
        // fixing this needs.
        cursor: result.cursor ?? "start",
      },
    });
    return { ...result, status: "failed" };
  }

  await prisma.emailEvent.update({
    where: { id: event.id },
    data: {
      status: result.status === "expanded" ? "expanded" : "expanding",
      expansionCursor: result.cursor,
    },
  });
  return result;
}
