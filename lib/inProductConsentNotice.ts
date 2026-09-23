import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { emailAddressDigest } from "@/lib/emailAddressDigest";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { suppressionCheck } from "@/lib/emailSuppression";
import {
  EMAIL_ADDRESS_NORMALIZATION_VERSION,
  normalizeEmailAddress,
} from "@/lib/emailSuppressionCore";
import {
  inProductNoticeOffer,
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
 * ## What is deliberately missing
 *
 * The wording. Section 5.4's copy belongs to S2 and is approved by the owner
 * rather than written here, and it has to exist in seven languages. So
 * `recordNoticeShown()` takes the copy hash from its caller and refuses
 * without one: a `notice_shown` row that cannot say which words were on the
 * screen is a record that we asked, with no way to ever show what we asked.
 *
 * ## Before a screen is wired to this
 *
 * Section 5.3's existing-account country recording is not built yet, and it
 * has to be before anything renders. `recordNoticeShown()` pins whatever
 * `jurisdictionForUser()` answers at the time, and for an account that has
 * never declared a country that is `ZZ` / `unresolved`. The row is
 * append-only, so a `notice_shown` written today would permanently fail to
 * say which country's rule the person was shown -- which is the one thing
 * section 5.3 requires it to carry. The evidence would need the applied
 * country, its source and the rule version alongside the copy hash.
 */

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
    });
  }

  const purposes = noticePurposes();

  // The three states are read separately because they are three facts. An
  // account can have been shown the notice, not consented and not objected,
  // and that combination is the ordinary one -- somebody who closed it.
  const [consent, shown, objected, suppressions] = await Promise.all([
    db.consentRecord.findFirst({
      where: { emailAddress, purpose: { in: purposes }, action: "granted" },
      select: { id: true },
    }),
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
  ]);

  return inProductNoticeOffer({
    emailAddress,
    hasExpressConsent: consent !== null,
    noticeAlreadyShown: shown !== null,
    // Keyed by address rather than by account: a refusal follows the mailbox,
    // for the same reason a suppression does.
    hasObjected: objected !== null,
    // Any one of them. The notice asks about the set, so a refusal anywhere
    // in the set is a refusal of the question being put.
    suppressed: suppressions.some((verdict) => !verdict.allowed),
  });
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
  const existing = await db.emailPermissionEvent.findUnique({ where });
  if (existing) return existing;

  const jurisdiction = await jurisdictionForUser({ userId: input.userId });
  const policyVersionId = await ensureBootstrapPolicyVersion();

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
        jurisdiction: jurisdiction.countryCode,
        jurisdictionSource: jurisdiction.source,
        policyVersionId,
        evidence: { surface: input.surface, copyHash: input.copyHash },
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
    return raced;
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
