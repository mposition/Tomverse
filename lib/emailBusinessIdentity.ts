import type { BusinessIdentity } from "@/lib/emailFooterRenderer";

/**
 * Who the sender is, in the sense every anti-spam statute means it.
 *
 * Configuration rather than code because none of these values is a product
 * decision and all of them change without a deploy: a registered address moves,
 * a company number is issued, an ABN is obtained. The footer profiles name
 * which of them a jurisdiction requires (§5.2 E3); this says what they are.
 *
 * Everything is optional and nothing is defaulted. A placeholder legal name
 * would be worse than an absent one -- it would satisfy the renderer, pass
 * every check, and put a false statement of identity in the footer of a message
 * that exists to make identity checkable.
 *
 * Contract: docs/policy/email-notifications.md §5.2 E3, §8.5.
 */

type Env = Record<string, string | undefined>;

const value = (env: Env, key: string) => {
  const trimmed = env[key]?.trim();
  return trimmed ? trimmed : null;
};

export const BUSINESS_IDENTITY_ENV = {
  legalName: "EMAIL_BUSINESS_LEGAL_NAME",
  postalAddress: "EMAIL_BUSINESS_POSTAL_ADDRESS",
  contactEmail: "EMAIL_BUSINESS_CONTACT_EMAIL",
  businessRegistrationNumber: "EMAIL_BUSINESS_REGISTRATION_NUMBER",
  mailOrderRegistrationNumber: "EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER",
  abn: "EMAIL_BUSINESS_ABN",
} as const;

export const readBusinessIdentity = (env: Env): BusinessIdentity => ({
  legalName: value(env, BUSINESS_IDENTITY_ENV.legalName),
  postalAddress: value(env, BUSINESS_IDENTITY_ENV.postalAddress),
  contactEmail: value(env, BUSINESS_IDENTITY_ENV.contactEmail),
  businessRegistrationNumber: value(env, BUSINESS_IDENTITY_ENV.businessRegistrationNumber),
  mailOrderRegistrationNumber: value(
    env,
    BUSINESS_IDENTITY_ENV.mailOrderRegistrationNumber
  ),
  abn: value(env, BUSINESS_IDENTITY_ENV.abn),
});

/**
 * The env var a footer block needs, for an operator who has been told which
 * block is missing and now has to know what to set.
 */
export const BLOCK_ENV_VARIABLE: Record<string, string | null> = {
  legal_name: BUSINESS_IDENTITY_ENV.legalName,
  postal_address: BUSINESS_IDENTITY_ENV.postalAddress,
  contact_email: BUSINESS_IDENTITY_ENV.contactEmail,
  business_registration: BUSINESS_IDENTITY_ENV.businessRegistrationNumber,
  mail_order_registration: BUSINESS_IDENTITY_ENV.mailOrderRegistrationNumber,
  abn: BUSINESS_IDENTITY_ENV.abn,
  // Not configuration: generated per delivery, and absent means the caller did
  // not supply one rather than that somebody forgot a variable.
  unsubscribe_link: null,
  unsubscribe_reason: null,
};

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which values every footer needs, and which belong to one jurisdiction.
 *
 * Read off `JURISDICTION_PROFILE_SEED` rather than restated from the runbook:
 * `COMMON_FOOTER` is in every profile including `ZZ`, and `KR` and `AU` each
 * add their own. A second hand-written copy of that mapping is the thing this
 * whole module exists to avoid.
 */
export const UNIVERSAL_IDENTITY_BLOCKS = [
  "legal_name",
  "postal_address",
  "contact_email",
] as const;

export const JURISDICTION_IDENTITY_BLOCKS: Record<string, readonly string[]> = {
  KR: ["business_registration", "mail_order_registration"],
  AU: ["abn"],
};

const BLOCK_VALUE: Record<
  string,
  (identity: BusinessIdentity) => string | null | undefined
> = {
  legal_name: (identity) => identity.legalName,
  postal_address: (identity) => identity.postalAddress,
  contact_email: (identity) => identity.contactEmail,
  business_registration: (identity) => identity.businessRegistrationNumber,
  mail_order_registration: (identity) => identity.mailOrderRegistrationNumber,
  abn: (identity) => identity.abn,
};

