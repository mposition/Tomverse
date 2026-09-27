import "server-only";

import { prisma } from "@/lib/prisma";
import { marketingSendingConfigured } from "@/lib/emailUnsubscribeReadiness";
import {
  RELEASE_NOTES_OBLIGATIONS,
  obligationsFor,
} from "@/lib/releaseNotesObligationCore";

/**
 * Whether the subject labels a statute requires are on the rows that send.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7 and
 * 7.8; docs/policy/email-notifications.md section 5.2.
 *
 * ## Why this is a readiness check and not a test
 *
 * Singapore's Spam Control Act requires `<ADV>` in the subject of a marketing
 * message, and that label lives in the `JurisdictionProfile` row's
 * `subjectPrefix`. A test pins what the **seed** says; the send reads the
 * **row**, and section 8.7 exists so an operator can edit those rows without a
 * deploy. So "the label is there" is a runtime fact, and an obligation recorded
 * as `implemented` has to name a check that looks at the same thing the send
 * does — otherwise it is a duty nobody is confirming, which invariant 9 treats
 * as a reason to stop rather than a detail.
 *
 * It answers about the active policy version **and about every version a
 * pending delivery is pinned to**. The lane reads the profile of
 * `delivery.policyVersionId`, not the active one (EM-04), so a message enqueued
 * under an older version is sent under that version's labels however good the
 * active one is. The first version of this check read only the active version,
 * which a review pointed out: activating a corrected version would have turned
 * the check green while every already-queued Singaporean message still went out
 * with no label. With no active version there is nothing to check and nothing
 * that could newly enqueue, which is a problem to report rather than a pass.
 *
 * ## Two answers, because there are two questions
 *
 * `labelsPresent` is the substantive fact, and it is what an obligation
 * recorded as `implemented` rests on. `ready` is what `/api/ready` reports,
 * and it only becomes false once `MARKETING_EMAIL_FROM` is set -- the same
 * shape the unsubscribe keyring and the business identity use (EM-10). Before
 * then, gating the endpoint on a label no message needs would take a deployment
 * down to announce a capability nobody has turned on; from then on, not gating
 * it would answer yes while every Singaporean send is refused.
 *
 * Korea is deliberately absent from `REQUIRED_SUBJECT_PREFIX`. Section 7.7
 * records the owner's decision not to print `(광고)`, and that decision is a
 * waiver in the approval ledger rather than a value this check expects. Reading
 * the seed's `(광고)` as required here would make the waiver unenforceable: the
 * duty would be both waived and failing.
 */

/**
 * The profile keys whose subject prefix a statute requires, and the token it
 * has to be.
 *
 * The stored prefix may carry trailing space and nothing else. The seed's
 * `"<ADV> "` separates the label from the subject, and `"<ADV>"` satisfies the
 * Spam Control Act just as well -- but the composer concatenates the stored
 * value unchanged, so a leading space makes the subject `" <ADV>Hello"`, which
 * does not start with the label at all. Trimming both sides accepted exactly
 * that, which a review found: readiness has to check the string the send sends.
 */
export const REQUIRED_SUBJECT_PREFIX: Record<string, string> = {
  SG: "<ADV>",
};

export type SubjectLabelProblem = {
  severity: "error";
  code: "EMAIL_SUBJECT_LABEL_MISSING";
  message: string;
  /** The profile keys that do not carry their required prefix. */
  profileKeys: string[];
};

