import {
  renderJurisdictionFooter,
  type BusinessIdentity,
  type FooterProfile,
} from "@/lib/emailFooterRenderer";

/**
 * The step between "the template rendered" and "the provider was called".
 *
 * The pieces existed and nothing joined them: M7 built the footer renderer and
 * the jurisdiction profiles, M2 built the templates, and the composition was in
 * neither scope. `renderJurisdictionFooter()` was called only from its own test,
 * and `subjectPrefix` was read only by the seed and the policy reader. A KR
 * marketing message would have gone out with no `(광고)` in its subject
 * (EM-04).
 *
 * That is why `EmailDelivery.jurisdictionProfileKey` and `policyVersionId` are
 * pinned at enqueue: this is the step that reads them. Composing from the
 * *active* policy instead would mean a message enqueued under one set of
 * labelling rules could be sent under another, and the delivery row would
 * record the first while the recipient received the second.
 *
 * Pure, and separate from the lane, because the interesting cases are the
 * refusals and they should be testable without a database or a provider.
 *
 * Contract: docs/policy/email-notifications.md §5.2 E1-E3, §8.5, §8.6.
 */

export type ComposableProfile = {
  profileKey: string;
  subjectPrefix: string | null;
  footerBlocks: readonly string[];
  unsubscribeSlaBusinessDays: number;
};

export type RenderedMessage = { subject: string; html: string; text: string };

export type CompositionInput = {
  classification: string;
  /**
   * The template's own flag, not the classification.
   *
   * The same value drives the `List-Unsubscribe` headers, so the footer link
   * and the header cannot disagree about whether this message has one -- and
   * the database holds that flag as a CHECK against the classification.
   */
  requiresUnsubscribe: boolean;
  /** Null when the pinned policy version has no row for the pinned key. */
  profile: ComposableProfile | null;
  identity: BusinessIdentity;
  language: string;
  unsubscribeUrl?: string | null;
  reasonLine?: string | null;
  rendered: RenderedMessage;
};

export type CompositionResult =
  | {
      ok: true;
      rendered: RenderedMessage;
      appliedPrefix: boolean;
      appliedFooter: boolean;
      /**
       * Why a non-marketing message went out with less than the profile named.
       * Empty on the normal path. Never non-empty for marketing -- that is a
       * refusal instead.
       */
      degraded: string[];
    }
  | { ok: false; skipReason: string; missing: string[] };

/**
 * Blocks that only exist on a message that has an unsubscribe link.
 *
 * Dropped rather than refused for transactional mail, because the ZZ profile is
 * deliberately a complete marketing profile -- transactional and legal mail go
 * out under it and need its business identity, but a login receipt carrying an
 * unsubscribe link is C10's failure: several clients render `List-Unsubscribe`
 * as a button, and on a receipt it unsubscribes somebody from their own
 * account mail.
 */
const UNSUBSCRIBE_BLOCKS = new Set(["unsubscribe_link", "unsubscribe_reason"]);

/**
 * The advertising label is for advertising.
 *
 * KR 정보통신망법 제50조 and Singapore's Second Schedule both attach to 영리목적
 * 광고성 정보 / commercial messages. Putting `(광고)` on a payment receipt
 * would not be over-compliance, it would be a false statement about what the
 * message is -- and it would train the recipient to ignore the label on the
 * messages that must carry it.
 */
const labelledClassification = (classification: string) =>
  classification === "marketing";

export const composeJurisdictionalMessage = (
  input: CompositionInput
): CompositionResult => {
  const marketing = labelledClassification(input.classification);
  const degraded: string[] = [];

  if (!input.profile) {
    // A marketing message whose labelling rules cannot be read is one that must
    // not be sent: the subject prefix is the requirement most likely to be
    // missing, and an unlabelled advertisement cannot be taken back.
    if (marketing) {
      return { ok: false, skipReason: "jurisdiction_profile_missing", missing: ["profile"] };
    }
    degraded.push("profile_missing");
    return {
      ok: true,
      rendered: input.rendered,
      appliedPrefix: false,
      appliedFooter: false,
      degraded,
    };
  }

  const blocks = input.profile.footerBlocks.filter(
    (block) => input.requiresUnsubscribe || !UNSUBSCRIBE_BLOCKS.has(block)
  );

  const footerProfile: FooterProfile = {
    profileKey: input.profile.profileKey,
    footerBlocks: blocks,
    unsubscribeSlaBusinessDays: input.profile.unsubscribeSlaBusinessDays,
  };

  const footer = blocks.length
    ? renderJurisdictionFooter({
        profile: footerProfile,
        identity: input.identity,
        language: input.language,
        unsubscribeUrl: input.unsubscribeUrl,
        reasonLine: input.reasonLine,
      })
    : ({ ok: false, missing: [] as string[] } as const);

  if (footer.ok === false) {
    if (marketing) {
      return {
        ok: false,
        skipReason: "jurisdiction_footer_incomplete",
        missing: footer.missing,
      };
    }
    // Transactional mail is not held for this. The business identity footer is
    // owed, and an unset environment variable is a configuration gap rather
    // than a regulatory one -- refusing here would stop an account-deletion
    // notice, which is the message least able to wait. The caller reports it.
    degraded.push(
      footer.missing.length ? `footer_missing:${footer.missing.join(",")}` : "footer_empty"
    );
  }

  const prefix = marketing ? input.profile.subjectPrefix?.trim() : null;
  // Compared against the trimmed prefix so `<ADV> `, whose trailing space is
  // part of the seeded value, does not double when a subject already carries
  // it. Re-rendering from the stored snapshot means this should never happen;
  // it is here because "should never" is how a subject acquires `(광고)(광고)`.
  const appliedPrefix = Boolean(prefix) && !input.rendered.subject.startsWith(prefix as string);
  const subject = appliedPrefix
    ? `${input.profile.subjectPrefix}${input.rendered.subject}`
    : input.rendered.subject;

  const appliedFooter = footer.ok === true;

  return {
    ok: true,
    appliedPrefix,
    appliedFooter,
    degraded,
    rendered: {
      subject,
      html: appliedFooter
        ? `${input.rendered.html}<hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0 12px;">${footer.html}`
        : input.rendered.html,
      text: appliedFooter
        ? `${input.rendered.text}\n\n--\n${footer.text}\n`
        : input.rendered.text,
    },
  };
};
