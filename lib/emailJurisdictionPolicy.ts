import { parseQuietHours } from "@/lib/emailQuietHoursCore";
import "server-only";

import { prisma } from "@/lib/prisma";
import {
  JURISDICTION_POLICY_SEED_SUMMARY,
  JURISDICTION_POLICY_SEED_VERSION,
  JURISDICTION_PROFILE_SEED,
  jurisdictionCountryMapSeed,
  jurisdictionSeedProblems,
} from "@/lib/emailJurisdictionSeed";
import {
  releaseNotesCountryRuleSeed,
  releaseNotesRuleKey,
  releaseNotesRuleSeedProblems,
} from "@/lib/releaseNotesCountryRuleCore";
import { releaseNotesRuleVersionConflicts } from "@/lib/releaseNotesCountryRules";
import {
  releaseNotesObligationSeed,
  releaseNotesObligationSeedProblems,
} from "@/lib/releaseNotesObligationCore";
import { releaseNotesRuleKey as obligationRuleKey } from "@/lib/releaseNotesCountryRuleCore";

/**
 * Policy versions: creating a draft, reading one, and activating one.
 *
 * Contract: docs/policy/email-notifications.md §12.5.
 *
 * ## Nothing here activates on its own
 *
 * `ensureJurisdictionPolicyDraft` creates a **draft** and stops. There is no
 * "seed and activate", no `activateIfNone`, and no bootstrap path that turns a
 * draft on because none was active -- every one of those would be this code
 * approving a legal policy on a human's behalf. Activation has its own
 * function, it takes an actor, and the route that calls it is behind
 * two-person approval.
 *
 * That is also why the seed is not applied at startup or by a migration. A
 * migration that inserted an active version would make the approval a
 * formality performed after the fact.
 *
 * ## Activation is atomic and does not reach into flight
 *
 * Promoting a version supersedes the previous one in the same transaction, so
 * there is never a moment with two active rows or none. Deliveries already
 * holding a `policyVersionId` keep it: their rendered bytes were hashed under
 * that version and their idempotency key promises the provider the same
 * payload on a retry. A version change that reached into them would break both.
 */

export class JurisdictionPolicyError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "JurisdictionPolicyError";
    this.code = code;
    this.status = status;
  }
}

export type PolicyVersionSummary = {
  id: string;
  version: string;
  status: string;
  changeSummary: string;
  activatedAt: string | null;
  supersededAt: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  createdAt: string;
  profileCount: number;
  countryCount: number;
};

const toSummary = (row: {
  id: string;
  version: string;
  status: string;
  changeSummary: string;
  activatedAt: Date | null;
  supersededAt: Date | null;
  approvedByEmail: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  _count: { profiles: number; countryMap: number };
}): PolicyVersionSummary => ({
  id: row.id,
  version: row.version,
  status: row.status,
  changeSummary: row.changeSummary,
  activatedAt: row.activatedAt?.toISOString() ?? null,
  supersededAt: row.supersededAt?.toISOString() ?? null,
  approvedByEmail: row.approvedByEmail,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  profileCount: row._count.profiles,
  countryCount: row._count.countryMap,
});

export async function listPolicyVersions(limit = 20) {
  const rows = await prisma.emailPolicyVersion.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: { _count: { select: { profiles: true, countryMap: true } } },
  });
  return rows.map(toSummary);
}

export async function readPolicyVersion(versionId: string) {
  const row = await prisma.emailPolicyVersion.findUnique({
    where: { id: versionId },
    include: {
      _count: { select: { profiles: true, countryMap: true } },
      profiles: { orderBy: { profileKey: "asc" } },
      countryMap: { orderBy: { countryCode: "asc" } },
    },
  });
  if (!row) return null;

  return {
    ...toSummary(row),
    profiles: row.profiles.map((profile) => ({
      profileKey: profile.profileKey,
      marketingBasis: profile.marketingBasis,
      subjectPrefix: profile.subjectPrefix,
      footerBlocks: profile.footerBlocks,
      unsubscribeSlaBusinessDays: profile.unsubscribeSlaBusinessDays,
      consentNoticeIntervalMonths: profile.consentNoticeIntervalMonths,
      quietHours: profile.quietHours,
      impliedConsentDays: profile.impliedConsentDays,
      // The sources and confirmation dates §12.5 requires beside each field.
      notes: profile.notes,
      countries: row.countryMap
        .filter((entry) => entry.profileKey === profile.profileKey)
        .map((entry) => entry.countryCode),
    })),
  };
}