export async function subjectLabelReadiness(
  env: Record<string, string | undefined> = process.env
): Promise<{
  /** Whether `/api/ready` should fail: only once marketing sending is set up. */
  ready: boolean;
  /** Whether this deployment is one the labels are mandatory for. */
  required: boolean;
  /** The substantive answer, which an obligation state rests on. */
  labelsPresent: boolean;
  /** Null when no policy version is active. */
  policyVersionId: string | null;
  /** The versions checked: the active one and any a pending delivery is pinned to. */
  policyVersionIds: string[];
  problems: SubjectLabelProblem[];
}> {
  const required = marketingSendingConfigured(env);
  const answer = (
    labelsPresent: boolean,
    policyVersionId: string | null,
    problems: SubjectLabelProblem[],
    policyVersionIds: string[] = policyVersionId === null ? [] : [policyVersionId]
  ) => ({
    ready: labelsPresent || !required,
    required,
    labelsPresent,
    policyVersionId,
    policyVersionIds,
    problems,
  });

  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (!active) {
    return answer(false, null, [
      {
        severity: "error",
        code: "EMAIL_SUBJECT_LABEL_MISSING",
        message:
          "No email policy version is active, so no subject label can be confirmed. Create and activate one (/admin/email-policy).",
        profileKeys: Object.keys(REQUIRED_SUBJECT_PREFIX),
      },
    ]);
  }

  // Every version a message could still go out under: the active one, and the
  // ones already-queued deliveries carry. A profile key is checked per version
  // only where it is actually reachable -- the active version for anything about
  // to be enqueued, and a pinned version only for the profile keys queued under
  // it, because a version nothing is queued under for SG cannot send an SG
  // message however its row reads.
  const pending = await prisma.emailDelivery.findMany({
    where: {
      status: "pending",
      jurisdictionProfileKey: { in: Object.keys(REQUIRED_SUBJECT_PREFIX) },
    },
    select: { policyVersionId: true, jurisdictionProfileKey: true },
    distinct: ["policyVersionId", "jurisdictionProfileKey"],
  });

  const wanted = new Map<string, Set<string>>();
  const want = (policyVersionId: string, profileKey: string) => {
    const keys = wanted.get(policyVersionId) ?? new Set<string>();
    keys.add(profileKey);
    wanted.set(policyVersionId, keys);
  };
  for (const profileKey of Object.keys(REQUIRED_SUBJECT_PREFIX)) want(active.id, profileKey);
  for (const row of pending) want(row.policyVersionId, row.jurisdictionProfileKey);

  const profiles = await prisma.jurisdictionProfile.findMany({
    where: {
      policyVersionId: { in: [...wanted.keys()] },
      profileKey: { in: Object.keys(REQUIRED_SUBJECT_PREFIX) },
    },
    select: { profileKey: true, policyVersionId: true, subjectPrefix: true },
  });
  const stored = new Map(
    profiles.map((row) => [`${row.policyVersionId}:${row.profileKey}`, row.subjectPrefix])
  );

  // A profile row that is absent is as missing as one with the wrong value: the
  // lane's `findUnique` returns nothing and the message is composed with no
  // prefix at all.
  const missing: { policyVersionId: string; profileKey: string }[] = [];
  for (const [policyVersionId, keys] of wanted) {
    for (const profileKey of keys) {
      const prefix = REQUIRED_SUBJECT_PREFIX[profileKey];
      if ((stored.get(`${policyVersionId}:${profileKey}`) ?? "").trimEnd() !== prefix) {
        missing.push({ policyVersionId, profileKey });
      }
    }
  }

  const checked = [...wanted.keys()].sort();
  if (missing.length === 0) return answer(true, active.id, [], checked);

  const queued = missing.filter((entry) => entry.policyVersionId !== active.id);
  return answer(
    false,
    active.id,
    [
      {
        severity: "error",
        code: "EMAIL_SUBJECT_LABEL_MISSING",
        message:
          `The required subject prefix is not on ${missing.length} policy version and profile ` +
          `pair(s): ${missing.map((entry) => `${entry.profileKey}@${entry.policyVersionId}`).join(", ")}. ` +
          (queued.length > 0
            ? "Some of those are versions pending deliveries are pinned to, which activating a " +
              "corrected version does not change -- those messages are composed under the version " +
              "they carry. "
            : "") +
          "Marketing to those countries is refused while that is true.",
        profileKeys: [...new Set(missing.map((entry) => entry.profileKey))].sort(),
      },
    ],
    checked
  );
}

/**
 * The obligations this check answers for, so a duty recorded as `implemented`
 * against it can be traced back to what it actually confirms.
 *
 * Read from the obligation list rather than restated: a duty added there with
 * this check's name and nothing here to confirm it would be the drift this
 * whole mechanism is against, and `tests/emailSubjectLabelReadiness.test.mjs`
 * fails when the two disagree.
 */
export const SUBJECT_LABEL_OBLIGATIONS: Record<string, readonly string[]> =
  Object.fromEntries(
    Object.keys(REQUIRED_SUBJECT_PREFIX).map((countryCode) => [
      countryCode,
      obligationsFor(countryCode).filter((key) => key.endsWith("subject_label")),
    ])
  );

/** Every country whose declared duties include a subject label. */
export const COUNTRIES_WITH_SUBJECT_LABEL_DUTY = Object.keys(RELEASE_NOTES_OBLIGATIONS)
  .filter((countryCode) =>
    obligationsFor(countryCode).some((key) => key.endsWith("subject_label"))
  )
  .sort();
