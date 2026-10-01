import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isEmailConsentConfirmationEnabled, isEmailSignupConsentEnabled } from "@/lib/appSettings";
import { readConsentKeyring } from "@/lib/emailConsentToken";
import {
  CONSENT_COPY_LANGUAGES,
  CURRENT_CONSENT_COPY_VERSION,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";
import { consentCopyHash } from "@/lib/emailConsentCopyHash";
import {
  prepareVerifiedSessionGrant,
  requestConsentConfirmation,
} from "@/lib/emailConsentConfirmation";
import { applyPreferenceChange, ensureDefaultPreferences } from "@/lib/emailPreferences";
import { recordEstimatedCountry } from "@/lib/emailJurisdiction";
import { profileForCountry, type ResolvedJurisdiction } from "@/lib/emailJurisdictionCore";
import { normalizeEmailLoginAddress } from "@/lib/emailLogin";
import { recordNoticeObjection, recordNoticeShown } from "@/lib/inProductConsentNotice";
import { noticeJurisdictionColumns, noticePurposes } from "@/lib/inProductConsentNoticeCore";
import { recordRelationshipStarted } from "@/lib/auRelationship";
import { isEmailPolicyPublished } from "@/lib/emailPolicyPublication";
import {
  SIGNUP_CONSENT_OAUTH_PROVIDERS,
  SIGNUP_CONSENT_TTL_MS,
  estimatedCountryFromHeader,
  signupConsentRefusal,
  type SignupConsentCandidate,
  type SignupConsentChannel,
  type SignupConsentRefusal,
} from "@/lib/signupConsentCore";

/**
 * The sign-up screen's consent choice: stored before the account exists,
 * consumed once after sign-in by the account this flow created.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 5.1 to
 * 5.3 (S4). The decisions are in lib/signupConsentCore.ts; this reads and
 * writes.
 *
 * What the screen shows is the approved consent copy (A: the unticked opt-in,
 * B: the notice, C: the separate refusal), in the version current when the
 * attempt is issued. The attempt records that version and, per candidate
 * country, the hash of the notice's words -- the only final record of the
 * choice, since nothing is shown again after sign-in.
 */

/** The nonce is the tab's; only its hash is stored. */
const nonceHash = (nonce: string) =>
  createHash("sha256").update(`signup-consent:${nonce}`).digest("hex");

const copyLanguage = (value: string | null | undefined): ConsentCopyLanguage =>
  (CONSENT_COPY_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as ConsentCopyLanguage)
    : "en";

/**
 * The purposes the opt-in box consents to: the three its wording names
 * (product news, newsletters, promotions), the same set the in-product
 * notice's "Yes" covers.
 *
 * It was product updates alone while every consent took a confirmation mail
 * per purpose, to spare three mails at sign-up. A session that proved the
 * address now consents at once (docs/policy/email-double-opt-in.md §14), so
 * the box does what its words say (owner decision 2026-10-01, §14.8).
 */
export const signupOptInPurposes = () => noticePurposes();

/**
 * Whether the sign-up screen may show its devices, for a request whose trusted
 * country header is `ipCountry`.
 *
 * All three are needed, because the devices are one screen (section 5.1): the
 * collection gate; a confirmation that can actually be sent (its gate and its
 * keys) -- ticking A must end in a confirmation mail, and a box that silently
 * records nothing is a promise the screen breaks; and a country, because the
 * confirmation and the notice are both decided under one. Missing any, the
 * screen shows none of them and signs the person in as before.
 */
export async function signupConsentAvailable(ipCountry: string | null | undefined): Promise<boolean> {
  if (!estimatedCountryFromHeader(ipCountry)) return false;
  if (!readConsentKeyring(process.env)) return false;
  const [collection, confirmation] = await Promise.all([
    isEmailSignupConsentEnabled(),
    isEmailConsentConfirmationEnabled(),
  ]);
  return collection && confirmation;
}

/**
 * The database's clock, in the naive-UTC form the timestamp columns store.
 *
 * An attempt is compared with `User.createdAt` and `EmailLoginAttempt.createdAt`,
 * which the database stamps with `DEFAULT CURRENT_TIMESTAMP` into a
 * `timestamp(3)` -- the session's local time, whatever its TimeZone.
 * `LOCALTIMESTAMP(3)` is that same value, so the two sides are one clock in one
 * zone. Stamping the attempt with this process's clock compared two clocks,
 * and an instance running behind let an account created just before the
 * choice pass as created after it.
 */
const databaseNow = async (
  db: Pick<typeof prisma, "$queryRaw"> = prisma
): Promise<Date> => {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT LOCALTIMESTAMP(3) AS "now"`;
  if (!row) throw new Error("The database did not report its clock.");
  return row.now;
};

export type IssueSignupConsentResult =
  | { ok: true; attemptId: string; nonce: string; expiresAt: Date }
  | { ok: false; reason: "disabled" | "invalid" };

export async function issueSignupConsentAttempt(input: {
  channel: SignupConsentChannel;
  provider?: string | null;
  email?: string | null;
  expressOptInRequested: boolean;
  objected: boolean;
  language?: string | null;
  /** The request's `cf-ipcountry`. */
  ipCountry?: string | null;
  /** The tab's previous attempt, superseded in the same transaction. */
  supersede?: { attemptId: string; nonce: string } | null;
  now?: Date;
}): Promise<IssueSignupConsentResult> {
  // The same answer the page rendered from: without it there were no devices
  // on the screen, and nothing may be stored as though there were.
  if (!(await signupConsentAvailable(input.ipCountry))) return { ok: false, reason: "disabled" };
  // Two answers to one question: ticking the box and pressing the refusal
  // cannot both be the choice.
  if (input.expressOptInRequested && input.objected) return { ok: false, reason: "invalid" };

  let bindingProvider: string | null = null;
  let bindingEmail: string | null = null;
  if (input.channel === "oauth") {
    if (!(SIGNUP_CONSENT_OAUTH_PROVIDERS as readonly string[]).includes(input.provider ?? "")) {
      return { ok: false, reason: "invalid" };
    }
    bindingProvider = input.provider!;
  } else if (input.channel === "email_code") {
    const email = input.email ? normalizeEmailLoginAddress(input.email) : "";
    if (!email.includes("@")) return { ok: false, reason: "invalid" };
    bindingEmail = email;
  } else {
    return { ok: false, reason: "invalid" };
  }

  const now = input.now ?? (await databaseNow());
  const language = copyLanguage(input.language);
  const copyVersion = CURRENT_CONSENT_COPY_VERSION;
  const copyHash = consentCopyHash("signupNotice", language, copyVersion);
  if (!copyHash) throw new Error("The sign-up notice has no approved wording in this version.");

  const country = estimatedCountryFromHeader(input.ipCountry);
  const candidates: SignupConsentCandidate[] = [];
  if (country) {
    // The rule the screen rendered under: the active policy version's rule for
    // this country, or none (0) where the country has no rule.
    const rule = await prisma.releaseNotesCountryRule.findFirst({
      where: { countryCode: country, policyVersion: { status: "active" } },
      select: { ruleVersion: true },
    });
    candidates.push({ country, signal: "ip_estimated", ruleVersion: rule?.ruleVersion ?? 0, copyHash });
  }

  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SIGNUP_CONSENT_TTL_MS);
  const created = await prisma.$transaction(async (tx) => {
    // Unticking and trying again replaces the earlier choice, in the same
    // transaction as the new one, so a tab never holds two live choices.
    if (input.supersede) {
      await tx.signupConsentAttempt.updateMany({
        where: {
          id: input.supersede.attemptId,
          nonceHash: nonceHash(input.supersede.nonce),
          consumedAt: null,
          supersededAt: null,
        },
        data: { supersededAt: now },
      });
    }
    return tx.signupConsentAttempt.create({
      data: {
        nonceHash: nonceHash(nonce),
        channel: input.channel,
        bindingProvider,
        bindingEmail,
        expressOptInRequested: input.expressOptInRequested,
        // The attempt exists only because the screen with the notice on it was
        // submitted; B was shown.
        noticeShown: true,
        objected: input.objected,
        copyVersion,
        language,
        countryCandidates: candidates,
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    });
  });
  return { ok: true, attemptId: created.id, nonce, expiresAt };
}

export type FinalizeSignupConsentResult =
  | {
      ok: true;
      confirmationRequested: boolean;
      /** The opt-in was consented at once from a proven session (docs/policy/email-double-opt-in.md §14). */
      consentGranted?: boolean;
    }
  | {
      ok: false;
      reason: "disabled" | "not_found" | "confirmation_unavailable" | SignupConsentRefusal;
    };

/**
 * The refusals that are final answers, which the route returns as 200.
 * Everything else -- above all `confirmation_unavailable`, which rolled back
 * and left the attempt pending -- is worth another try, and answers 503.
 *
 * Final for this request is not the same as spent: `binding_mismatch`,
 * `account_predates_attempt` and `not_created_by_this_sign_in` say *this
 * account* cannot use the attempt, which stays pending for the one that can,
 * so the tab keeps it. Only `not_found` and `not_pending` mean the attempt
 * itself is gone (components/auth/signupConsentClient.ts).
 */
export const TERMINAL_FINALIZE_REFUSALS: ReadonlySet<string> = new Set([
  "not_found",
  "not_pending",
  "not_created_by_this_sign_in",
  "account_predates_attempt",
  "account_age_unknown",
  "binding_mismatch",
  "account_already_consumed",
]);

const RACED = Symbol("raced");
const CONFIRMATION_UNAVAILABLE = Symbol("confirmation_unavailable");

/**
 * Consumes the choice for the account this sign-in just created.
 *
 * One transaction: the consumption, the estimated country, `notice_shown`, the
 * objection if there was one, and the confirmation request if the box was
 * ticked (section 5.2). Split, a choice could be consumed with its evidence or
 * its confirmation mail missing, and nothing shows the screen again to redo it.
 * A refusal leaves everything as it was; the account exists either way.
 */
/**
 * The answer for an attempt this account already consumed -- a retry whose
 * first answer was lost, or the loser of a concurrent pair. It says whether
 * that consumption consented at once, read from the ledger it wrote, so the
 * retry does not look like a sign-up that ticked nothing
 * (docs/policy/email-double-opt-in.md §14).
 */
async function consumedAnswer(userId: string): Promise<FinalizeSignupConsentResult> {
  const granted = await prisma.consentRecord.findFirst({
    where: { userId, capturedVia: "signup_form", action: "granted" },
    select: { id: true },
  });
  return granted
    ? { ok: true, confirmationRequested: false, consentGranted: true }
    : { ok: true, confirmationRequested: false };
}

export async function finalizeSignupConsentAttempt(input: {
  userId: string;
  /** The asking session's sign-in created the account (`accountCreatedBySignIn`). */
  createdBySignIn: boolean;
  /** The login row that sign-in spent, from its token (`signupEmailLoginAttemptId`). */
  emailLoginAttemptId?: string | null;
  /**
   * What that sign-in proved about the address, from its token
   * (`addressProof`). With it a ticked opt-in is consented at once; without it
   * the confirmation mail goes (docs/policy/email-double-opt-in.md §14).
   */
  addressProof?: unknown;
  attemptId: string;
  nonce: string;
  now?: Date;
}): Promise<FinalizeSignupConsentResult> {
  if (!(await isEmailSignupConsentEnabled())) return { ok: false, reason: "disabled" };
  const now = input.now ?? (await databaseNow());

  const attempt = await prisma.signupConsentAttempt.findUnique({ where: { id: input.attemptId } });
  if (!attempt || attempt.nonceHash !== nonceHash(input.nonce)) {
    return { ok: false, reason: "not_found" };
  }
  // Already consumed by this account: a retry whose first answer was lost.
  // The same answer again, so the tab counts it as consumed -- reading it as a
  // refusal would let the landing's own estimate overwrite the one the sign-up
  // just recorded.
  if (attempt.consumedAt && attempt.userId === input.userId) {
    return consumedAnswer(input.userId);
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      createdAt: true,
      email: true,
      accounts: { select: { provider: true } },
      signupConsentAttempt: { select: { id: true } },
    },
  });
  if (!user) return { ok: false, reason: "not_found" };

  const email = user.email ? normalizeEmailLoginAddress(user.email) : null;
  // The row the session named, and no other (section 5.2a).
  const spentRow =
    attempt.channel === "email_code" && input.emailLoginAttemptId
      ? await prisma.emailLoginAttempt.findUnique({
          where: { id: input.emailLoginAttemptId },
          select: { email: true, consumedAt: true, signupHoldUsedAt: true },
        })
      : null;
  const spentAt = spentRow ? (spentRow.signupHoldUsedAt ?? spentRow.consumedAt) : null;
  const emailLoginSpent = spentRow && spentAt ? { email: spentRow.email, spentAt } : null;

  const refusal = signupConsentRefusal({
    attempt,
    account: {
      createdAt: user.createdAt,
      email,
      providers: user.accounts.map((account) => account.provider),
      alreadyConsumed: user.signupConsentAttempt !== null,
      createdBySignIn: input.createdBySignIn,
    },
    emailLoginSpent,
    now,
  });
  if (refusal) return { ok: false, reason: refusal };
  if (!user.email) return { ok: false, reason: "binding_mismatch" };

  const candidates = attempt.countryCandidates as SignupConsentCandidate[];
  const candidate = candidates[0] ?? null;
  const resolved = candidate
    ? {
        countryCode: candidate.country,
        profileKey: profileForCountry(candidate.country),
        confidence: "estimated",
        source: "ip_estimated",
      }
    : { countryCode: "ZZ", profileKey: "ZZ", confidence: "unknown", source: "unresolved" };
  const copyHash = consentCopyHash(
    "signupNotice",
    copyLanguage(attempt.language),
    attempt.copyVersion
  );
  if (!copyHash) throw new Error(`Consent copy ${attempt.copyVersion} has no sign-up notice.`);

  const record = {
    userId: input.userId,
    emailAddress: user.email,
    surface: "signup",
    copyHash,
    candidates,
    resolved,
    occurredAt: attempt.createdAt,
    capturedVia: "signup_form" as const,
  };

  // Read before the transaction: the publication check is cached and reads
  // on the root client. The relationship it gates starts only under a
  // sign-up notice that disclosed it (lib/auRelationshipCore.ts).
  const amendmentInForce = attempt.objected ? false : await isEmailPolicyPublished(now);
  const jurisdictionColumns = noticeJurisdictionColumns(resolved);

  // A ticked box from a session that proved the address is the consent itself
  // (docs/policy/email-double-opt-in.md §14.2). Checked before the transaction;
  // the grant is written inside it, under the user row lock. Refused -- no
  // proof, a country marketing cannot reach -- it takes the confirmation mail,
  // which makes its own checks and rolls everything back if it cannot go.
  const sessionGrant =
    attempt.expressOptInRequested && candidate
      ? await prepareVerifiedSessionGrant({
          userId: input.userId,
          proof: input.addressProof,
          purposes: signupOptInPurposes(),
          // The estimate this transaction is about to record: the user row does
          // not hold it yet.
          jurisdiction: {
            countryCode: candidate.country,
            profileKey: profileForCountry(candidate.country),
            confidence: "estimated",
            source: "ip_estimated",
            conflicts: [],
            observedIpCountry: candidate.country,
          } satisfies ResolvedJurisdiction,
        })
      : null;

  // The confirmation mail is the fallback for a missing proof only, as on the
  // settings screen. Any other refusal -- the flag, a country marketing cannot
  // reach -- would also refuse the link's confirmation, so mailing it would
  // queue mail that can never become consent; it rolls back instead.
  const mailFallback =
    sessionGrant !== null && !sessionGrant.ok && sessionGrant.reason === "no_proof";
  // Seeded before the transaction, and only on the path that requests: a
  // request inside it seeding on the root client would wait on the row the
  // first purpose locked, and a refusal must leave no rows behind.
  if (mailFallback) await ensureDefaultPreferences(input.userId);

  let confirmationRequested = false;
  let consentGranted = false;
  try {
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.signupConsentAttempt.updateMany({
        where: {
          id: attempt.id,
          consumedAt: null,
          supersededAt: null,
          expiresAt: { gt: now },
        },
        data: {
          consumedAt: now,
          userId: input.userId,
          bindingEmailLoginAttemptId: emailLoginSpent ? (input.emailLoginAttemptId ?? null) : null,
        },
      });
      if (consumed.count !== 1) throw RACED;

      if (candidate) {
        await recordEstimatedCountry({
          userId: input.userId,
          ipCountry: candidate.country,
          now,
          client: tx,
        });
      }
      await recordNoticeShown({ ...record, client: tx });
      if (attempt.objected) await recordNoticeObjection({ ...record, client: tx });
      // Section 4.4's start event. Not for a person who used the refusal
      // control: they told us no, and a relationship is not a way around it.
      if (!attempt.objected) {
        await recordRelationshipStarted(tx, {
          userId: input.userId,
          emailAddress: user.email as string,
          copyVersion: attempt.copyVersion,
          copyHash,
          channel: attempt.channel,
          amendmentInForce,
          jurisdiction: jurisdictionColumns.country,
          jurisdictionSource: jurisdictionColumns.source,
          occurredAt: now,
        });
      }

      // A ticked box ends in a confirmation mail or in nothing at all (section
      // 5.2): if the request cannot be made, the whole consumption rolls back
      // and the attempt stays pending for the tab to try again. The page only
      // shows the box where a country and the confirmation lane exist, so this
      // is the lane going away between the two, not an ordinary path.
      if (attempt.expressOptInRequested && sessionGrant?.ok) {
        const { grant } = sessionGrant;
        // All or none, and one result notice for the lot (the grant's hook).
        for (const purpose of signupOptInPurposes()) {
          const outcome = await applyPreferenceChange(tx, {
            userId: input.userId,
            purpose,
            enabled: true,
            capturedVia: "signup_form",
            source: "signup",
            evidenceVia: "signup_form",
            jurisdiction: grant.jurisdiction.countryCode,
            jurisdictionSource: grant.jurisdiction.source,
            confirmation: grant.confirmation,
            onConsentRecorded: grant.onConsentRecorded,
            now,
            policyVersionId: grant.policyVersionId,
            confirmedCountry: null,
          });
          // A consent that could not be written leaves nothing: the whole
          // consumption rolls back and the landing tries again.
          if (outcome !== "changed" && outcome !== "already_set") throw CONFIRMATION_UNAVAILABLE;
        }
        consentGranted = true;
      } else if (attempt.expressOptInRequested) {
        if (!candidate || !mailFallback) throw CONFIRMATION_UNAVAILABLE;
        // Without a proof, one confirmation per purpose, as the in-product
        // notice asks them (docs/policy/email-double-opt-in.md §14.8).
        for (const purpose of signupOptInPurposes()) {
          const requested = await requestConsentConfirmation({
            userId: input.userId,
            purpose,
            capturedVia: "signup_form",
            confirmedCountry: candidate.country,
            jurisdiction: candidate.country,
            jurisdictionSource: "ip_estimated",
            countrySource: "ip_estimated",
            evidenceVia: "signup_form",
            language: attempt.language,
            now,
            client: tx,
            preferencesSeeded: true,
          });
          if (!requested.requested) throw CONFIRMATION_UNAVAILABLE;
        }
        confirmationRequested = true;
      }
    });
  } catch (error) {
    if (error === RACED) {
      // Lost the race to a concurrent request -- the same answer if that one
      // was this account's own.
      const winner = await prisma.signupConsentAttempt.findUnique({
        where: { id: attempt.id },
        select: { consumedAt: true, userId: true },
      });
      if (winner?.consumedAt && winner.userId === input.userId) {
        return consumedAnswer(input.userId);
      }
      return { ok: false, reason: "not_pending" };
    }
    if (error === CONFIRMATION_UNAVAILABLE) return { ok: false, reason: "confirmation_unavailable" };
    throw error;
  }
  return consentGranted
    ? { ok: true, confirmationRequested, consentGranted }
    : { ok: true, confirmationRequested };
}

/**
 * Records the country a signed-in request's IP estimates, for an account that
 * has none recorded (draft section 5.3 item 6: existing accounts, at their next
 * sign-in). Never over a declaration or billing (`recordEstimatedCountry()`).
 */
export async function recordSignInEstimatedCountry(input: {
  userId: string;
  ipCountry: string | null | undefined;
}) {
  // Behind the same collection gate as the sign-up devices: turning it on is
  // the decision to start recording estimates about accounts.
  if (!(await isEmailSignupConsentEnabled())) return { recorded: false as const };
  const country = estimatedCountryFromHeader(input.ipCountry);
  if (!country) return { recorded: false as const };
  const result = await recordEstimatedCountry({ userId: input.userId, ipCountry: country });
  return { recorded: result.recorded };
}
