import "server-only";

import {
  buildAccountDeletionScheduledEmail,
  buildAccountRestoredEmail,
  buildAccountWelcomeEmail,
} from "@/lib/accountEmails";
import {
  buildAdminPlanChangedEmail,
  buildBillingWelcomeEmail,
  buildFoundingTesterPassEmail,
} from "@/lib/billingEmails";
import { buildEmailLoginCodeEmail } from "@/lib/emailLoginEmails";
import { buildModelLaunchEmail } from "@/lib/modelLaunchEmail";
import type { ModelLaunchPayload } from "@/lib/modelLaunchEmail";
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
      ctaUrl: "{{ctaUrl}}",
    },
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