export async function readActivePolicyVersion() {
  const row = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  return row ? readPolicyVersion(row.id) : null;
}

/**
 * Create the seeded jurisdiction policy as a draft, or return the existing one.
 *
 * Idempotent by version string: calling it twice produces one row, and calling
 * it after the version has been activated returns that row rather than making a
 * second copy. It never edits a version that is no longer a draft -- an active
 * policy is what some delivery was rendered under, and editing it in place
 * would rewrite what was true at send time.
 */
export async function ensureJurisdictionPolicyDraft(input?: {
  version?: string;
  changeSummary?: string;
}) {
  const problems = [
    ...jurisdictionSeedProblems(),
    ...releaseNotesRuleSeedProblems(),
    ...releaseNotesObligationSeedProblems(),
  ];
  if (problems.length > 0) {
    throw new JurisdictionPolicyError(
      "JURISDICTION_SEED_INVALID",
      `The jurisdiction seed is not usable: ${problems.join("; ")}`,
      500
    );
  }

  const version = input?.version?.trim() || JURISDICTION_POLICY_SEED_VERSION;
  const changeSummary =
    input?.changeSummary?.trim() || JURISDICTION_POLICY_SEED_SUMMARY;

  const existing = await prisma.emailPolicyVersion.findUnique({
    where: { version },
    include: { _count: { select: { profiles: true, countryMap: true } } },
  });
  if (existing) {
    return { created: false as const, version: toSummary(existing) };
  }

  const countryMap = jurisdictionCountryMapSeed();

  const created = await prisma.$transaction(async (tx) => {
    const policyVersion = await tx.emailPolicyVersion.create({
      data: { version, status: "draft", changeSummary },
    });
    await tx.jurisdictionProfile.createMany({
      data: JURISDICTION_PROFILE_SEED.map((profile) => ({
        policyVersionId: policyVersion.id,
        profileKey: profile.profileKey,
        marketingBasis: profile.marketingBasis,
        subjectPrefix: profile.subjectPrefix,
        footerBlocks: profile.footerBlocks,
        unsubscribeSlaBusinessDays: profile.unsubscribeSlaBusinessDays,
        consentNoticeIntervalMonths: profile.consentNoticeIntervalMonths,
        quietHours: profile.quietHours ?? undefined,
        impliedConsentDays: profile.impliedConsentDays ?? undefined,
        notes: profile.notes,
      })),
    });
    await tx.jurisdictionCountryMap.createMany({
      data: countryMap.map((row) => ({
        policyVersionId: policyVersion.id,
        countryCode: row.countryCode,
        profileKey: row.profileKey,
      })),
    });
    // The recipient authority per country (docs/policy/email-notifications.md
    // section 5.1.1). Written with the draft, like the profiles, so a version
    // is activated with the rules it was reviewed with; the table refuses a
    // write to any version that is no longer a draft.
    //
    // The content goes in `ReleaseNotesRuleVersion`, once per (key, version),
    // where it can never change -- an obligation waiver is scoped to that pair.
    // `skipDuplicates` because a later policy version carrying the same rule
    // version must find the row already there and leave it alone; the row's own
    // trigger refuses an edit, so a seed that disagreed with a stored rule
    // version would be a silent no-op here. That is what
    // `releaseNotesRuleVersionConflicts()` is checked for below.
    const rules = releaseNotesCountryRuleSeed();
    await tx.releaseNotesRuleVersion.createMany({
      data: rules.map((rule) => ({
        ruleKey: releaseNotesRuleKey(rule.countryCode),
        ruleVersion: rule.ruleVersion,
        countryCode: rule.countryCode,
        basis: rule.basis,
        status: rule.status,
        releaseConditions: [...rule.releaseConditions],
        activationGates: [...rule.activationGates],
      })),
      skipDuplicates: true,
    });
    const conflicts = await releaseNotesRuleVersionConflicts(tx, rules);
    if (conflicts.length > 0) {
      throw new JurisdictionPolicyError(
        "RELEASE_NOTES_RULE_VERSION_CONFLICT",
        `The seed disagrees with a stored rule version: ${conflicts.join("; ")}. ` +
          "A different content is a new rule version.",
        500
      );
    }
    await tx.releaseNotesCountryRule.createMany({
      data: rules.map((rule) => ({
        policyVersionId: policyVersion.id,
        countryCode: rule.countryCode,
        ruleKey: releaseNotesRuleKey(rule.countryCode),
        ruleVersion: rule.ruleVersion,
        notes: rule.notes,
      })),
    });
    // The duty states that are settled without anybody deciding anything --
    // the ones a readiness check confirms (draft section 7.8). A waiver is not
    // among them: an approval is a person's act, so a duty the owner decided
    // not to do stays unsettled here until that approval exists, and its rule
    // does not send. That is what an undecided duty is supposed to do.
    //
    // Keyed on the rule version, so a later policy version carrying the same
    // rule version finds the states already there.
    const ruleVersionOf = new Map(rules.map((rule) => [rule.countryCode, rule.ruleVersion]));
    await tx.releaseNotesRuleObligation.createMany({
      data: releaseNotesObligationSeed()
        .filter((duty) => ruleVersionOf.has(duty.countryCode))
        .map((duty) => ({
          ruleKey: obligationRuleKey(duty.countryCode),
          ruleVersion: ruleVersionOf.get(duty.countryCode)!,
          obligationKey: duty.obligationKey,
          state: duty.state,
          readinessCheck: duty.readinessCheck,
          dueBy: duty.dueByIso === null ? null : new Date(duty.dueByIso),
          warnDaysBefore: duty.warnDaysBefore,
          notes: duty.notes,
        })),
      skipDuplicates: true,
    });
    return tx.emailPolicyVersion.findUniqueOrThrow({
      where: { id: policyVersion.id },
      include: { _count: { select: { profiles: true, countryMap: true } } },
    });
  });

  return { created: true as const, version: toSummary(created) };
}

