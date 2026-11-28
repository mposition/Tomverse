import "server-only";

import {
  appUrl,
  buildAccountDeletionScheduledEmail,
  buildAccountRestoredEmail,
  buildAccountWelcomeEmail,
  renderEmailButton,
  renderEmailParagraph,
  renderTransactionalEmailLayout,
} from "@/lib/accountEmails";
import {
  buildAdminPlanChangedEmail,
  buildBillingWelcomeEmail,
  buildFoundingTesterPassEmail,
  buildPlanChangeEmail,
} from "@/lib/billingEmails";
import {
  buildEmailLoginCodeEmail,
  buildLoginMethodLinkedEmail,
  buildLoginMethodUnlinkedEmail,
  type LoginMethodNoticePayload,
} from "@/lib/emailLoginEmails";
import { buildModelLaunchEmail } from "@/lib/modelLaunchEmail";
import type { ModelLaunchPayload } from "@/lib/modelLaunchEmail";
import {
  buildProductAnnouncementEmail,
  PRODUCT_ANNOUNCEMENT_PLACEHOLDER,
  type ProductAnnouncementPayload,
} from "@/lib/productAnnouncementEmail";
import {
  buildMarketingConsentConfirmationEmail,
  MARKETING_CONSENT_CONFIRMATION_PLACEHOLDER,
  prepareConsentConfirmationForSend,
  type MarketingConsentConfirmationPayload,
  type StoredConsentConfirmationPayload,
} from "@/lib/marketingConsentConfirmationEmail";
import { createConsentToken, readConsentKeyring } from "@/lib/emailConsentToken";
import { buildModelLifecycleDailyEmail } from "@/lib/modelLifecycleDailyEmail";
import type { LifecycleReportInput } from "@/lib/modelLifecycleDailyReportCore";
import {
  senderRoleAllowedOnStream,
  streamForClassification,
  type SenderRole,
} from "@/lib/emailSendingIdentityCore";

/**
 * Every message this system can send, and what kind of message each one is.
 *
 * Contract: docs/policy/email-notifications.md §3, §8.5.
 *
 * One table rather than a classification argument at each call site. The
 * classification decides the recipient set, the footer, whether an unsubscribe
 * link appears and whether a human has to approve the send, so it is a property
 * of the message and not of the moment somebody sends it. A caller that could
 * pass its own classification could send a promotion as a legal notice, which
 * is precisely the failure §3.2 names as the most common one.
 *
 * The database holds the same rule as a CHECK, so a definition that disagrees
 * with itself -- marketing without an unsubscribe link, transactional with one
 * -- cannot be registered at all.
 */

export type EmailClassification =
  | "transactional"
  | "service"
  | "legal"
  | "marketing";

export type RenderedEmail = { subject: string; html: string; text: string };

