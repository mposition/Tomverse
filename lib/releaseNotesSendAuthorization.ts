import "server-only";

import { prisma } from "@/lib/prisma";
import { isEmailMarketingEnabled, isEmailReleaseNotesEnabled } from "@/lib/appSettings";
import { footerDisclosureReadiness } from "@/lib/emailFooterDisclosureReadiness";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { EMAIL_ADDRESS_NORMALIZATION_VERSION } from "@/lib/emailSuppressionCore";
import { subjectLabelReadiness } from "@/lib/emailSubjectLabelReadiness";
import { unsubscribeKeyringReadiness } from "@/lib/emailUnsubscribeReadiness";
import { VerdictUnavailableError } from "@/lib/releaseNotesVerdictRetryCore";
import {
  composeDisplayContract,
  displayContractHash,
} from "@/lib/releaseNotesDisplayContractCore";
import {
  displayRequirementsFor,
  profilesForCountries,
} from "@/lib/releaseNotesDisplayRequirements";
import {
  releaseNotesSendVerdict,
  type SendVerdict,
} from "@/lib/releaseNotesSendVerdictCore";
import type { StoredObligation, WaiverApproval } from "@/lib/releaseNotesObligationCore";
import type { ReleaseNotesRuleForVerdict } from "@/lib/releaseNotesCountryRuleCore";

/**
 * The rows one send verdict rests on, read once and handed to the pure function.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
 *
 * ## Why the loading is its own file
 *
 * Section 7.6 asks for one verdict shared by the audience estimate, the audience
 * expansion, the writer and the drain, and the only way four callers can share a
 * decision is if the deciding reads nothing for itself. So
 * `releaseNotesSendVerdict()` takes facts and this supplies them. The split is
 * also what makes the decision testable without a database and this testable
 * without re-deciding anything.
 *
 * ## Every read is one failure
 *
 * A database that cannot answer is not a refusal. Section 7.6's last bullet says
 * so and invariant 11 is the reason: the drain's default is to turn an
 * unexpected error into a permanent `failed`, which would retire a message the
 * law allows over a connection reset. Every read here is wrapped, and the only
 * thing that leaves this module on a database failure is `VerdictUnavailableError`
 * -- which the drain releases the claim for and retries.
 *
 * It is deliberately not selective about which reads matter. A verdict assembled
 * from some of its rows is not a cheaper verdict; it is a different one.
 *
 * ## Which countries
 *
 * Section 5.3: the resolved country, or every high-confidence country when they
 * disagree, and each of them has to allow. A person with no resolvable country
 * is `ZZ`, which the pure verdict refuses and which no override crosses.
 *
 * Derived from `jurisdictionForUser()` -- the same call the drain already makes
 * -- rather than from a persisted candidate list, because the list S4 will
 * persist does not exist yet and inventing a second source of the same fact is
 * how two answers to one question start.
 */

export type SendAuthorizationInput = {
  userId: string | null;
  purpose: string;
  /** The address this send would go to, as a digest, for the cohort comparison. */
  deliveryAddressDigest: string | null;
  currentAddressDigest: string | null;
  /** The policy version the message is pinned to, or null to use the active one. */
  pinnedPolicyVersionId: string | null;
  /** The contract the message was rendered to, or null at enqueue. */
  pinnedDisplayContractHash: string | null;
  /**
   * The template version the message is rendered by, which the contract carries.
   *
   * The same obligations rendered by a different template are a different
   * message, so section 7.6 puts this inside the hash.
   */
  templateVersionId: string;
  /**
   * Whether this address carries a live suppression cause for this purpose.
   *
   * The one recipient fact the caller supplies, because the caller has already
   * asked: the lane runs `suppressionCheck()` before anything else, and asking
   * again here would be a second answer to a question already answered a few
   * lines above. The consent and the objection are read here, where every other
   * row the verdict rests on is read.
   */
  suppressed: boolean;
  /** The address as the permission ledger stores it, for the objection lookup. */
  normalizedAddress: string;
  phase: "enqueue" | "send";
  now: Date;
};

