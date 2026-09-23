import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { emailAddressDigest } from "@/lib/emailAddressDigest";
import { cohortStanding } from "@/lib/emailSendApprovalCohort";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import {
  marketingJurisdictionVerdict,
  normalizeCountry,
  profileForCountry,
} from "@/lib/emailJurisdictionCore";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import { suppressionCheck } from "@/lib/emailSuppression";
import {
  EMAIL_ADDRESS_NORMALIZATION_VERSION,
  normalizeEmailAddress,
} from "@/lib/emailSuppressionCore";
import {
  DETERMINATIVE_JURISDICTION_SOURCES,
  NOTICE_CANDIDATE_SIGNALS,
  canonicalJson,
  inProductNoticeOffer,
  noticeJurisdictionColumns,
  noticeObjectionSourceEventKey,
  noticePurposes,
  noticeRecordFor,
  noticeShownSourceEventKey,
  type NoticeOffer,
} from "@/lib/inProductConsentNoticeCore";

/**
 * Reading and writing the one-time in-product consent notice.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.1,
 * 5.4 and 5.5. The decisions are in `lib/inProductConsentNoticeCore.ts`; this
 * file only fetches what they need and writes down what they conclude.
 *
 * ## This is the permission ledger's first writer
 *
 * S3 built `EmailPermissionEvent` and nothing wrote to it. Two of its five
 * kinds -- `notice_shown` and `objected` -- exist for this screen, so the
 * shape of those rows is settled here: `capturedVia: "in_product_notice"`,
 * scoped to `marketing`, keyed so a re-render adds nothing.
 *
 * ## The `risk_accepted` cohort is not asked
 *
 * The approved wording opens by saying we have not sent product news and will
 * not unless asked. The approved `risk_accepted` decision sends to the
 * existing accounts without asking. Both cannot be true of the same person,
 * and the owner chose on 2026-09-23 to keep the override and leave those
 * accounts out of this notice. So `noticeStateForUser()` refuses them with
 * `covered_by_approval`, and the promise stays truthful because it is only
 * ever made to people it is true of. The wording, and the record of this
 * decision beside it, arrive with S2.
 *
 * That refusal follows whether the override would actually **send**, not
 * whether the account is merely in the cohort -- see `overrideWouldSend()`.
 * Withdrawing an approval, changing address, or having no settled country all
 * stop the override, and each puts the notice back.
 *
 * The purposes an approval does not cover are left without this route, and
 * the preference centre is not a full substitute: it refuses marketing for
 * countries outside the ten it supports (`COUNTRY_UNSUPPORTED`). That cost
 * is the one decision B accepted, and it is stated here rather than implied
 * away.
 *
 * ## What is deliberately missing
 *
 * The wording. Section 5.4's copy belongs to S2 and is approved by the owner
 * rather than written here, and it has to exist in seven languages. So
 * `recordNoticeShown()` takes the copy hash from its caller and refuses
 * without one: a `notice_shown` row that cannot say which words were on the
 * screen is a record that we asked, with no way to ever show what we asked.
 *
 * ## The country is reported, not derived -- and there may be two of them
 *
 * The **recorded** jurisdiction is never derived here. The caller passes the
 * candidates it actually applied: for each one the country, the signal it came
 * from, the version of the rule whose device was rendered, and the hash of that
 * device's words. (`overrideWouldSend()` does ask `jurisdictionForUser()`,
 * but only whether mail would go out, and nothing it learns is written.)
 *
 * A list rather than a single country, because section 5.3 says an uncertain
 * estimate keeps both candidates and evaluates both -- a person who might be
 * in Korea has to pass Korea's rule too. A scalar could not express that, so a
 * caller written against a scalar would have had to pick one before the
 * evaluation that is supposed to consider both, and the picked one would have
 * been permanent: this writer returns the existing row rather than adding a
 * second, so the first write wins for ever.
 *
 * The caller also passes the `ResolvedJurisdiction` it worked from -- the
 * answer `resolveEmailJurisdiction()` gave, which is the same rule the send
 * path uses. This module does not resolve a jurisdiction of its own;
 * `noticeJurisdictionColumns()` only says how that answer fits two columns
 * with no room for a confidence or a profile, and the note there records the
 * four ways a second rule got it wrong before.
 *
 * Deriving any of it here was wrong, and the way it was wrong is worth
 * keeping. An account that has never declared a country resolves through
 * language and timezone: `ko` plus `Asia/Seoul` answers `KR` at `low`
 * confidence with source `inferred`. `EmailPermissionEvent` has no confidence
 * column, so the row would have said `KR` flatly, for ever, about somebody who
 * was never shown a Korean device. Append-only means no later write corrects
 * it.
 *
 * A comment saying "wait for section 5.3" was not a boundary, because the
 * function wrote the row regardless of whether a screen existed. The signature
 * is the boundary: until something renders a country's device and can say
 * which one, it cannot call this.
 *
 * Candidate countries still go through `normalizeCountry()` on the way into
 * the evidence. Without it `" AU"`, `"kr"`, `"Korea"` and `"inferred"` were
 * all accepted, stored raw, and compared against later with `===`.
 */