export type EmailTemplateDefinition<Payload> = {
  key: string;
  classification: EmailClassification;
  /**
   * Who the recipient sees this message as being from.
   *
   * A property of the message, exactly like `classification` above and for the
   * same reason: a caller that could pass its own would eventually send a
   * refund decision as the security sender. It also makes the queue correct for
   * free -- the drain re-reads the definition by template key on every attempt,
   * so a retry three hours later resolves the same role as the first send
   * rather than one recomputed from whatever the retry knows
   * (docs/policy/email-notifications.md §14.1a).
   *
   * The two axes are checked against each other in `templateDefinitionProblems`
   * below: only `marketing` may sit on a marketing classification, and only the
   * transactional roles on the rest.
   */
  senderRole: SenderRole;
  /**
   * Which EmailPreference gates this. Absent for transactional and legal, and
   * the database insists on that: giving a login code a purpose would imply it
   * could be switched off.
   */
  purpose: string | null;
  requiresUnsubscribe: boolean;
  /**
   * Pure, deterministic, and free of `new Date()` or randomness.
   *
   * The drain renders from the stored snapshot rather than from live rows, so
   * the same payload must produce the same bytes months later -- otherwise the
   * provider's idempotency key stops suppressing duplicates and the audit
   * reproduction reproduces something else.
   */
  render: (payload: Payload, language: string) => RenderedEmail;
  /**
   * The payload used to register the TemplateVersion.
   *
   * Registering a rendered message instead would mint a new version per send,
   * because the amount and the name differ every time. Rendering with these
   * yields the copy with its variables still visible, which is hash-stable and
   * an honest artefact of what shipped.
   */
  placeholderPayload: Payload;
  /**
   * Turns the stored snapshot into the payload `render` takes, at send time.
   *
   * For a message that carries a capability -- a link that does something when
   * followed -- the capability is not stored in the snapshot at all. This
   * re-creates it from non-secret fields on every attempt and names the secret
   * strings, which the lane replaces with a placeholder before computing the
   * audit hash (docs/policy/email-notifications.md §10.3). Must be deterministic
   * for the same reason `render` is.
   */
  prepareForSend?: (stored: any) => { payload: Payload; secrets: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDefinition = EmailTemplateDefinition<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type AccountWelcomePayload = { name: string | null };
export type AccountDeletionScheduledPayload = { scheduledFor: string };
export type AccountRestoredPayload = Record<string, never>;
export type BillingWelcomePayload = {
  plan: string | null;
  billingInterval: string | null;
  /** ISO string. A Date does not survive JSON, and the snapshot is JSON. */
  periodEnd: string | null;
};
/**
 * The pass notices carry one variable between them.
 *
 * ISO string, not a Date: the snapshot is JSON and a Date does not survive
 * it. Null renders as the locale's "not available", which is what the
 * renderer already did for a missing date.
 */
export type FoundingTesterPassPayload = { periodEnd: string | null };
/** The two plan-change confirmations. Dates are ISO strings resolved by the caller. */
export type PlanChangeEmailPayload = {
  fromPlan: string | null;
  toPlan: string | null;
  billingInterval: string | null;
  effectiveAt: string | null;
};
export type AdminPlanChangedPayload = {
  plan: string | null;
  billingInterval: string | null;
  periodEnd: string | null;
  reason: string | null;
};
export type LoginCodePayload = { code: string; verifyUrl: string };
/**
 * The whole report, as the structure both renderers read.
 *
 * Stored on the delivery row and re-rendered from there on every attempt, which
 * is why the caller resolves the dates and the URL rather than the template
 * reading a clock: a retry three hours later must produce the same bytes or the
 * provider stops recognising it as the same message.
 */
export type OpsModelLifecycleDailyPayload = LifecycleReportInput;

export const ACCOUNT_WELCOME_TEMPLATE = "account_welcome";
export const ACCOUNT_DELETION_SCHEDULED_TEMPLATE = "account_deletion_scheduled";
export const ACCOUNT_RESTORED_TEMPLATE = "account_restored";
export const BILLING_WELCOME_TEMPLATE = "billing_welcome";
export const AUTH_LOGIN_CODE_TEMPLATE = "auth_login_code";
export const OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE = "ops_model_lifecycle_daily";
export const MODEL_LAUNCH_TEMPLATE = "model_launch";
export const PRODUCT_ANNOUNCEMENT_TEMPLATE = "product_announcement";
export const MARKETING_CONSENT_CONFIRMATION_TEMPLATE =
  "marketing_consent_confirmation";
/**
 * Three keys rather than one with a phase field.
 *
 * A TemplateVersion is a hash of one message's copy. Folding three notices
 * behind a phase variable would give them one hash, and the audit
 * reproduction could no longer say which of the three a delivery was.
 */
export const FOUNDING_TESTER_PASS_STARTED_TEMPLATE =
  "founding_tester_pass_started";
export const FOUNDING_TESTER_PASS_REMINDER_TEMPLATE =
  "founding_tester_pass_reminder";
export const FOUNDING_TESTER_PASS_ENDED_TEMPLATE = "founding_tester_pass_ended";
export const ADMIN_PLAN_CHANGED_TEMPLATE = "admin_plan_changed";
/** Two keys for the same reason as the pass notices above: one hash per message. */
export const PLAN_CHANGE_UPGRADED_TEMPLATE = "plan_change_upgraded";
export const PLAN_CHANGE_DOWNGRADE_SCHEDULED_TEMPLATE =
  "plan_change_downgrade_scheduled";
/**
 * The two login-method notices. Two keys rather than one with a branch: the
 * registry hashes one `placeholderPayload` per template, so a template that
 * rendered two subjects would have an artifact matching neither
 * (docs/policy/email-product-news-redesign-draft.md section 7.4, C36).
 */
export const LOGIN_METHOD_LINKED_TEMPLATE = "login_method_linked";
export const LOGIN_METHOD_UNLINKED_TEMPLATE = "login_method_unlinked";
/**
 * The privacy-policy and terms amendment notice (S10). Legal, so it reaches the
 * people who turned everything switchable off -- they are who the amendment is
 * most about. Its wording counts as the notice only once approved
 * (`CHANGE_NOTICE_APPROVED_CONTENT_HASHES` in lib/emailPolicyPublication.ts).
 */
export const POLICY_CHANGE_NOTICE_TEMPLATE = "policy_change_notice";
/** The 14-day processing-result notices (docs/policy/email-consent-copy-draft.md §4.1, §4.2). */
export const CONSENT_RESULT_NOTICE_TEMPLATE = "consent_result_notice";
export const UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE = "unsubscribe_result_notice";
/**
 * A scheduled task's result notices (lib/scheduledTaskNotice.ts): a run
 * answered, or the task paused itself. Two keys for the same reason as the pass
 * notices -- one hash per message.
 */
export const SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE = "scheduled_task_run_answered";
export const SCHEDULED_TASK_PAUSED_TEMPLATE = "scheduled_task_paused";
/**
 * The task's own name, when it ran (already written in the account's language
 * and the task's zone) and two links. Never any of the answer: the answer stays
 * in the conversation the link opens.
 */
export type ScheduledTaskNoticePayload = {
  taskTitle: string;
  runAt: string;
  actionUrl: string;
  settingsUrl: string;
};
const SCHEDULED_TASK_NOTICE_PLACEHOLDER: ScheduledTaskNoticePayload = {
  taskTitle: "{{taskTitle}}",
  runAt: "{{runAt}}",
  actionUrl: "{{actionUrl}}",
  settingsUrl: "{{settingsUrl}}",
};

const definitions: AnyDefinition[] = [
  {
    key: AUTH_LOGIN_CODE_TEMPLATE,
    senderRole: "security",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: LoginCodePayload, language) =>
      buildEmailLoginCodeEmail({ ...payload, language }),
    placeholderPayload: { code: "{{code}}", verifyUrl: "{{verifyUrl}}" },
  },
  {
    key: MARKETING_CONSENT_CONFIRMATION_TEMPLATE,
    senderRole: "general",
    // Transactional, although it is about marketing: it goes to somebody who
    // has not yet consented, so filed as marketing the consent gate would refuse
    // the very message that lets them consent -- and filed as marketing it would
    // be advertising sent without consent. It carries no promotion and no
    // unsubscribe link (docs/policy/email-double-opt-in.md §3 rules 2-3).
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: MarketingConsentConfirmationPayload, language) =>
      buildMarketingConsentConfirmationEmail(payload, language),
    placeholderPayload: MARKETING_CONSENT_CONFIRMATION_PLACEHOLDER,
    // The link is a capability and is never stored; see prepareForSend above.
    prepareForSend: (stored: StoredConsentConfirmationPayload) => {
      const keyring = readConsentKeyring(process.env);
      if (!keyring) {
        throw new Error("EMAIL_CONSENT_KEYS is not configured; the confirmation link cannot be built.");
      }
      return prepareConsentConfirmationForSend(stored, {
        createToken: (payload, version) => createConsentToken(payload, keyring, version),
        appUrl: appUrl(),
      });
    },
  },
  {
    key: ACCOUNT_WELCOME_TEMPLATE,
    senderRole: "general",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: AccountWelcomePayload, language) =>
      buildAccountWelcomeEmail({ ...payload, language }),
    placeholderPayload: { name: "{{name}}" },
  },
  {
    key: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
    senderRole: "security",
    // Legal rather than transactional: it is the notice that an account and
    // everything in it is about to be destroyed, and it has to reach someone
    // who has switched off everything switchable.
    classification: "legal",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: AccountDeletionScheduledPayload, language) =>
      buildAccountDeletionScheduledEmail({ ...payload, language }),
    placeholderPayload: { scheduledFor: "{{scheduledFor}}" },
  },
  {
    key: POLICY_CHANGE_NOTICE_TEMPLATE,
    // From the company's ordinary address: it is neither a credential nor money,
    // and the recipient should recognise it as the service writing about its
    // own terms.
    senderRole: "general",
    classification: "legal",
    purpose: null,
    requiresUnsubscribe: false,
    render: (_payload: PolicyChangeNoticePayload, language) =>
      buildPolicyChangeNoticeEmail({ language, appUrl: appUrl() }),
    placeholderPayload: {},
  },
  {
    key: CONSENT_RESULT_NOTICE_TEMPLATE,
    // The result of a consent, within 14 days (Korea's 제50조제7항). Not
    // advertising: it reports a processing result, carries no promotion and no
    // unsubscribe link, and goes out whatever the marketing switches say.
    senderRole: "general",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: ProcessingResultNoticePayload, language) =>
      buildProcessingResultNotice("consent", payload, language),
    placeholderPayload: { date: "{{consentDate}}" },
  },
  {
    key: UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE,
    // The result of an unsubscribe or a withdrawal. Sent to the address that
    // just unsubscribed, because it is the result of that request and not
    // advertising (docs/policy/email-consent-copy-draft.md §4.2).
    senderRole: "general",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: ProcessingResultNoticePayload, language) =>
      buildProcessingResultNotice("unsubscribe", payload, language),
    placeholderPayload: { date: "{{processedDate}}" },
  },
  {
    key: LOGIN_METHOD_LINKED_TEMPLATE,
    // A login method changed and every other device may have been signed out.
    // If it was not the account holder, this is what they act on -- so it is
    // security, and no preference switches it off.
    senderRole: "security",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: LoginMethodNoticePayload, language) =>
      buildLoginMethodLinkedEmail(payload, language),
    placeholderPayload: { method: "google" },
  },
  {
    key: LOGIN_METHOD_UNLINKED_TEMPLATE,
    senderRole: "security",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: LoginMethodNoticePayload, language) =>
      buildLoginMethodUnlinkedEmail(payload, language),
    placeholderPayload: { method: "google" },
  },
  {
    key: ACCOUNT_RESTORED_TEMPLATE,
    senderRole: "security",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (_payload: AccountRestoredPayload, language) =>
      buildAccountRestoredEmail({ language }),
    placeholderPayload: {},
  },
  {
    key: MODEL_LAUNCH_TEMPLATE,
    senderRole: "marketing",
    // A product announcement to people nothing has happened to. That is
    // marketing, whatever else it is about, and the alternative -- calling it
    // `service` so it reaches an audience that never opted in -- is the failure
    // docs/policy/email-notifications.md §3.2 names first.
    //
    // Registered before anything sends it, on purpose. The lane's three
    // marketing branches had never executed because no marketing template
    // existed, so the first real send would have been their first run (EM-03).
    classification: "marketing",
    purpose: "product_updates",
    requiresUnsubscribe: true,
    render: (payload: ModelLaunchPayload, language) =>
      buildModelLaunchEmail(payload, language),
    placeholderPayload: {
      modelName: "{{modelName}}",
      plans: "{{plans}}",
      highlights: ["{{highlight}}"],
      creditLine: "{{creditLine}}",
      ctaUrl: "https://tomverse.app/{{ctaUrl}}",
    },
  },
  {
    key: PRODUCT_ANNOUNCEMENT_TEMPLATE,
    senderRole: "marketing",
    classification: "marketing",
    purpose: "product_updates",
    requiresUnsubscribe: true,
    render: (payload: ProductAnnouncementPayload, language) =>
      buildProductAnnouncementEmail(payload, language),
    placeholderPayload: PRODUCT_ANNOUNCEMENT_PLACEHOLDER,
  },
  {
    key: OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE,
    senderRole: "operations",
    // Transactional, and the recipient is an operator rather than a customer:
    // there is no preference that gates it and no unsubscribe link, because the
    // person who receives it is on the address precisely to be interrupted.
    //
    // It goes through the standard lane rather than direct so it inherits the
    // history, the retries and the suppression check. That is safe here for the
    // reason the incident alerts are not: this report says nothing about the
    // email system -- it reports the provider catalogue -- so routing it through
    // the queue does not make it depend on the thing it would have to report on.
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: OpsModelLifecycleDailyPayload) =>
      buildModelLifecycleDailyEmail(payload),
    placeholderPayload: {
      localDate: "{{localDate}}",
      generatedLabel: "{{generatedLabel}}",
      workQueueUrl: "{{workQueueUrl}}",
      providers: [],
      workItems: [],
      lifecycleWarnings: [],
      missing: [],
      registry: { ran: false, disabled: [], restored: [], held: [] },
    },
  },
  {
    key: BILLING_WELCOME_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: BillingWelcomePayload, language) =>
      buildBillingWelcomeEmail({ ...payload, language }),
    placeholderPayload: {
      plan: "{{plan}}",
      billingInterval: "{{billingInterval}}",
      periodEnd: null,
    },
  },
  // Confirmation of a change the customer made themselves; transactional like
  // the receipt it follows (docs/policy/plan-change.md section 9).
  {
    key: PLAN_CHANGE_UPGRADED_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: PlanChangeEmailPayload, language) =>
      buildPlanChangeEmail("upgraded", { ...payload, language }),
    placeholderPayload: {
      fromPlan: "{{fromPlan}}",
      toPlan: "{{toPlan}}",
      billingInterval: "{{billingInterval}}",
      effectiveAt: null,
    },
  },
  {
    key: PLAN_CHANGE_DOWNGRADE_SCHEDULED_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: PlanChangeEmailPayload, language) =>
      buildPlanChangeEmail("downgrade_scheduled", { ...payload, language }),
    placeholderPayload: {
      fromPlan: "{{fromPlan}}",
      toPlan: "{{toPlan}}",
      billingInterval: "{{billingInterval}}",
      effectiveAt: null,
    },
  },
  // The plan a person is on is what they are owed for their money, so the four
  // notices below are transactional: none of them is switchable off, and none
  // carries an unsubscribe link (docs/policy/email-notifications.md §3.2).
  {
    key: FOUNDING_TESTER_PASS_STARTED_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: FoundingTesterPassPayload, language) =>
      buildFoundingTesterPassEmail("started", { ...payload, language }),
    placeholderPayload: { periodEnd: null },
  },
  {
    key: FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: FoundingTesterPassPayload, language) =>
      buildFoundingTesterPassEmail("reminder", { ...payload, language }),
    placeholderPayload: { periodEnd: null },
  },
  {
    key: FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    render: (payload: FoundingTesterPassPayload, language) =>
      buildFoundingTesterPassEmail("ended", { ...payload, language }),
    placeholderPayload: { periodEnd: null },
  },
  {
    key: ADMIN_PLAN_CHANGED_TEMPLATE,
    senderRole: "billing",
    classification: "transactional",
    purpose: null,
    requiresUnsubscribe: false,
    // The language argument is ignored because this copy exists in English
    // only; see buildAdminPlanChangedEmail.
    render: (payload: AdminPlanChangedPayload) =>
      buildAdminPlanChangedEmail(payload),
    placeholderPayload: {
      plan: "{{plan}}",
      billingInterval: "{{billingInterval}}",
      periodEnd: null,
      reason: null,
    },
  },
  {
    key: SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE,
    // Service mail about a task the account set up itself, with no promotion
    // in it: gated by the `scheduled_tasks` purpose (on by default, no consent)
    // and by the task's own switch (docs/policy/email-notifications.md §3.2).
    senderRole: "general",
    classification: "service",
    purpose: "scheduled_tasks",
    requiresUnsubscribe: false,
    render: (payload: ScheduledTaskNoticePayload, language) =>
      buildScheduledTaskNoticeEmail("answered", payload, language),
    placeholderPayload: SCHEDULED_TASK_NOTICE_PLACEHOLDER,
  },
  {
    key: SCHEDULED_TASK_PAUSED_TEMPLATE,
    senderRole: "general",
    classification: "service",
    purpose: "scheduled_tasks",
    requiresUnsubscribe: false,
    render: (payload: ScheduledTaskNoticePayload, language) =>
      buildScheduledTaskNoticeEmail("paused", payload, language),
    placeholderPayload: SCHEDULED_TASK_NOTICE_PLACEHOLDER,
  },
];

