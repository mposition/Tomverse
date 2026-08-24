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