/** Anything that throws while reading becomes the one error the drain retries. */
const read = async <T>(what: string, load: () => Promise<T>): Promise<T> => {
  try {
    return await load();
  } catch (error) {
    throw new VerdictUnavailableError(
      `${what} could not be read, so nothing was decided`,
      { cause: error }
    );
  }
};

/**
 * The candidate countries, per section 5.3.
 *
 * Every high-confidence country when they disagree, because each of them has to
 * allow; the resolved one otherwise. An empty list is `ZZ` to the pure verdict,
 * which is what a person with no resolvable country is.
 */
const candidateCountries = (jurisdiction: {
  countryCode: string;
  confidence: string;
  conflicts: string[];
}): string[] => {
  if (jurisdiction.conflicts.length > 0) return [...new Set(jurisdiction.conflicts)].sort();
  if (jurisdiction.confidence === "none" || jurisdiction.countryCode === "ZZ") return [];
  return [jurisdiction.countryCode];
};

export async function releaseNotesSendAuthorization(
  input: SendAuthorizationInput
): Promise<SendVerdict> {
  // Not a database failure when there is genuinely no active version, and
  // raised as unavailable anyway: a message waiting while an operator activates
  // the next version should wait, not be refused permanently by a rule set
  // nobody has published. `read()` turns it into the error the drain retries.
  const policyVersionId =
    input.pinnedPolicyVersionId ??
    (await read("the active policy version", async () => {
      const active = await prisma.emailPolicyVersion.findFirst({
        where: { status: "active" },
        select: { id: true },
      });
      if (!active) throw new Error("no policy version is active");
      return active.id;
    }));

  const jurisdiction =
    input.userId === null
      ? null
      : await read("the recipient's jurisdiction", () =>
          jurisdictionForUser({ userId: input.userId as string })
        );
  const countries = jurisdiction === null ? [] : candidateCountries(jurisdiction);

  const ruleRows = await read("the country rules", () =>
    prisma.releaseNotesCountryRule.findMany({
      where: { policyVersionId, countryCode: { in: countries } },
      select: {
        id: true,
        countryCode: true,
        ruleKey: true,
        ruleVersion: true,
        rule: { select: { basis: true, status: true } },
      },
    })
  );
  const rules: ReleaseNotesRuleForVerdict[] = ruleRows.map((row) => ({
    countryCode: row.countryCode,
    ruleKey: row.ruleKey,
    ruleVersion: row.ruleVersion,
    basis: row.rule.basis as ReleaseNotesRuleForVerdict["basis"],
    status: row.rule.status as ReleaseNotesRuleForVerdict["status"],
  }));

  const obligationRows = await read("the duty states", () =>
    prisma.releaseNotesRuleObligation.findMany({
      where: { countryRuleId: { in: ruleRows.map((row) => row.id) } },
      select: {
        countryRuleId: true,
        obligationKey: true,
        state: true,
        readinessCheck: true,
        dueBy: true,
        warnDaysBefore: true,
        waiverApprovalId: true,
      },
    })
  );
  const countryOf = new Map(ruleRows.map((row) => [row.id, row.countryCode]));
  const obligations: Record<string, StoredObligation[]> = {};
  for (const row of obligationRows) {
    const country = countryOf.get(row.countryRuleId);
    if (country === undefined) continue;
    (obligations[country] ??= []).push({
      obligationKey: row.obligationKey,
      state: row.state as StoredObligation["state"],
      readinessCheck: row.readinessCheck,
      dueBy: row.dueBy,
      warnDaysBefore: row.warnDaysBefore,
      waiverApprovalId: row.waiverApprovalId,
    });
  }

  const waiverIds = obligationRows
    .map((row) => row.waiverApprovalId)
    .filter((id): id is string => id !== null);
  const waivers: WaiverApproval[] =
    waiverIds.length === 0
      ? []
      : await read("the waiver approvals", async () =>
          (
            await prisma.emailSendApproval.findMany({
              where: { id: { in: waiverIds } },
              select: {
                id: true,
                approvalType: true,
                sealedAt: true,
                policyVersionId: true,
                ruleKey: true,
                ruleVersion: true,
                country: true,
                obligationKey: true,
                revocations: { select: { id: true }, take: 1 },
              },
            })
          ).map((row) => ({
            id: row.id,
            approvalType: row.approvalType as WaiverApproval["approvalType"],
            sealedAt: row.sealedAt,
            revoked: row.revocations.length > 0,
            policyVersionId: row.policyVersionId,
            ruleKey: row.ruleKey,
            ruleVersion: row.ruleVersion,
            country: row.country,
            obligationKey: row.obligationKey,
          }))
        );

  // The three checks the duty seed names, asked once each. A check that cannot
  // answer is a read that failed, not a duty that is unsettled -- the same
  // distinction the whole module is about.
  const readiness = await read("the readiness checks", async () => {
    const [footer, subject] = await Promise.all([
      footerDisclosureReadiness(),
      subjectLabelReadiness(),
    ]);
    return {
      emailFooterDisclosures: footer.disclosuresPresent,
      emailSubjectLabels: subject.labelsPresent,
      emailUnsubscribeKeyring: unsubscribeKeyringReadiness().ready,
    };
  });

  // By address, not by account. Consent attaches to a mailbox
  // (docs/policy/email-notifications.md section 13.4), and an objection
  // survives the account that made it -- so an address reused by a new account
  // carries the refusal the previous holder made from the same mailbox.
  const objected = await read("the objection", async () =>
    Boolean(
      await prisma.emailPermissionEvent.findFirst({
        where: { emailAddress: input.normalizedAddress, kind: "objected" },
        select: { id: true },
      })
    )
  );

  // Two rows, both required, because they answer different halves of one
  // question. The consent record says an act of consent happened and names the
  // evidence; the preference row says the person's answer is still yes *and*
  // that it was confirmed.
  //
  // `confirmedAt` is not decoration. It is the double opt-in rule
  // (docs/policy/email-double-opt-in.md section 3 rule 5), and it is what
  // handles the rows switched on before the confirmation step existed: those
  // have `enabled: true`, no `confirmedAt`, and a `granted` consent record from
  // that era. Reading the consent record alone would have called them consent
  // and sent to every one of them -- which is the exact population the generic
  // gate refuses without a migration having to touch them.
  //
  // An account with no preference row at all is not consent either, and that is
  // the population section 5.6 reaches with a sealed `risk_accepted` approval
  // rather than by inventing a consent for them.
  const consent = await read("the consent record", async () => {
    const [latest, preference] = await Promise.all([
      prisma.consentRecord.findFirst({
        where: { emailAddress: input.normalizedAddress, purpose: input.purpose },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        select: { id: true, action: true },
      }),
      input.userId === null
        ? Promise.resolve(null)
        : prisma.emailPreference.findUnique({
            where: {
              userId_purpose: { userId: input.userId, purpose: input.purpose },
            },
            select: { enabled: true, confirmedAt: true },
          }),
    ]);
    const confirmed =
      preference !== null && preference.enabled && preference.confirmedAt !== null;
    // Not "the latest grant": a grant followed by a withdrawal is a withdrawal,
    // and a query that asked only for grants would find the older row and call
    // it consent.
    const granted =
      latest !== null && (latest.action === "granted" || latest.action === "reconfirmed");
    const express = confirmed && granted;
    // `ReleaseNotesConsentInput` refuses a consent that cannot say what it rests
    // on -- an assertion, not a convention, and the reason this reads the row
    // rather than a boolean.
    return { express, evidenceIds: express && latest ? [latest.id] : [] };
  });

  // Composed here rather than by the caller, for the reason the candidate
  // countries are derived here: this module already holds the rules and the duty
  // rows the contract is made of, and a caller that loaded them again to compose
  // it would be a second answer to one question. The four callers section 7.6
  // names share a verdict only if they share what it rests on.
  //
  // A composition that refuses, and a candidate country whose profile this
  // policy version has no seed for, both arrive at the pure verdict as
  // `requiredDisplayContractHash: null` -- which is `display_unsatisfiable`, the
  // blocker that says the duties cannot be turned into one message. That is not
  // the same as `display_contract_changed`, and the two must not collapse: one
  // is re-rendered, the other is not.
  const profiles = await read("the jurisdiction profiles", () =>
    profilesForCountries({ countries, policyVersionId })
  );
  const { requirements, gaps } = displayRequirementsFor({
    countries,
    rules,
    obligations,
    profiles,
  });
  const composed =
    gaps.length > 0
      ? null
      : composeDisplayContract({
          requirements,
          templateVersionId: input.templateVersionId,
        });
  const requiredDisplayContractHash =
    composed === null || "refusal" in composed
      ? null
      : displayContractHash(composed.contract);

  const flags = await read("the feature flags", async () => ({
    marketingEnabled: await isEmailMarketingEnabled(),
    releaseNotesEnabled: await isEmailReleaseNotesEnabled(),
  }));

  // The override, and only where one could apply: a sealed `risk_accepted`
  // approval on this policy version whose cohort names this account. Loaded
  // whether or not it is needed, because whether it is needed is the pure
  // verdict's answer and asking twice is how two answers start.
  const override =
    input.userId === null
      ? null
      : await read("the risk_accepted approval", async () => {
          const member = await prisma.emailSendApprovalMember.findFirst({
            where: {
              userId: input.userId as string,
              approval: {
                approvalType: "risk_accepted",
                sealedAt: { not: null },
                revocations: { none: {} },
                policyVersionId,
              },
            },
            select: {
              userId: true,
              addressDigest: true,
              addressNormalizationVersion: true,
              approval: {
                select: {
                  id: true,
                  approvalType: true,
                  sealedAt: true,
                  policyVersionId: true,
                  ruleKey: true,
                  ruleVersion: true,
                  country: true,
                  obligationKey: true,
                  purposeKey: true,
                  revocations: { select: { id: true }, take: 1 },
                },
              },
            },
          });
          if (!member) return null;
          return {
            approvalId: member.approval.id,
            approval: {
              approvalType: member.approval.approvalType as "risk_accepted",
              sealedAt: member.approval.sealedAt,
              revoked: member.approval.revocations.length > 0,
              policyVersionId: member.approval.policyVersionId,
              ruleKey: member.approval.ruleKey,
              ruleVersion: member.approval.ruleVersion,
              country: member.approval.country,
              obligationKey: member.approval.obligationKey,
              purposeKey: member.approval.purposeKey,
            },
            member: {
              userId: member.userId,
              addressDigest: member.addressDigest,
              addressNormalizationVersion: member.addressNormalizationVersion,
            },
            userId: input.userId,
            deliveryAddressDigest: input.deliveryAddressDigest,
            currentAddressDigest: input.currentAddressDigest,
            // The rule this build computes digests under. Compared against the
            // member's own, which is how a cohort sealed under an older rule
            // stops matching rather than matching wrongly.
            addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
          };
        });

  return releaseNotesSendVerdict({
    purpose: input.purpose,
    policyVersionId,
    countries,
    rules,
    obligations,
    readiness,
    waivers,
    recipient: {
      suppressed: input.suppressed,
      objected,
      consent,
    },
    flags,
    display: {
      pinnedDisplayContractHash: input.pinnedDisplayContractHash,
      requiredDisplayContractHash,
    },
    override,
    phase: input.phase,
    now: input.now,
  });
}