const byKey = new Map(definitions.map((definition) => [definition.key, definition]));

export const EMAIL_TEMPLATE_KEYS = definitions.map((definition) => definition.key);

export const emailTemplateDefinition = (key: string): AnyDefinition => {
  const definition = byKey.get(key);
  if (!definition) throw new Error(`Unknown email template "${key}".`);
  return definition;
};

/**
 * The rule the database also holds, available to a static check so a bad
 * definition fails the build rather than the insert.
 */
export const templateDefinitionProblems = (definition: AnyDefinition) => {
  const problems: string[] = [];
  const { key, classification, purpose, requiresUnsubscribe, senderRole } =
    definition;

  if (!senderRole) {
    problems.push(
      `${key}: names no sender role. Every message says who it is from, and ` +
        "the value it would take by omission is whoever the general identity is."
    );
  } else if (
    !senderRoleAllowedOnStream(streamForClassification(classification), senderRole)
  ) {
    problems.push(
      `${key}: is ${classification} mail sent as the "${senderRole}" sender, which ` +
        "belongs to the other stream. Refused rather than sent from the other " +
        "stream's domain (docs/policy/email-notifications.md §14.1a)."
    );
  }

  if (classification === "marketing" && !requiresUnsubscribe) {
    problems.push(`${key}: marketing mail must carry an unsubscribe link.`);
  }
  if (
    (classification === "transactional" || classification === "legal") &&
    requiresUnsubscribe
  ) {
    problems.push(
      `${key}: ${classification} mail must not carry an unsubscribe link. ` +
        "On a login code it is a button that locks people out of their account."
    );
  }
  if (
    (classification === "marketing" || classification === "service") &&
    !purpose
  ) {
    problems.push(`${key}: ${classification} mail must name the preference that gates it.`);
  }
  if (
    (classification === "transactional" || classification === "legal") &&
    purpose
  ) {
    problems.push(
      `${key}: ${classification} mail is not gateable, so a purpose would imply ` +
        "it can be switched off."
    );
  }
  return problems;
};

