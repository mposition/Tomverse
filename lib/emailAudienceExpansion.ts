import "server-only";

import type { Prisma } from "@prisma/client";

import { appUrl } from "@/lib/accountEmails";
import {
  emailTemplateDefinition,
  POLICY_CHANGE_NOTICE_EFFECTIVE_DATE,
  POLICY_CHANGE_NOTICE_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { isPolicyChangeNoticeWordingApproved } from "@/lib/policyChangeNoticeEmail";
import { isEmailMarketingEnabled } from "@/lib/appSettings";
import {
  CHANGE_NOTICE_APPROVED_CONTENT_HASHES,
  isEmailReleaseNotesLiveForEnqueue,
} from "@/lib/emailPolicyPublication";
import {
  CHANGE_NOTICE_WINDOW_DAYS,
  TOLD_STATUSES,
} from "@/lib/emailPolicyPublicationCore";
import {
  marketingFlagApplies,
  releaseNotesFlagApplies,
} from "@/lib/emailFeatureFlags";
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
  NOTICE_SENT_IN_FLIGHT_DAYS,
  policyChangeNoticePairingProblem,
  readExpansionSpec,
  type AudienceCohortSpec,
  type ExpansionRefusalReason,
  type ExpansionResult,
} from "@/lib/emailAudienceExpansionCore";
import {
  audienceCandidatePage,
  audienceCandidatesByIds,
  audienceMembersFor,
  type AudienceCandidate,
} from "@/lib/modelRetirementAudience";
import {
  recipientVerdict,
  waveRecomputesCohorts,
  type CampaignExcludedReason,
} from "@/lib/emailCampaignRecipientCore";
import { audienceExclusion } from "@/lib/modelRetirementAudienceCore";
import {
  recordEnqueueDecision,
  releaseNotesEnqueueDecision,
} from "@/lib/releaseNotesEnqueueDecision";
import { releaseNotesAudienceWhere } from "@/lib/releaseNotesAudience";
import type { SendClassification } from "@/lib/emailSuppressionCore";
import { deliveryContentForLanguage } from "@/lib/emailCampaignContentCore";

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
 * What the campaign ledger records about one person, decided before any row is
 * written.
 *
 * Present only for a cohort audience. A wave that named its recipients
 * explicitly has no cohort attribution to record, and writing a guessed
 * `eligibilityReason` would put a made-up reason in an audit record -- the
 * ledger's whole purpose is to be the place that does not do that.
 */
type LedgerVerdict = {
  cohort: string | null;
  excludedReason: CampaignExcludedReason | null;
  malformed: boolean;
};

type ExpansionCandidate = {
  id: string;
  email: string | null;
  language: string | null;
  ledger: LedgerVerdict | null;
  /**
   * False for a row the audience prefilter returned and the cohort rules then
   * rejected. Kept in the page so the cursor still advances past them; written
   * nowhere, because the honest record of somebody who is not in the campaign
   * is no record.
   */
  inAudience: boolean;
};

/**
 * The wave this event belongs to, if any.
 *
 * Found through the event rather than passed in, so `expandEmailEvent` keeps
 * one caller-facing shape: belonging to a campaign is a property of the event,
 * not an argument the caller has to remember to supply.
 */
const waveForEvent = (eventId: string) =>
  prisma.emailCampaignWave.findFirst({
    where: { eventId },
    select: { id: true, campaignId: true, kind: true },
  });

/**
 * The accounts an amendment notice wave writes to.
 *
 * The publication gate's own owed set and evidence window
 * (lib/emailPolicyPublication.ts `noticeFactsFor`): an account created before
 * the effective day, or with no creation time, that holds no approved notice
 * that arrived (a told state with a recorded arrival, as the gate reads it) or
 * is still on its way (`NOTICE_SENT_IN_FLIGHT_DAYS`). Every wave asks afresh, so a second wave
 * reaches accounts created since the first and the ones whose notice did not
 * arrive, and nobody is written to twice. The audience estimate counts the same
 * condition, so the number an approver reads is the one the wave expands.
 */
