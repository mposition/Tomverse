import { LanguageProvider } from "@/components/LanguageProvider";
import { isLanguage } from "@/lib/language";
import { headers } from "next/headers";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { signupConsentAvailable } from "@/lib/signupConsent";
import { SignInPageContent } from "../signin/SignInPageContent";

/**
 * The sign-up screen (docs/policy/email-product-news-redesign-draft.md section
 * 5.2a, v25). The same card as sign-in, in its `signup` mode: the consent
 * devices sit above the buttons, and only this screen's clicks create an
 * account. `?lang=` is resolved here for the same reason the sign-in page
 * resolves it (VAL-003).
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const requested = (await searchParams).lang;
  const locale = Array.isArray(requested) ? requested[0] : requested;
  const runtimeEnvironment = process.env;
  const turnstileSiteKey = runtimeEnvironment.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  // Shown only where the collection gate is on, a confirmation can be sent and
  // the request has a trusted country. Without them the screen still signs
  // people up, with no devices.
  const signupConsentEnabled = await signupConsentAvailable(
    getTrustedIpCountry(await headers())
  ).catch(() => false);
  const props = { turnstileSiteKey, signupConsentEnabled, mode: "signup" as const };

  if (!isLanguage(locale)) {
    return <SignInPageContent {...props} />;
  }

  return (
    <LanguageProvider initialLang={locale} forceInitialLang>
      <SignInPageContent {...props} />
    </LanguageProvider>
  );
}