export const allTemplateDefinitions = () => [...definitions];

/* ------------------------------------------------------------------ *
 * The amendment notice (`policy_change_notice`).
 *
 * Here rather than in its own module because this file is in the Prompt
 * Refiner's sealed runtime source closure (lib/promptRefinerStageAdmissionCore.ts),
 * and a new module imported from here would grow that closure. What decides
 * whether this wording may be sent lives in lib/policyChangeNoticeEmail.ts.
 * ------------------------------------------------------------------ */

/**
 * The amendment notice: the legal message that tells every account the privacy
 * policy and the terms are changing, and when.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 10 and 12
 * (S10); docs/policy/email-policy-amendment-draft.md, which holds this wording
 * for approval.
 *
 * **The wording is a draft.** It counts as the notice only once its template
 * version's `contentHash` is listed in `CHANGE_NOTICE_APPROVED_CONTENT_HASHES`
 * (lib/emailPolicyPublication.ts), and that list is the owner's approval of it.
 * Until then a delivery of this template is recorded and counted as nothing.
 *
 * Built rather than sent, and deterministic for a given input, like every
 * standard-lane message: a retry must render the bytes the first attempt did.
 * Seven languages as a `Record`, so a missing one fails to compile.
 */

/**
 * The effective date the notice announces, as YYYY-MM-DD, or null until the
 * owner sets it (docs/policy/email-policy-amendment-draft.md section 5).
 *
 * Held here rather than passed as a payload, so that the placeholder render --
 * whose hash is what gets approved -- is byte for byte the message that goes
 * out. A payload date made the approved hash and the sent bytes two different
 * things. A test holds it equal to the documents' effective date once set.
 */