export const policyChangeNoticeAudienceWhere = (
  effectiveDate: string,
  now: Date
): Prisma.UserWhereInput => {
  const effective = new Date(`${effectiveDate}T00:00:00.000Z`);
  const windowStart = new Date(
    effective.getTime() - CHANGE_NOTICE_WINDOW_DAYS * 86_400_000
  );
  return {
    AND: [
      { OR: [{ createdAt: null }, { createdAt: { lt: effective } }] },
      {
        emailDeliveries: {
          none: {
            createdAt: { gte: windowStart },
            OR: [
              { status: "pending" },
              {
                status: "sent",
                sentAt: {
                  gte: new Date(now.getTime() - NOTICE_SENT_IN_FLIGHT_DAYS * 86_400_000),
                },
              },
              { status: { in: [...TOLD_STATUSES] }, deliveredAt: { not: null } },
            ],
            templateVersion: {
              contentHash: { in: [...CHANGE_NOTICE_APPROVED_CONTENT_HASHES] },
              template: { key: POLICY_CHANGE_NOTICE_TEMPLATE },
            },
          },
        },
      },
    ],
  };
};

/**
 * Who a cohort wave looks at next.
 *
 * A first notice asks the audience query. A reminder asks the people the
 * campaign already wrote to, because the answer it needs is about them -- and
 * one of the possible answers is "this person is no longer affected", which the
 * audience query expresses by not returning them at all.
 */
const cohortCandidates = async (input: {
  cohort: AudienceCohortSpec;
  campaignId: string;
  recomputes: boolean;
  after: string | null;
  take: number;
  /**
   * The template's own classification and purpose, not this function's guess.
   * Suppression answers differently for each -- a complaint stops marketing and
   * does not stop transactional -- so asking under the wrong one produces an
   * exclusion list that is right about a send nobody is making.
   */
  classification: SendClassification;
  purpose: string | null;
  /** The version the expansion pins, which scopes the approvals that count. */
  policyVersionId: string;
}): Promise<ExpansionCandidate[]> => {
  if (input.cohort.kind === "marketing_consent") {
    // The candidate condition the estimate reads too
    // (lib/releaseNotesAudience.ts): confirmed consent, or a sealed
    // `risk_accepted` approval. The second half is the population section 5.6
    // exists for, and a query on consent alone could never reach it.
    const audience = await releaseNotesAudienceWhere({
      purpose: input.cohort.purpose,
      policyVersionId: input.policyVersionId,
    });
    const rows = await prisma.user.findMany({
      where: {
        AND: [audience, ...(input.after ? [{ id: { gt: input.after } }] : [])],
      },
      orderBy: { id: "asc" },
      take: input.take,
      select: {
        id: true,
        email: true,
        settings: { select: { language: true } },
      },
    });
    return rows.map((candidate) => ({
      id: candidate.id,
      email: candidate.email,
      language: candidate.settings?.language ?? null,
      ledger: {
        cohort: "marketing_consent",
        excludedReason: candidate.email ? null : "no_email",
        malformed: false,
      },
      inAudience: true,
    }));
  }

  if (input.cohort.kind === "policy_change_notice") {
    const rows = await prisma.user.findMany({
      where: {
        AND: [
          policyChangeNoticeAudienceWhere(input.cohort.effectiveDate, new Date()),
          ...(input.after ? [{ id: { gt: input.after } }] : []),
        ],
      },
      orderBy: { id: "asc" },
      take: input.take,
      select: {
        id: true,
        email: true,
        settings: { select: { language: true } },
      },
    });
    // No ledger. The recipient ledger's cohort names are a closed CHECK, and
    // this cohort's record is the delivery row itself, which outlives the
    // account and is what the gate counts. An account with no address gets no
    // row, and the gate already counts it as unreachable.
    return rows.map((candidate) => ({
      id: candidate.id,
      email: candidate.email,
      language: candidate.settings?.language ?? null,
      ledger: null,
      inAudience: true,
    }));
  }

  const candidates = input.recomputes
    ? await audienceCandidatesByIds({
        targetModelId: input.cohort.targetModelId,
        userIds: (
          await prisma.emailCampaignRecipient.findMany({
            where: {
              campaignId: input.campaignId,
              excludedReason: null,
              ...(input.after ? { userId: { gt: input.after } } : {}),
            },
            orderBy: { userId: "asc" },
            take: input.take,
            distinct: ["userId"],
            select: { userId: true },
          })
        ).map((row) => row.userId),
      })
    : await audienceCandidatePage({
        targetModelId: input.cohort.targetModelId,
        after: input.after,
        take: input.take,
      });

  const members = await audienceMembersFor({
    candidates,
    replacementModelId: input.cohort.replacementModelId,
    classification: input.classification,
    purpose: input.purpose,
  });

  return candidates.map((candidate: AudienceCandidate, index: number) => {
    const verdict = recipientVerdict({
      cohorts: candidate.cohorts,
      exclusion: audienceExclusion(members[index]),
      malformed: candidate.malformed,
      recomputesCohorts: input.recomputes,
    });
    return {
      id: candidate.userId,
      email: candidate.email,
      language: candidate.language,
      // A person the prefilter returned and the cohort rules rejected gets no
      // ledger row and no delivery. Keeping them in the page still advances
      // the cursor past a substring near-match.
      ledger:
        verdict.outcome === "not_in_audience"
          ? null
          : {
              cohort: verdict.cohort ?? null,
              excludedReason:
                verdict.outcome === "exclude" ? verdict.excludedReason : null,
              malformed: verdict.malformed,
            },
      inAudience: verdict.outcome !== "not_in_audience",
    };
  });
};