export type BusinessIdentityProblem = {
  severity: "error" | "warning";
  code: "EMAIL_BUSINESS_IDENTITY_INCOMPLETE" | "EMAIL_BUSINESS_IDENTITY_JURISDICTION_INCOMPLETE";
  message: string;
  /** The footer blocks that cannot render, for an operator who has to fix them. */
  blocks: string[];
  /** The environment variables that set them, in the same order. */
  variables: string[];
};

/**
 * Everything the footer cannot say about who sent the message.
 *
 * ## Why an unset value is not a missing line
 *
 * `renderJurisdictionFooter()` returns `{ ok: false }` when *any* named block
 * has no value, and `composeJurisdictionalMessage()` then drops the footer
 * whole. So one unset variable does not remove one line -- it removes the
 * entire business identity from every message under that profile. Nothing else
 * reports this: the only signal is an `email_jurisdiction_footer_degraded`
 * warning emitted per send, which is a line in a log nobody reads until they
 * are already looking for it.
 *
 * ## Why the severity is conditional
 *
 * The same shape as `unsubscribeKeyringProblems`, and for the same reason.
 * Transactional mail is deliberately *not* held for this -- an account-deletion
 * notice is the message least able to wait for an environment variable -- so on
 * a deployment with no marketing identity this is a debt, not a stoppage, and
 * gating readiness on it would refuse today's production to announce a gap that
 * has been there since the footer shipped.
 *
 * Once `MARKETING_EMAIL_FROM` is set it becomes an error, because from that
 * moment an incomplete identity means every marketing send is *refused*
 * (`jurisdiction_footer_incomplete`) while `/api/ready` answers yes.
 *
 * ## Why the jurisdiction blocks are reported separately
 *
 * A missing universal value drops the footer for everybody. A missing `abn`
 * drops it only for recipients who resolve to `AU`, and this function cannot
 * know whether any exist -- it reads an environment, not a recipient list.
 * Folding the two into one finding would either overstate the first or
 * understate the second.
 */
export const businessIdentityProblems = (
  env: Env
): BusinessIdentityProblem[] => {
  const identity = readBusinessIdentity(env);
  const marketingConfigured = Boolean(env.MARKETING_EMAIL_FROM?.trim());
  const problems: BusinessIdentityProblem[] = [];

  const missing = (blocks: readonly string[]) =>
    blocks.filter((block) => !BLOCK_VALUE[block]?.(identity));

  const universal = missing(UNIVERSAL_IDENTITY_BLOCKS);
  if (universal.length > 0) {
    problems.push({
      severity: marketingConfigured ? "error" : "warning",
      code: "EMAIL_BUSINESS_IDENTITY_INCOMPLETE",
      blocks: universal,
      variables: universal.map((block) => BLOCK_ENV_VARIABLE[block] ?? block),
      message: marketingConfigured
        ? `MARKETING_EMAIL_FROM is set and ${universal.join(", ")} ${universal.length === 1 ? "has" : "have"} no value, so every marketing message is refused for having no business identity, and every other message goes out with no footer at all.`
        : `${universal.join(", ")} ${universal.length === 1 ? "has" : "have"} no value, so every message goes out with no business identity footer -- not a missing line, the whole footer. Set ${universal.map((block) => BLOCK_ENV_VARIABLE[block] ?? block).join(", ")}.`,
    });
  }

  for (const [profileKey, blocks] of Object.entries(JURISDICTION_IDENTITY_BLOCKS)) {
    const absent = missing(blocks);
    if (absent.length === 0) continue;
    problems.push({
      // Always a warning, even with marketing on: whether this deployment has
      // recipients in that jurisdiction is not a fact an environment holds.
      severity: "warning",
      code: "EMAIL_BUSINESS_IDENTITY_JURISDICTION_INCOMPLETE",
      blocks: absent,
      variables: absent.map((block) => BLOCK_ENV_VARIABLE[block] ?? block),
      message: `${absent.join(", ")} ${absent.length === 1 ? "has" : "have"} no value, so a recipient who resolves to ${profileKey} receives no footer at all. Set ${absent.map((block) => BLOCK_ENV_VARIABLE[block] ?? block).join(", ")}.`,
    });
  }

  return problems;
};

/** What a health check reports about the footer's business identity. */
export const businessIdentityReadiness = (env: Env = process.env) => {
  const problems = businessIdentityProblems(env);
  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    ready: errors.length === 0,
    /** Whether this deployment is one the values are mandatory for. */
    required: Boolean(env.MARKETING_EMAIL_FROM?.trim()),
    errors,
    warnings: problems.filter((problem) => problem.severity === "warning"),
  };
};