export const POLICY_CHANGE_NOTICE_EFFECTIVE_DATE: string | null = "2026-11-16";

type NoticeLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type NoticeCopy = {
  subject: string;
  intro: (date: string) => string;
  releaseNotes: string;
  consent: string;
  read: string;
  why: string;
};

const NOTICE_COPY: Record<NoticeLanguage, NoticeCopy> = {
  en: {
    subject: "Changes to the Tomverse Privacy Policy and Terms",
    intro: (date) =>
      `We are updating the Tomverse Privacy Policy and Terms and Conditions. The changes take effect on ${date}.`,
    releaseNotes:
      "Tomverse may send product update emails (news about the Tomverse service) without your asking to accounts that were registered before this change was announced. Otherwise we send them only if you ask. You can turn them off at any time in your email settings or with the unsubscribe link in any such message, without signing in. Sign-in codes, receipts and service notices are not affected.",
    consent:
      "A marketing email consent stays in effect until you withdraw it. If you receive marketing email in Korea, we will remind you of that consent every two years.",
    read: "Read the updated documents:",
    why: "You are receiving this because it is a notice about the terms of your account. It is sent whatever your email settings are.",
  },
  ko: {
    subject: "Tomverse 개인정보 처리방침과 이용약관이 변경됩니다",
    intro: (date) =>
      `Tomverse 개인정보 처리방침과 서비스 이용약관이 변경됩니다. 변경 사항은 ${date}부터 적용됩니다.`,
    releaseNotes:
      "Tomverse는 이 변경이 안내되기 전에 가입한 계정에는 신청하지 않으셨어도 제품 소식(Tomverse 서비스 소식) 메일을 보낼 수 있습니다. 그 밖에는 신청하신 경우에만 보냅니다. 이메일 설정 또는 해당 메일의 수신거부 링크에서 로그인 없이 언제든 끄실 수 있습니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다.",
    consent:
      "광고성 이메일 수신동의는 철회하실 때까지 유효합니다. 한국에서 수신 중이신 경우, 2년마다 수신동의 사실을 알려 드립니다.",
    read: "변경된 문서 보기:",
    why: "계정 이용 조건에 관한 고지이므로 이메일 설정과 관계없이 발송됩니다.",
  },
  zh: {
    subject: "Tomverse 隐私政策和条款变更通知",
    intro: (date) => `我们正在更新 Tomverse 隐私政策和服务条款，变更自 ${date} 起生效。`,
    releaseNotes:
      "对于在本次变更公布之前注册的账户，即使您没有申请，Tomverse 也可能向您发送产品动态邮件（关于 Tomverse 服务的消息）。其他情况下，只有在您申请后才会发送。您可以随时在邮件设置中或通过此类邮件中的退订链接关闭，无需登录。登录验证码、收据和服务通知不受影响。",
    consent: "营销邮件同意在您撤回之前一直有效。如果您在韩国接收营销邮件，我们会每两年提醒您一次该同意。",
    read: "查看更新后的文件：",
    why: "这是关于您账户条款的通知，无论您的邮件设置如何都会发送。",
  },
  fr: {
    subject: "Modification de la politique de confidentialité et des conditions de Tomverse",
    intro: (date) =>
      `Nous mettons à jour la politique de confidentialité et les conditions générales de Tomverse. Les modifications prennent effet le ${date}.`,
    releaseNotes:
      "Tomverse peut envoyer des actualités produit (des nouvelles du service Tomverse) sans demande de votre part aux comptes inscrits avant l'annonce de ce changement. Sinon, nous ne les envoyons que si vous les demandez. Vous pouvez les désactiver à tout moment dans vos paramètres e-mail ou avec le lien de désabonnement de ces messages, sans vous connecter. Les codes de connexion, les reçus et les avis de service ne sont pas concernés.",
    consent:
      "Un consentement aux e-mails marketing reste valable jusqu'à ce que vous le retiriez. Si vous recevez des e-mails marketing en Corée, nous vous le rappellerons tous les deux ans.",
    read: "Consulter les documents mis à jour :",
    why: "Vous recevez ce message car il concerne les conditions de votre compte. Il est envoyé quels que soient vos paramètres e-mail.",
  },
  de: {
    subject: "Änderungen der Datenschutzerklärung und Bedingungen von Tomverse",
    intro: (date) =>
      `Wir aktualisieren die Datenschutzerklärung und die Geschäftsbedingungen von Tomverse. Die Änderungen gelten ab dem ${date}.`,
    releaseNotes:
      "Tomverse kann Produkt-Updates (Neuigkeiten zum Tomverse-Dienst) ohne Ihre Anforderung an Konten senden, die vor der Ankündigung dieser Änderung registriert wurden. Andernfalls senden wir sie nur auf Ihre Anforderung. Sie können sie jederzeit in Ihren E-Mail-Einstellungen oder über den Abmeldelink in einer solchen Nachricht deaktivieren, ohne sich anzumelden. Anmeldecodes, Belege und Servicehinweise sind davon nicht betroffen.",
    consent:
      "Eine Einwilligung in Werbe-E-Mails gilt, bis Sie sie widerrufen. Wenn Sie Werbe-E-Mails in Korea erhalten, erinnern wir Sie alle zwei Jahre an diese Einwilligung.",
    read: "Die aktualisierten Dokumente lesen:",
    why: "Sie erhalten diese Nachricht, weil sie die Bedingungen Ihres Kontos betrifft. Sie wird unabhängig von Ihren E-Mail-Einstellungen gesendet.",
  },
  es: {
    subject: "Cambios en la Política de privacidad y los Términos de Tomverse",
    intro: (date) =>
      `Estamos actualizando la Política de privacidad y los Términos y condiciones de Tomverse. Los cambios entran en vigor el ${date}.`,
    releaseNotes:
      "Tomverse puede enviar novedades del producto (noticias sobre el servicio Tomverse) sin que las pidas a las cuentas registradas antes de anunciarse este cambio. En los demás casos solo las enviamos si las pides. Puedes desactivarlas en cualquier momento en la configuración de correo o con el enlace para darte de baja de esos mensajes, sin iniciar sesión. Los códigos de acceso, los recibos y los avisos de servicio no cambian.",
    consent:
      "El consentimiento para correos de marketing sigue vigente hasta que lo retires. Si recibes correos de marketing en Corea, te lo recordaremos cada dos años.",
    read: "Consulta los documentos actualizados:",
    why: "Recibes este mensaje porque es un aviso sobre las condiciones de tu cuenta. Se envía sea cual sea tu configuración de correo.",
  },
  pt: {
    subject: "Alterações na Política de Privacidade e nos Termos da Tomverse",
    intro: (date) =>
      `Estamos atualizando a Política de Privacidade e os Termos e Condições da Tomverse. As alterações entram em vigor em ${date}.`,
    releaseNotes:
      "A Tomverse pode enviar novidades do produto (notícias sobre o serviço Tomverse) sem que você peça para contas cadastradas antes do anúncio desta mudança. Nos demais casos, só enviamos se você pedir. Você pode desativá-las a qualquer momento nas configurações de e-mail ou pelo link de descadastro dessas mensagens, sem fazer login. Códigos de acesso, recibos e avisos de serviço não mudam.",
    consent:
      "O consentimento para e-mails de marketing vale até que você o retire. Se você recebe e-mails de marketing na Coreia, vamos lembrá-lo desse consentimento a cada dois anos.",
    read: "Leia os documentos atualizados:",
    why: "Você está recebendo esta mensagem porque ela trata das condições da sua conta. Ela é enviada independentemente das suas configurações de e-mail.",
  },
};