/**
 * Whether a `risk_accepted` override would actually send marketing to this
 * address, for at least one purpose the notice asks about.
 *
 * Decision B hides the notice from exactly these people, because its wording
 * promises we have not sent and will not unless asked. Two earlier versions
 * got the boundary wrong, in opposite directions, and both matter:
 *
 * - "is there a member row" was wider than the send, so a member who changed
 *   address fell out of the override and was still hidden from the notice.
 *   Membership is now asked the send's way, through `cohortStanding()`.
 * - "is the member in scope" is still wider than "is mail going out". The
 *   send also asks `marketingJurisdictionVerdict()`, which refuses an
 *   undetermined country, one with no reviewed profile, and one outside
 *   `MARKETING_ALLOWED_COUNTRIES`. A member in Japan, the Netherlands, or
 *   with no country at all is in the cohort and is never mailed -- and the
 *   preference centre refuses the same countries. Hiding the notice from them
 *   left no basis, no route to one and no mail, and the wording was true of
 *   them all along.
 *
 * The recipient's own decisions (objected, suppressed, withdrawn) are not
 * re-checked here, because the offer answers for them earlier and they cannot
 * change this result. Obligation status is not checked either: it is the
 * send's gate (S9), it is not knowable here, and the two mistakes are not
 * symmetrical -- hiding the notice wrongly writes nothing and is undone the
 * moment the state behind it changes, while showing it wrongly writes a
 * permanent `copyHash` of a promise we have broken.
 *
 * `jurisdictionForUser()` reads on the global client. That is a read in a
 * different snapshot from a caller's transaction, not a write that escapes
 * it, and it is the one resolver the send also uses.
 */
const overrideWouldSend = async (input: {
  db: Prisma.TransactionClient | typeof prisma;
  userId: string;
  emailAddress: string;
  purposes: readonly string[];
  client?: Prisma.TransactionClient;
}): Promise<boolean> => {
  const activePolicyVersion = await input.db.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (!activePolicyVersion) return false;

  const memberships = await input.db.emailSendApprovalMember.findMany({
    where: {
      userId: input.userId,
      approval: {
        approvalType: "risk_accepted",
        sealedAt: { not: null },
        revocations: { none: {} },
      },
    },
    select: { approvalId: true },
  });
  if (memberships.length === 0) return false;

  // The send's own jurisdiction gate, not an assembly of its parts.
  //
  // This was `overrideBlockers()` fed a confidence-folded country, which
  // caught an undetermined country and a missing profile -- and missed
  // `MARKETING_ALLOWED_COUNTRIES`. A cohort member in the Netherlands resolves
  // high confidence to the `EU` profile, so no blocker fired, the notice was
  // hidden, and `marketingJurisdictionVerdict()` refused the send with
  // `marketing_country_not_allowed`. Never mailed, never asked, and the
  // preference centre refuses the same country. The function that decides
  // whether marketing may go to a jurisdiction already existed; asking it is
  // the whole fix.
  const jurisdiction = await jurisdictionForUser({ userId: input.userId });
  if (!marketingJurisdictionVerdict(jurisdiction).allowed) return false;

  for (const { approvalId } of memberships) {
    for (const purpose of input.purposes) {
      const standing = await cohortStanding({
        approvalId,
        userId: input.userId,
        deliveryEmailAddress: input.emailAddress,
        purpose,
        policyVersionId: activePolicyVersion.id,
        ...(input.client ? { client: input.client } : {}),
      });
      // Any purpose. One going out under the override already makes the
      // wording false for this person.
      if (standing.inCohort) return true;
    }
  }
  return false;
};