/**
 * Writes one ledger entry, once.
 *
 * `skipDuplicates` on `(waveId, userId)` is what makes a resumed pass harmless
 * here, the same way the delivery index does for the outbox: re-covering ground
 * is the ordinary case, and the first pass's verdict is the one that stands --
 * re-deciding on the second pass would let a person's recorded reason change
 * because the run crashed, which is not a fact about the person.
 */
const recordLedgerEntry = async (input: {
  wave: { id: string; campaignId: string };
  userId: string;
  email: string | null;
  language: string | null;
  jurisdictionCountry: string | null;
  ledger: LedgerVerdict;
  deliveryId: string | null;
}) => {
  await prisma.emailCampaignRecipient.createMany({
    data: [
      {
        campaignId: input.wave.campaignId,
        waveId: input.wave.id,
        userId: input.userId,
        emailAddress: input.email,
        language: input.language,
        jurisdictionCountry: input.jurisdictionCountry,
        eligibilityReason: input.ledger.cohort,
        excludedReason: input.ledger.excludedReason,
        deliveryId: input.deliveryId,
        malformed: input.ledger.malformed,
      },
    ],
    skipDuplicates: true,
  });
};

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

  const spec = readExpansionSpec(event.audienceSpec);
  const refusal = expansionRefusal({
    audienceKind: event.audienceKind,
    status: event.status,
    spec,
  });
  if (refusal) return { refused: refusal };

  // The notice and its cohort, both ways, before anything is written. The
  // cohort reaches people who turned every email off, and the notice to any
  // other audience would leave out accounts the gate then waits on; a draft
  // checks this, and an event stored before that check or written another way
  // must stop here instead.
  const noticePairing = policyChangeNoticePairingProblem({
    templateKey: event.template.key,
    noticeTemplateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
    noticeEffectiveDate: POLICY_CHANGE_NOTICE_EFFECTIVE_DATE,
    spec,
  });
  if (noticePairing) {
    await reportOperationalIncident({
      code: "EMAIL_NOTICE_AUDIENCE_MISMATCH",
      title: "An amendment notice fan-out was refused before writing anything",
      error: noticePairing,
      severity: "error",
      context: {
        component: "email-audience-expansion",
        eventId: event.id,
        templateKey: event.template.key,
      },
    });
    return { refused: "notice_audience_mismatch" };
  }
  const noticeEffectiveDate =
    spec.cohort?.kind === "policy_change_notice" ? spec.cohort.effectiveDate : null;

  // Before the event is moved to `expanding` and before a single row is
  // written. A fan-out that started and then found the feature off would leave
  // an event mid-expansion and a partial audience already queued.
  const definitionForFlag = emailTemplateDefinition(event.template.key);
  if (
    marketingFlagApplies(definitionForFlag.classification) &&
    !(await isEmailMarketingEnabled())
  ) {
    return { refused: "marketing_disabled" };
  }
  // The product own switch, for the same reason and in the same place: a
  // fan-out that started and then found release notes off would leave an event
  // mid-expansion and a partial audience already queued.
  if (
    releaseNotesFlagApplies(definitionForFlag.purpose) &&
    !(await isEmailReleaseNotesLiveForEnqueue())
  ) {
    return { refused: "release_notes_disabled" };
  }

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

  const wave = await waveForEvent(event.id);
  // Only a campaign wave re-asks the audience question, and only the later
  // waves do. The first notice's audience is the query that produced it.
  const recomputesCohorts =
    spec.cohort?.kind === "model_retirement" && wave
      ? waveRecomputesCohorts(wave.kind)
      : false;

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

      const candidates: ExpansionCandidate[] = spec.cohort
        ? await cohortCandidates({
            cohort: spec.cohort,
            campaignId: wave?.campaignId ?? "",
            recomputes: recomputesCohorts,
            after: result.cursor,
            take: plan.take,
            classification: definition.classification,
            purpose: definition.purpose ?? null,
            policyVersionId,
          })
        : (
            await nextCandidates({
              ...(spec.userIds ? { userIds: spec.userIds } : {}),
              after: result.cursor,
              take: plan.take,
            })
          ).map((candidate) => ({
            id: candidate.id,
            email: candidate.email,
            language: candidate.settings?.language ?? null,
            ledger: null,
            inAudience: true,
          }));
      if (candidates.length === 0) {
        result.status = "expanded";
        break;
      }

      for (const candidate of candidates) {
        if (!candidate.inAudience) continue;

        // Excluded by the audience rules -- suppressed, on a plan the
        // replacement does not reach, or no longer affected at all. The ledger
        // is the only place this is written down, because there will be no
        // delivery row for the lane to record a reason on.
        if (wave && candidate.ledger?.excludedReason) {
          await recordLedgerEntry({
            wave,
            userId: candidate.id,
            email: candidate.email,
            language: null,
            jurisdictionCountry: null,
            ledger: candidate.ledger,
            deliveryId: null,
          });
          result.skipped += 1;
          continue;
        }

        if (!candidate.email) {
          // No address, so there is no row to write and nothing for the lane's
          // gates to record a reason on. Counted, never invented.
          if (wave && candidate.ledger) {
            await recordLedgerEntry({
              wave,
              userId: candidate.id,
              email: null,
              language: null,
              jurisdictionCountry: null,
              ledger: { ...candidate.ledger, excludedReason: "no_email" },
              deliveryId: null,
            });
          }
          result.skipped += 1;
          continue;
        }
        const preferredLanguage = isLanguage(candidate.language)
          ? candidate.language
          : "en";
        const deliveryContent = deliveryContentForLanguage(
          event.payload,
          preferredLanguage
        );
        const language = isLanguage(deliveryContent.language)
          ? deliveryContent.language
          : "en";
        // The amendment notice fans out only in approved wording
        // (lib/policyChangeNoticeEmail.ts). Thrown, so the wave stops rather than
        // queueing some recipients under wording nobody approved.
        if (
          event.template.key === POLICY_CHANGE_NOTICE_TEMPLATE &&
          !isPolicyChangeNoticeWordingApproved(language, appUrl())
        ) {
          throw new Error("The amendment notice's wording is not approved; the wave cannot expand.");
        }
        const template = await ensureTemplateVersion({
          templateKey: event.template.key,
          language,
        });
        // Pinned per recipient at expansion, for the same reason the enqueue
        // path pins it: activating a policy version mid-fan-out must not change
        // what a row already written renders under.
        const resolved = await jurisdictionForUser({ userId: candidate.id });

        // The section 7.6 pin, per recipient, exactly as the single-message
        // enqueue path does it. A fanned-out row without one is not a row with a
        // missing column: at send, a pin that cannot be confirmed is the same
        // refusal as one that no longer matches, so every message in the
        // campaign would be skipped as `display_contract_changed` on its first
        // drain. The audience would receive nothing and the record would say
        // their duties had moved.
        const releaseNotes = releaseNotesFlagApplies(definition.purpose)
          ? await releaseNotesEnqueueDecision({
              userId: candidate.id,
              purpose: definition.purpose as string,
              classification: definition.classification,
              emailAddress: candidate.email,
              policyVersionId,
              templateVersionId: template.templateVersionId,
            })
          : null;

        // The row and its enqueue snapshot in one transaction, as the
        // single-message path has them. Two transactions lost the snapshot for
        // good whenever the second failed: the row was already committed and
        // `pending`, the drain took it, and a resumed pass found the insert
        // swallowed by `skipDuplicates` and had no row id to record against --
        // so the first of section 7.6's two snapshots was simply never written
        // for that recipient.
        // Captured here, where the null check above has narrowed it; a closure
        // does not keep that narrowing.
        const emailAddress = candidate.email;
        const written = await prisma.$transaction(async (tx) => {
          if (noticeEffectiveDate) {
            // One notice per account across every wave and campaign. The page
            // query ran outside this transaction, so a second wave expanding
            // at the same moment could have read the same account; the lock
            // makes the two take turns, and the re-read after it sees whatever
            // the other one committed. Keyed by account, not by event, because
            // the event's own unique index cannot see another event's row.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`policy-change-notice:${candidate.id}`}))`;
            const stillOwed = await tx.user.count({
              where: {
                AND: [
                  { id: candidate.id },
                  policyChangeNoticeAudienceWhere(noticeEffectiveDate, new Date()),
                ],
              },
            });
            if (stillOwed === 0) return [];
          }
          const rows = await tx.emailDelivery.createManyAndReturn({
            select: { id: true },
            data: [
              {
                eventId: event.id,
                userId: candidate.id,
                recipientKey: recipientKeyFor(candidate.id),
                lane: "standard",
                emailAddress,
                language,
                // The contract's own profile for a release-notes row, for the same
                // reason as the single-message path: the hash names it and the send
                // renders from the pin.
                jurisdictionCountry:
                  releaseNotes?.displayProfile?.countryCode ?? resolved?.countryCode ?? "ZZ",
                jurisdictionProfileKey:
                  releaseNotes?.displayProfile?.profileKey ?? resolved?.profileKey ?? "ZZ",
                policyVersionId,
                templateVersionId: template.templateVersionId,
                ...(releaseNotes
                  ? { displayContractHash: releaseNotes.displayContractHash }
                  : {}),
                idempotencyKey: `${event.id}:${recipientKeyFor(candidate.id)}`,
                // A dry run writes the same rows and marks them, so it answers
                // the question a dry run is asked. `dry_run` is already in the
                // skipReason CHECK and nothing has ever written it.
                ...(spec.dryRun
                  ? { status: "skipped", skipReason: "dry_run", nextAttemptAt: null }
                  : { status: "pending", nextAttemptAt: new Date() }),
                attempts: 0,
                renderDataSnapshot: encryptSnapshot(
                  deliveryContent.payload,
                  snapshotKeyring()
                ) as Prisma.InputJsonValue,
              },
            ],
            // The unique index decides duplicates. A resumed pass re-covering
            // ground is the ordinary case, not an error.
            skipDuplicates: true,
          });
          // Only for a row this pass wrote. A resumed pass that finds the insert
          // swallowed finds the snapshot too, because both committed together.
          const [row] = rows;
          if (row && releaseNotes) {
            await recordEnqueueDecision(tx, {
              decision: releaseNotes,
              deliveryId: row.id,
              userId: candidate.id,
              purpose: definition.purpose as string,
              classification: definition.classification,
            });
          }
          return rows;
        });

        if (written.length === 1) {
          result.expanded += 1;
          expandedSoFar += 1;
        } else {
          result.alreadyPresent += 1;
        }

        if (wave && candidate.ledger) {
          await recordLedgerEntry({
            wave,
            userId: candidate.id,
            email: candidate.email,
            language,
            // The country the row pinned, so the wave ledger and the delivery
            // cannot name different countries for one recipient.
            jurisdictionCountry:
              releaseNotes?.displayProfile?.countryCode ?? resolved?.countryCode ?? "ZZ",
            ledger: candidate.ledger,
            // Looked up only when this pass did not write the row, which is
            // the resumed case. The ordinary path already has the id.
            deliveryId:
              written[0]?.id ??
              (
                await prisma.emailDelivery.findUnique({
                  where: {
                    // Generation 0: the fan-out writes roots. A replacement
                    // is written by the re-enqueue path with its own
                    // generation, and looking one up here would find a message
                    // this pass did not write.
                    eventId_recipientKey_generation: {
                      eventId: event.id,
                      recipientKey: recipientKeyFor(candidate.id),
                      generation: 0,
                    },
                  },
                  select: { id: true },
                })
              )?.id ??
              null,
          });
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