const NOTICE_LANGUAGES = Object.keys(NOTICE_COPY) as NoticeLanguage[];

const normalizeNoticeLanguage = (language: string | null | undefined): NoticeLanguage =>
  NOTICE_LANGUAGES.includes(language as NoticeLanguage) ? (language as NoticeLanguage) : "en";

const escapeNoticeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Nothing: every byte of the notice is fixed in code, and approved as such. */
export type PolicyChangeNoticePayload = Record<string, never>;

const formattedEffectiveDate = (language: NoticeLanguage): string => {
  if (!POLICY_CHANGE_NOTICE_EFFECTIVE_DATE) return "{{effectiveDate}}";
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${POLICY_CHANGE_NOTICE_EFFECTIVE_DATE}T00:00:00.000Z`));
};

/**
 * Static property reads, not `NOTICE_COPY[language]`: the sealed closure keeps an
 * inventory of computed element accesses, and a switch keeps it unchanged.
 */
const noticeCopyFor = (language: NoticeLanguage): NoticeCopy => {
  switch (language) {
    case "ko":
      return NOTICE_COPY.ko;
    case "zh":
      return NOTICE_COPY.zh;
    case "fr":
      return NOTICE_COPY.fr;
    case "de":
      return NOTICE_COPY.de;
    case "es":
      return NOTICE_COPY.es;
    case "pt":
      return NOTICE_COPY.pt;
    default:
      return NOTICE_COPY.en;
  }
};

export function buildPolicyChangeNoticeEmail(input: {
  language?: string | null;
  appUrl: string;
}) {
  const language = normalizeNoticeLanguage(input.language);
  const copy = noticeCopyFor(language);
  const effectiveDate = formattedEffectiveDate(language);
  const base = input.appUrl.replace(/\/+$/, "");
  const privacy = `${base}/privacy`;
  const terms = `${base}/terms`;
  return {
    subject: copy.subject,
    text: [
      copy.intro(effectiveDate),
      copy.releaseNotes,
      copy.consent,
      `${copy.read}\n${privacy}\n${terms}`,
      copy.why,
    ].join("\n\n"),
    // The branded frame every other account mail uses; the wording is the
    // same paragraphs, so the frame adds no sentence of its own.
    html: renderTransactionalEmailLayout({
      preview: copy.subject,
      title: copy.subject,
      bodyHtml: [
        renderEmailParagraph(escapeNoticeHtml(copy.intro(effectiveDate))),
        renderEmailParagraph(escapeNoticeHtml(copy.releaseNotes)),
        renderEmailParagraph(escapeNoticeHtml(copy.consent)),
        renderEmailParagraph(
          `${escapeNoticeHtml(copy.read)}<br><a href="${escapeNoticeHtml(privacy)}" style="color:#2563eb;">${escapeNoticeHtml(privacy)}</a><br><a href="${escapeNoticeHtml(terms)}" style="color:#2563eb;">${escapeNoticeHtml(terms)}</a>`
        ),
        renderEmailParagraph(escapeNoticeHtml(copy.why), "muted"),
      ].join(""),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * The processing-result notices (`consent_result_notice`,
 * `unsubscribe_result_notice`).
 *
 * The approved wording of docs/policy/email-consent-copy-draft.md §4.1 and §4.2,
 * byte for byte (tests/processingResultNotice.test.mjs reads the document).
 * Korean and English only, as approved: a Korean-language recipient gets the
 * Korean text, everyone else the English. Here, like the amendment notice,
 * because this file is in the Prompt Refiner's sealed runtime closure and a new
 * module imported from it would grow that closure.
 * ------------------------------------------------------------------ */

/** The date the processing happened, as YYYY-MM-DD on the Asia/Seoul calendar. */
export type ProcessingResultNoticePayload = { date: string };

type ProcessingResultCopy = { subject: string; lines: readonly string[]; closing: string };

const PROCESSING_RESULT_COPY = {
  consent: {
    ko: {
      subject: "광고성 정보 수신동의 처리 결과",
      lines: [
        "전송자: Tomverse Pty Ltd",
        "처리 내용: 이메일 광고성 정보 수신동의",
        "처리 결과: 동의 처리 완료",
        "동의일: {date}",
      ],
      closing:
        "이 동의는 철회하실 때까지 유효합니다. 언제든 이메일 설정이나 광고성 메일의 수신거부 링크에서 로그인 없이 철회하실 수 있습니다.",
    },
    en: {
      subject: "Your marketing email preference has been turned on",
      lines: [
        "Sender: Tomverse Pty Ltd",
        "Request: consent to receive marketing email",
        "Outcome: turned on",
        "Date: {date}",
      ],
      closing:
        "This consent stays in effect until you withdraw it. You can withdraw it at any time in your email settings or with the unsubscribe link in any marketing message, without signing in.",
    },
  },
  unsubscribe: {
    ko: {
      subject: "광고성 정보 수신거부 처리 결과",
      lines: [
        "전송자: Tomverse Pty Ltd",
        "처리 내용: 이메일 광고성 정보 수신거부",
        "처리 결과: 수신거부 처리 완료",
        "처리일: {date}",
      ],
      closing:
        "이 주소로 광고성 이메일을 더 보내지 않습니다. 로그인 코드, 결제 영수증, 서비스 공지는 계속 발송됩니다.",
    },
    en: {
      subject: "Your marketing email has been turned off",
      lines: [
        "Sender: Tomverse Pty Ltd",
        "Request: stop marketing email",
        "Outcome: turned off",
        "Date: {date}",
      ],
      closing:
        "We will not send marketing email to this address again. Sign-in codes, billing receipts and service notices continue.",
    },
  },
} as const;

const processingResultCopy = (
  kind: "consent" | "unsubscribe",
  language: string | null | undefined
): ProcessingResultCopy => {
  const table = kind === "consent" ? PROCESSING_RESULT_COPY.consent : PROCESSING_RESULT_COPY.unsubscribe;
  return language === "ko" ? table.ko : table.en;
};

const escapeResultHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function buildProcessingResultNotice(
  kind: "consent" | "unsubscribe",
  payload: ProcessingResultNoticePayload,
  language: string | null | undefined
) {
  const copy = processingResultCopy(kind, language);
  const lines = copy.lines.map((line) => line.replace("{date}", payload.date));
  return {
    subject: copy.subject,
    text: `${lines.join("\n")}\n\n${copy.closing}`,
    // The approved lines and closing, unchanged, in the branded frame; its
    // title is the approved subject.
    html: renderTransactionalEmailLayout({
      preview: copy.subject,
      title: copy.subject,
      bodyHtml:
        renderEmailParagraph(lines.map(escapeResultHtml).join("<br>")) +
        renderEmailParagraph(escapeResultHtml(copy.closing)),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * The scheduled-task result notices (`scheduled_task_run_answered`,
 * `scheduled_task_paused`).
 *
 * Status and links only: the task's own name, when it ran, a link to the
 * answer (or to the task when it paused) and where to switch these off. No
 * part of the answer is in the mail. Here rather than in a module of its own
 * because this file is in the Prompt Refiner's sealed runtime closure, like the
 * notices above. The seven email languages; zh-Hant reads English, as every
 * other account mail does.
 * ------------------------------------------------------------------ */

type ScheduledTaskNoticeLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type ScheduledTaskNoticeCopy = {
  answeredSubject: (title: string) => string;
  answeredBody: (title: string, runAt: string) => string;
  answeredAction: string;
  pausedSubject: (title: string) => string;
  pausedBody: (title: string, runAt: string) => string;
  pausedAction: string;
  manage: string;
  manageLink: string;
};

const SCHEDULED_TASK_NOTICE_COPY: Record<ScheduledTaskNoticeLanguage, ScheduledTaskNoticeCopy> = {
  en: {
    answeredSubject: (title) => `Scheduled task answered: ${title}`,
    answeredBody: (title, runAt) =>
      `Your scheduled task "${title}" ran (${runAt}). The new answer is in its conversation.`,
    answeredAction: "View the answer",
    pausedSubject: (title) => `Scheduled task paused: ${title}`,
    pausedBody: (title, runAt) =>
      `Your scheduled task "${title}" was paused after its run (${runAt}). Open scheduled tasks to see why and resume it.`,
    pausedAction: "Open scheduled tasks",
    manage:
      "You can turn these emails off for each task in scheduled tasks, or for every task in your email notification settings.",
    manageLink: "Email notification settings",
  },
  ko: {
    answeredSubject: (title) => `예약 작업 답변 도착: ${title}`,
    answeredBody: (title, runAt) =>
      `예약 작업을 실행했고(${runAt}) 새 답변을 대화에 저장했습니다. 작업: ${title}`,
    answeredAction: "답변 보기",
    pausedSubject: (title) => `예약 작업 일시정지: ${title}`,
    pausedBody: (title, runAt) =>
      `실행(${runAt}) 뒤 예약 작업이 일시정지됐습니다. 예약 작업 설정에서 이유를 확인하고 다시 시작할 수 있습니다. 작업: ${title}`,
    pausedAction: "예약 작업 열기",
    manage: "이 메일은 예약 작업 설정에서 작업마다, 또는 이메일 알림 설정에서 한 번에 끌 수 있습니다.",
    manageLink: "이메일 알림 설정",
  },
  zh: {
    answeredSubject: (title) => `定时任务已回答：${title}`,
    answeredBody: (title, runAt) => `定时任务已运行（${runAt}），新回答已保存到对话中。任务：${title}`,
    answeredAction: "查看回答",
    pausedSubject: (title) => `定时任务已暂停：${title}`,
    pausedBody: (title, runAt) =>
      `定时任务在运行（${runAt}）后已暂停。请在定时任务设置中查看原因并重新开始。任务：${title}`,
    pausedAction: "打开定时任务",
    manage: "你可以在定时任务中为每个任务关闭这类邮件，也可以在邮件通知设置中一次性关闭。",
    manageLink: "邮件通知设置",
  },
  fr: {
    answeredSubject: (title) => `Tâche planifiée répondue : ${title}`,
    answeredBody: (title, runAt) =>
      `Votre tâche planifiée « ${title} » a été exécutée (${runAt}). La nouvelle réponse se trouve dans sa conversation.`,
    answeredAction: "Voir la réponse",
    pausedSubject: (title) => `Tâche planifiée en pause : ${title}`,
    pausedBody: (title, runAt) =>
      `Votre tâche planifiée « ${title} » a été mise en pause après son exécution (${runAt}). Ouvrez les tâches planifiées pour en voir la raison et la relancer.`,
    pausedAction: "Ouvrir les tâches planifiées",
    manage:
      "Vous pouvez désactiver ces e-mails pour chaque tâche dans les tâches planifiées, ou pour toutes dans vos paramètres de notification par e-mail.",
    manageLink: "Paramètres de notification par e-mail",
  },
  de: {
    answeredSubject: (title) => `Geplante Aufgabe beantwortet: ${title}`,
    answeredBody: (title, runAt) =>
      `Ihre geplante Aufgabe „${title}“ wurde ausgeführt (${runAt}). Die neue Antwort finden Sie in ihrer Unterhaltung.`,
    answeredAction: "Antwort ansehen",
    pausedSubject: (title) => `Geplante Aufgabe pausiert: ${title}`,
    pausedBody: (title, runAt) =>
      `Ihre geplante Aufgabe „${title}“ wurde nach der Ausführung (${runAt}) pausiert. Unter „Geplante Aufgaben“ sehen Sie den Grund und können sie fortsetzen.`,
    pausedAction: "Geplante Aufgaben öffnen",
    manage:
      "Sie können diese E-Mails für jede Aufgabe unter „Geplante Aufgaben“ oder für alle in den E-Mail-Benachrichtigungseinstellungen abschalten.",
    manageLink: "E-Mail-Benachrichtigungseinstellungen",
  },
  es: {
    answeredSubject: (title) => `Tarea programada respondida: ${title}`,
    answeredBody: (title, runAt) =>
      `Tu tarea programada «${title}» se ejecutó (${runAt}). La nueva respuesta está en su conversación.`,
    answeredAction: "Ver la respuesta",
    pausedSubject: (title) => `Tarea programada en pausa: ${title}`,
    pausedBody: (title, runAt) =>
      `Tu tarea programada «${title}» se pausó después de ejecutarse (${runAt}). Abre las tareas programadas para ver el motivo y reanudarla.`,
    pausedAction: "Abrir tareas programadas",
    manage:
      "Puedes desactivar estos correos para cada tarea en las tareas programadas, o para todas en la configuración de notificaciones por correo.",
    manageLink: "Configuración de notificaciones por correo",
  },
  pt: {
    answeredSubject: (title) => `Tarefa agendada respondida: ${title}`,
    answeredBody: (title, runAt) =>
      `Sua tarefa agendada "${title}" foi executada (${runAt}). A nova resposta está na conversa dela.`,
    answeredAction: "Ver a resposta",
    pausedSubject: (title) => `Tarefa agendada pausada: ${title}`,
    pausedBody: (title, runAt) =>
      `Sua tarefa agendada "${title}" foi pausada após a execução (${runAt}). Abra as tarefas agendadas para ver o motivo e retomá-la.`,
    pausedAction: "Abrir tarefas agendadas",
    manage:
      "Você pode desativar esses e-mails para cada tarefa nas tarefas agendadas, ou para todas nas configurações de notificações por e-mail.",
    manageLink: "Configurações de notificações por e-mail",
  },
};

// A switch rather than an index into the table: a computed access in this file
// would join the closure's reviewed inventory (see noticeCopyFor above).
const scheduledTaskNoticeCopy = (language: string | null | undefined): ScheduledTaskNoticeCopy => {
  switch (language) {
    case "ko":
      return SCHEDULED_TASK_NOTICE_COPY.ko;
    case "zh":
      return SCHEDULED_TASK_NOTICE_COPY.zh;
    case "fr":
      return SCHEDULED_TASK_NOTICE_COPY.fr;
    case "de":
      return SCHEDULED_TASK_NOTICE_COPY.de;
    case "es":
      return SCHEDULED_TASK_NOTICE_COPY.es;
    case "pt":
      return SCHEDULED_TASK_NOTICE_COPY.pt;
    default:
      return SCHEDULED_TASK_NOTICE_COPY.en;
  }
};

const escapeScheduledTaskHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function buildScheduledTaskNoticeEmail(
  kind: "answered" | "paused",
  payload: ScheduledTaskNoticePayload,
  language: string | null | undefined
) {
  const copy = scheduledTaskNoticeCopy(language);
  const subject = kind === "answered" ? copy.answeredSubject(payload.taskTitle) : copy.pausedSubject(payload.taskTitle);
  const body =
    kind === "answered"
      ? copy.answeredBody(payload.taskTitle, payload.runAt)
      : copy.pausedBody(payload.taskTitle, payload.runAt);
  const action = kind === "answered" ? copy.answeredAction : copy.pausedAction;
  return {
    subject,
    text: [body, `${action}: ${payload.actionUrl}`, `${copy.manage}\n${copy.manageLink}: ${payload.settingsUrl}`].join(
      "\n\n"
    ),
    html: renderTransactionalEmailLayout({
      preview: body,
      title: subject,
      bodyHtml: [
        renderEmailParagraph(escapeScheduledTaskHtml(body)),
        renderEmailButton(escapeScheduledTaskHtml(payload.actionUrl), escapeScheduledTaskHtml(action)),
        renderEmailParagraph(
          `${escapeScheduledTaskHtml(copy.manage)} <a href="${escapeScheduledTaskHtml(payload.settingsUrl)}" style="color:#2563eb;">${escapeScheduledTaskHtml(copy.manageLink)}</a>`,
          "muted"
        ),
      ].join(""),
    }),
  };
}