/** What a caller needs before it can decide whether to render anything. */
export const noticeStateForUser = async (input: {
  userId: string;
  client?: Prisma.TransactionClient;
}): Promise<NoticeOffer> => {
  const db = input.client ?? prisma;

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  const emailAddress = user?.email ? normalizeEmailAddress(user.email) : null;

  if (!emailAddress) {
    return inProductNoticeOffer({
      emailAddress: null,
      hasExpressConsent: false,
      noticeAlreadyShown: false,
      hasObjected: false,
      suppressed: false,
      coveredByRiskAcceptedApproval: false,
    });
  }

  const purposes = noticePurposes();

  // The three states are read separately because they are three facts. An
  // account can have been shown the notice, not consented and not objected,
  // and that combination is the ordinary one -- somebody who closed it.
  const [consent, shown, objected, suppressions, covered] = await Promise.all([
    // The newest row per purpose, and only then what it says.
    //
    // `ConsentRecord` is append-only, so somebody who granted and then
    // withdrew has both rows -- and asking for any `granted` row found the
    // first one and called them a consenting subscriber for ever. They would
    // never be offered the notice again, with the reason recorded as
    // `already_consented`, and the in-product notice is the only place an
    // existing account can actually give consent (section 5.4). Any later
    // reader that treats that refusal as express consent sends marketing to an
    // address that withdrew.
    //
    // `lib/marketingReach.ts` counts the same table the same way, and says so
    // for the same reason.
    db.$queryRaw<{ purpose: string }[]>`
      SELECT purpose FROM (
        SELECT DISTINCT ON (purpose) purpose, action
        FROM "ConsentRecord"
        WHERE "emailAddress" = ${emailAddress}
          AND purpose = ANY(${[...purposes]}::text[])
        ORDER BY purpose, "occurredAt" DESC, "createdAt" DESC
      ) latest
      WHERE action IN ('granted', 'reconfirmed')
      LIMIT 1
    `,
    db.emailPermissionEvent.findFirst({
      where: { userId: input.userId, kind: "notice_shown" },
      select: { id: true },
    }),
    db.emailPermissionEvent.findFirst({
      where: { emailAddress, kind: "objected" },
      select: { id: true },
    }),
    // Once per purpose, not once for the classification.
    //
    // An unsubscribe writes a purpose-scope cause, and a check with no
    // purpose sees only the global and classification scopes
    // (lib/emailSuppression.ts). Asking with the classification alone would
    // have shown the consent notice to somebody who had turned that exact
    // mail off -- which is soliciting a resubscription, the one thing every
    // purpose in the table is marked as never doing.
    Promise.all(
      purposes.map((purpose) =>
        suppressionCheck({
          emailAddress,
          classification: "marketing",
          purpose,
          ...(input.client ? { client: input.client } : {}),
        })
      )
    ),
    // Whether the override would actually mail this person. See
    // `overrideWouldSend()` for why that is narrower than membership.
    overrideWouldSend({
      db,
      userId: input.userId,
      emailAddress,
      purposes,
      ...(input.client ? { client: input.client } : {}),
    }),
  ]);

  return inProductNoticeOffer({
    emailAddress,
    hasExpressConsent: consent.length > 0,
    noticeAlreadyShown: shown !== null,
    // Keyed by address rather than by account: a refusal follows the mailbox,
    // for the same reason a suppression does.
    hasObjected: objected !== null,
    // Any one of them. The notice asks about the set, so a refusal anywhere
    // in the set is a refusal of the question being put.
    suppressed: suppressions.some((verdict) => !verdict.allowed),
    coveredByRiskAcceptedApproval: covered,
  });
};

