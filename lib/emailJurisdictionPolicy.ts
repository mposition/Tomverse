import "server-only";

import { prisma } from "@/lib/prisma";
import {
  JURISDICTION_POLICY_SEED_SUMMARY,
  JURISDICTION_POLICY_SEED_VERSION,
  JURISDICTION_PROFILE_SEED,
  jurisdictionCountryMapSeed,
  jurisdictionSeedProblems,
} from "@/lib/emailJurisdictionSeed";

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
  const problems = jurisdictionSeedProblems();
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