/**
 * Promote a draft to active, superseding whatever was active before it.
 *
 * The caller is responsible for the two-person approval (§12.3); this function
 * is the atomic half, and it records who the approval was consumed by so the
 * row itself says who turned it on rather than only the audit log.
 */
export async function activatePolicyVersion(input: {
  versionId: string;
  actorId: string;
  actorEmail: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const target = await tx.emailPolicyVersion.findUnique({
      where: { id: input.versionId },
      include: { _count: { select: { profiles: true, countryMap: true } } },
    });
    if (!target) {
      throw new JurisdictionPolicyError(
        "POLICY_VERSION_NOT_FOUND",
        "No such policy version.",
        404
      );
    }
    if (target.status === "active") {
      throw new JurisdictionPolicyError(
        "POLICY_VERSION_ALREADY_ACTIVE",
        "That version is already the active one."
      );
    }
    if (target.status !== "draft") {
      // A superseded version is history. Reactivating it would leave two rows
      // claiming to describe the same period, and the audit question "what was
      // active on the 14th" would stop having one answer.
      throw new JurisdictionPolicyError(
        "POLICY_VERSION_NOT_DRAFT",
        "Only a draft can be activated. Create a new version instead of reusing a superseded one."
      );
    }
    if (target._count.profiles === 0) {
      throw new JurisdictionPolicyError(
        "POLICY_VERSION_EMPTY",
        "That version has no jurisdiction profiles, so activating it would leave every send without one."
      );
    }
    // A night-time window the send lane cannot read would hold every marketing
    // message for that profile. Refused here, so an unreadable window can never
    // be the one a delivery is pinned to.
    const windows = await tx.jurisdictionProfile.findMany({
      where: { policyVersionId: input.versionId },
      select: { profileKey: true, quietHours: true },
    });
    const unreadable = windows.filter((row) => parseQuietHours(row.quietHours) === "invalid");
    if (unreadable.length > 0) {
      throw new JurisdictionPolicyError(
        "POLICY_VERSION_QUIET_HOURS_INVALID",
        `Quiet hours cannot be read for ${unreadable.map((row) => row.profileKey).join(", ")}.`
      );
    }

    const previous = await tx.emailPolicyVersion.findFirst({
      where: { status: "active" },
      select: { id: true, version: true },
    });
    if (previous) {
      await tx.emailPolicyVersion.update({
        where: { id: previous.id },
        data: { status: "superseded", supersededAt: now },
      });
    }

    const activated = await tx.emailPolicyVersion.update({
      where: { id: target.id },
      data: {
        status: "active",
        activatedAt: now,
        approvedById: input.actorId,
        approvedByEmail: input.actorEmail,
        approvedAt: now,
      },
      include: { _count: { select: { profiles: true, countryMap: true } } },
    });

    return {
      version: toSummary(activated),
      supersededVersion: previous?.version ?? null,
    };
  });
}