/** One country whose rule was applied when the notice was rendered. */
export type NoticeCandidate = {
  country: string;
  /** Where this candidate came from: `self_declared`, `inferred`, ... */
  signal: string;
  ruleVersion: number;
  /** The hash of the words this candidate's rule put on the screen. */
  copyHash: string;
};

type RecordInput = {
  userId: string;
  emailAddress: string;
  /**
   * Which screen, and the hash of the exact words rendered on it. Required:
   * see the note at the top of this file.
   */
  surface: string;
  copyHash: string;
  /**
   * The candidates whose rules the person was actually shown.
   *
   * Empty when nothing resolved, and exactly the countries the resolution
   * involved otherwise. None of it is derived here: a row that cannot say
   * which rule applied is a record that we asked with no way to say what we
   * asked under, and it can never be corrected.
   */
  candidates: readonly NoticeCandidate[];
  /**
   * What `resolveEmailJurisdiction()` answered for this person.
   *
   * Passed rather than recomputed, so that the row records the resolution the
   * caller actually rendered from. There is one jurisdiction rule in this
   * codebase and it is not in this file.
   */
  resolved: {
    countryCode: string;
    profileKey: string;
    confidence: string;
    source: string;
    /**
     * The high-confidence countries that disagreed, when they did.
     *
     * Part of `ResolvedJurisdiction` and required here whenever the
     * confidence is `conflict`: the column folds to `ZZ` either way, so
     * without the pair there is nothing left in the row to say which two
     * countries the conflict was between.
     */
    conflicts?: readonly string[];
  };
  occurredAt?: Date;
  client?: Prisma.TransactionClient;
};

