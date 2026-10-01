import { headers } from "next/headers";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { signupConsentAvailable } from "@/lib/signupConsent";
import { EmailLinkVerifyContent } from "./EmailLinkVerifyContent";

/**
 * Where an emailed sign-in link lands. A link that proves an address with no
 * account turns into the sign-up step here, with the consent devices when the
 * server says they can be shown (docs/policy/email-product-news-redesign-draft.md
 * section 5.2a) -- so that decision is made on the server, as the sign-in and
 * sign-up screens make it.
 */
export default async function EmailLoginVerifyPage() {
  const signupConsentEnabled = await signupConsentAvailable(
    getTrustedIpCountry(await headers())
  ).catch(() => false);
  return <EmailLinkVerifyContent signupConsentEnabled={signupConsentEnabled} />;
}
