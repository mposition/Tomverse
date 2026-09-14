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
 * `COMMON_FOOTER` is in every profile including `ZZ`, and `AU` adds its own. A
 * second hand-written copy of that mapping is the thing this whole module
 * exists to avoid, and `tests/emailBusinessIdentityReadiness.test.mjs` fails
 * when the two disagree.
 *
 * `KR` used to add the two registration numbers and no longer does
 * (2026-09-14). The sender is an Australian company that is not required to
 * register as a Korean mail-order seller, so those numbers do not exist, and
 * naming a block whose value can never be set refuses every Korean marketing
 * message for good -- the renderer drops the whole footer when one named block
 * is empty. The blocks themselves stay in `emailFooterRenderer.ts`: if a Korean
 * registration is ever obtained, restoring them is a seed change and a new
 * policy version rather than new code.
 */
export const UNIVERSAL_IDENTITY_BLOCKS = [
  "legal_name",
  "postal_address",
  "contact_email",
] as const;

export const JURISDICTION_IDENTITY_BLOCKS: Record<string, readonly string[]> = {
  AU: ["abn"],
  // Not because EU or Swiss law asks for an ABN. Both ask that the sender not
  // be concealed, and for an Australian company the ABN is the shortest
  // identifier that makes the name checkable (Q1 review 2026-09-14, section 6.1).
  EU: ["abn"],
  CH: ["abn"],
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

  // Grouped by block rather than by profile since 2026-09-14. `abn` is named by
  // three profiles now (AU, EU, CH), and a per-profile loop reported one unset
  // variable three times over -- an operator sets one value, so the finding says
  // which recipients it costs rather than repeating itself once per profile.
  const profilesNeeding = new Map<string, string[]>();
  for (const [profileKey, blocks] of Object.entries(JURISDICTION_IDENTITY_BLOCKS)) {
    for (const block of blocks) {
      profilesNeeding.set(block, [...(profilesNeeding.get(block) ?? []), profileKey]);
    }
  }

  for (const [block, profileKeys] of profilesNeeding) {
    if (missing([block]).length === 0) continue;
    const variable = BLOCK_ENV_VARIABLE[block] ?? block;
    problems.push({
      // Always a warning, even with marketing on: whether this deployment has
      // recipients in those jurisdictions is not a fact an environment holds.
      severity: "warning",
      code: "EMAIL_BUSINESS_IDENTITY_JURISDICTION_INCOMPLETE",
      blocks: [block],
      variables: [variable],
      message: `${block} has no value, so a recipient who resolves to ${profileKeys.join(", ")} receives no footer at all. Set ${variable}.`,
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