const recordNoticeEvent = async (
  action: "shown" | "object",
  input: RecordInput
) => {
  if (input.copyHash.trim().length === 0) {
    throw new Error(
      "An in-product notice event must carry the hash of the words that were on the screen."
    );
  }


  const db = input.client ?? prisma;
  const record = noticeRecordFor(action);
  if (record.kind === "consent") {
    throw new Error("Consent is not recorded as a permission event.");
  }
  const emailAddress = normalizeEmailAddress(input.emailAddress);

  const candidates = input.candidates.map((candidate) => {
    const country = normalizeCountry(candidate.country);
    if (country === null) {
      throw new Error(
        `"${candidate.country}" is not a country code; an in-product notice event cannot record it.`
      );
    }
    if (!NOTICE_CANDIDATE_SIGNALS.has(candidate.signal)) {
      throw new Error(
        `"${candidate.signal}" is not a signal a candidate can come from.`
      );
    }
    if (candidate.copyHash.trim().length === 0) {
      throw new Error(
        "An in-product notice event must carry the hash of the words each candidate's rule put on the screen."
      );
    }
    return {
      country,
      signal: candidate.signal,
      ruleVersion: candidate.ruleVersion,
      copyHash: candidate.copyHash,
    };
  });

  // The resolved answer is checked against itself and against the screen.
  //
  // Not a second resolution -- every check here refuses rather than decides.
  // They exist because the two halves of this row come from different places:
  // the columns from `resolved` and the evidence from `candidates`, and
  // nothing stopped them describing different countries. A screen that
  // rendered Singapore's device with an Australian resolution would have left
  // a row where the column says AU and the evidence says SG, and a send
  // following one would attach the wrong country's display duties. Neither
  // half can be corrected afterwards.
  const resolvedCountry = normalizeCountry(input.resolved.countryCode);
  if (input.resolved.countryCode !== "ZZ" && resolvedCountry === null) {
    throw new Error(
      `"${input.resolved.countryCode}" is not a country code; an in-product notice event cannot record it.`
    );
  }
  // The caller's own `profileKey` is not evidence of anything: a caller could
  // pass `{ countryCode: "JP", profileKey: "AU" }`. Derived from the code.
  const resolved = {
    countryCode: resolvedCountry ?? "ZZ",
    profileKey: profileForCountry(resolvedCountry),
    confidence: input.resolved.confidence,
    source: input.resolved.source,
  };
  // Both directions. A `conflict` confidence with some other source would
  // fold the column to `ZZ` and throw the country away while the row claimed
  // a settled source, which reads as a settled answer that is missing.
  if (
    (resolved.source === "conflict") !==
    (resolved.confidence === "conflict")
  ) {
    throw new Error(
      "An in-product notice event cannot record a conflict on one of the source and the confidence but not the other."
    );
  }
  // `high` is a claim only three sources can make (approved contract
  // sections 6.1 to 6.3). An inference is `low` by construction, so
  // `high` + `inferred` is a pair the resolver never produces -- and one
  // that would have settled the column on a guess, with a real profile behind
  // it so the override's `country_undetermined` would not have stopped it.
  if (
    resolved.confidence === "high" &&
    !DETERMINATIVE_JURISDICTION_SOURCES.has(resolved.source)
  ) {
    throw new Error(
      `A ${resolved.source} resolution cannot be high confidence.`
    );
  }

  const jurisdiction = noticeJurisdictionColumns(resolved);

  // The resolution and the screen have to describe the same countries, and
  // that is checked **before** the fold to `ZZ` rather than after it.
  //
  // Checking the folded column was not enough, and the gap was exactly where
  // the fold happens: a resolution of `KR` at `low` confidence rendered
  // against a Singapore device folded to `ZZ` and passed, with `KR`
  // appearing nowhere in the row.
  //
  // `ZZ` is a sentinel, not a country. Treating it as one -- which
  // `normalizeCountry()` does, because it is two capital letters -- made this
  // refuse every conflict and every unresolved payload the resolver actually
  // produces, since both carry `countryCode: "ZZ"` and keep the real
  // countries elsewhere. An account whose billing country and declaration
  // disagreed would have been shown both devices and then failed to record
  // that it had been asked, so the notice returned on every sign-in.
  const namedCountries = new Set<string>();
  if (resolved.countryCode !== "ZZ") namedCountries.add(resolved.countryCode);

  // A conflict names exactly two, and the screen rendered exactly those two.
  //
  // Equality rather than membership, and the difference was a real hole:
  // `conflicts: ["AU", "KR"]` with only Australia rendered was accepted,
  // because the settled-singleton rule below does not run when the column is
  // `ZZ` -- and a conflict's column is always `ZZ`. The row then said a
  // conflict happened while its evidence named one side, so Korea's
  // `(광고)` prefix would never attach to that account. Writing it again
  // with both is refused as a different fact, so the first write is final.
  if (resolved.confidence === "conflict") {
    const conflicts = (input.resolved.conflicts ?? []).map((country) =>
      normalizeCountry(country)
    );
    if (
      conflicts.length !== 2 ||
      conflicts.some((country) => country === null || country === "ZZ") ||
      conflicts[0] === conflicts[1]
    ) {
      throw new Error(
        "A conflicting resolution must name exactly two different countries that disagreed."
      );
    }
    for (const country of conflicts) namedCountries.add(country!);
  }

  const candidateCountries = new Set(
    candidates.map((candidate) => candidate.country)
  );

  // Every rendered rule belongs to a country the resolution involved.
  //
  // The observed IP country is deliberately **not** in that set. Draft section
  // 5.3 wants it as a second candidate, and says in the same passage that S0
  // must amend the approved contract first; the approved contract still says
  // an IP is observational and does not decide a jurisdiction (sections 6.2
  // and 6.3). Admitting it here would write records that contract does not
  // allow, permanently -- an unresolved account could be recorded with a
  // hotel's country as the only rule it was shown, and every later send would
  // attach that country's display duties. S8b adds it back with S0.
  for (const country of candidateCountries) {
    if (!namedCountries.has(country)) {
      throw new Error(
        `${country} is not a country this resolution involved, so its rule should not have been rendered.`
      );
    }
  }
  for (const country of namedCountries) {
    if (!candidateCountries.has(country)) {
      throw new Error(
        `${country} is a country this resolution involved, so its rule should have been rendered.`
      );
    }
  }

  // And a settled country is the *only* rule that should have been rendered.
  //
  // Draft section 5.3: two candidates are what an uncertain estimate looks
  // like, and a determinative signal replaces the list rather than joining it.
  // Leaving a stray candidate beside a settled country matters because the
  // display duties are the union -- so an account settled as Australian, with
  // Korea left in the list, gets Korea's `(광고)` prefix attached, or is
  // refused as `display_unsatisfiable` when two prefixes collide.
  // Permanently: this row is written once.
  //
  // The equality above already forces this for every resolution the resolver
  // produces, since a settled one names one country. It stays as its own
  // refusal because it is a different statement -- that a settled country is
  // exclusive -- and it is the one that would catch a future resolution shape
  // naming a country alongside a settled one.
  if (jurisdiction.country !== "ZZ") {
    if (
      candidateCountries.size !== 1 ||
      !candidateCountries.has(jurisdiction.country)
    ) {
      throw new Error(
        `${jurisdiction.country} is settled, so it is the only rule this notice should have rendered.`
      );
    }
  }

  // The two keys are scoped differently, and deliberately: a render is about
  // the person, a refusal is about the mailbox. See the two builders.
  const sourceEventKey =
    action === "shown"
      ? noticeShownSourceEventKey(input.userId)
      : noticeObjectionSourceEventKey(
          input.userId,
          emailAddressDigest(emailAddress)
        );
  const where = {
    kind_sourceEventKey: { kind: record.kind, sourceEventKey },
  } as const;

  // Look first, then insert. Written as insert-or-return rather than an
  // upsert because the table refuses every UPDATE except the one detaching a
  // deleted account, so an upsert's second branch would raise the append-only
  // trigger the first time a render repeated -- the exact case idempotency is
  // for.
  //
  // The read comes before the write rather than after a caught conflict
  // because this may be running inside a caller's transaction. A unique
  // violation there aborts the whole transaction, so the recovery read would
  // fail too and take the caller's work with it. The catch below still exists
  // for the genuine race, which on the root client is recoverable and inside
  // a transaction is a real conflict the caller has to resolve.
  const evidence = {
    surface: input.surface,
    copyHash: input.copyHash,
    candidates,
  };
  const wanted = canonicalJson({
    evidence,
    jurisdiction: jurisdiction.country,
    jurisdictionSource: jurisdiction.source,
  });

  const sameFactOrThrow = <
    T extends { evidence: unknown; jurisdiction: string | null; jurisdictionSource: string | null },
  >(
    row: T
  ): T => {
    // The same key has to mean the same fact -- all of it.
    //
    // This row is append-only and one per account, so the first write is
    // permanent, and returning it for a call that described something else
    // discards that call silently while its caller reads success. A first call
    // naming Australia and a retry adding Korea would leave Korea nowhere in
    // the ledger, which is precisely the candidate list section 5.3 says must
    // follow the person to the send snapshot.
    //
    // Comparing the candidates alone was not enough, and the gap was the
    // interesting half: a retry with the same candidates but a different
    // resolution, or different words on the screen, also came back as success
    // with the first write's jurisdiction and copy hash standing. That erased
    // the distinction between `conflict` and `unresolved` the moment anything
    // retried. So the comparison is over everything this call would have
    // written.
    //
    // Refused rather than merged: the recorded row says what was on the screen
    // when we asked, and a different description means a different screen, not
    // more detail about the same one.
    const recorded = canonicalJson({
      evidence: row.evidence ?? null,
      jurisdiction: row.jurisdiction,
      jurisdictionSource: row.jurisdictionSource,
    });
    if (recorded !== wanted) {
      throw new Error(
        `An in-product ${record.kind} is already recorded for this account and describes something else; it cannot be rewritten.`
      );
    }
    return row;
  };

  const existing = await db.emailPermissionEvent.findUnique({ where });

  // A render recorded for somebody the override mails is permanent evidence
  // that we showed them a promise we had already broken. A route that asks
  // `noticeStateForUser()` first will never try; this is for the one that
  // does not, because the row it would write cannot be taken back.
  //
  // After the idempotency read, so a retry of a render that was legitimately
  // recorded before an approval existed still returns its row.
  if (!existing && action === "shown") {
    if (
      await overrideWouldSend({
        db,
        userId: input.userId,
        emailAddress,
        purposes: noticePurposes(),
        ...(input.client ? { client: input.client } : {}),
      })
    ) {
      throw new Error(
        "This account is mailed under a risk_accepted approval, so the notice's wording would be false for it and cannot be recorded as shown."
      );
    }
  }

  if (existing) {
    // The same key has to mean the same fact.
    //
    // This row is append-only and one per account, so the first write is
    // permanent -- and returning it for a retry that carried different
    // candidates discarded them silently while the caller read success. A
    // first call naming Australia and a retry adding Korea would leave Korea
    // nowhere in the ledger, which is precisely the candidate list section 5.3
    // says must follow the person from the attempt through to the send
    // snapshot.
    //
    // Refused rather than merged: the recorded row says what was on the screen
    // when we asked, and a second set of candidates means a different screen,
    // not more detail about the same one.
    return sameFactOrThrow(existing);
  }

  // The active policy version, with the same care as the read path.
  //
  // `ensureBootstrapPolicyVersion()` writes on the global client, so calling
  // it from inside a caller's transaction activates a version that survives
  // their rollback. Outside one it is the right call: a fresh environment has
  // to get its first version from somewhere. Inside one this refuses instead,
  // because a ledger row pinned to a version that exists only because we were
  // asked to write the row is not evidence of the policy that applied.
  const policyVersionId = input.client
    ? (
        await input.client.emailPolicyVersion.findFirst({
          where: { status: "active" },
          select: { id: true },
        })
      )?.id
    : await ensureBootstrapPolicyVersion();
  if (!policyVersionId) {
    throw new Error(
      "No email policy version is active, so an in-product notice event has no policy to record itself under."
    );
  }

  try {
    return await db.emailPermissionEvent.create({
      data: {
        userId: input.userId,
        emailAddress,
        addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
        kind: record.kind,
        scopeKey: record.scopeKey,
        occurredAt: input.occurredAt ?? new Date(),
        capturedVia: "in_product_notice",
        sourceEventKey,
        jurisdiction: jurisdiction.country,
        jurisdictionSource: jurisdiction.source,
        policyVersionId,
        evidence,
      },
    });
  } catch (error) {
    if (
      input.client ||
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
    const raced = await db.emailPermissionEvent.findUnique({ where });
    if (!raced) throw error;
    // The same comparison as the read-first path. Without it, two concurrent
    // requests that both missed the row left the loser reading success while
    // its candidates went nowhere -- the sequential retry was refused and the
    // overlapping one was not.
    return sameFactOrThrow(raced);
  }
};

/**
 * The notice was rendered to this person.
 *
 * Not a consent and not a refusal. It is what stops the notice reappearing,
 * and it is the only thing a dismissal leaves behind.
 */
export const recordNoticeShown = (input: RecordInput) =>
  recordNoticeEvent("shown", input);

/** They used the refusal control. A decision, and it outlasts the screen. */
export const recordNoticeObjection = (input: RecordInput) =>
  recordNoticeEvent("object", input);
