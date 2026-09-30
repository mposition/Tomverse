import { LanguageProvider } from "@/components/LanguageProvider";
import { isLanguage } from "@/lib/language";
import { headers } from "next/headers";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { signupConsentAvailable } from "@/lib/signupConsent";
import { SignInPageContent } from "./SignInPageContent";

/**
 * VAL-003. `?lang=` used to be resolved on the client only: the layout picked
 * the initial language from `Accept-Language`, so a Korean visitor arriving at
 * `/auth/signin?lang=ko` from an English-preferring browser got the English
 * strings server-rendered and watched them swap to Korean after hydration --
 * including the two legal links. React logged no hydration error because the
 * markup matched at the moment it hydrated; the text changed a tick later, in
 * an effect.
 *
 * Resolving the parameter here instead means the server renders the language
 * the URL asked for, so the first paint is already correct. It is the same
 * `initialLang` + `forceInitialLang` pairing the localized marketing routes
 * use. Deliberately *not* `suppressHydrationWarning`, and deliberately not a
 * post-hydration swap: both of those hide the flash rather than remove it.
 *
 * With no `lang` parameter nothing is pinned, and the client keeps restoring
 * from localStorage / the browser preference exactly as before.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const requested = (await searchParams).lang;
  const locale = Array.isArray(requested) ? requested[0] : requested;
  // NEXT_PUBLIC_* direct references are normally inlined into client bundles.
  // Read through the server environment object so this dynamic page can pass
  // the public site key supplied by the running deployment even when the same
  // build artifact was produced without it.
  const runtimeEnvironment = process.env;
  const turnstileSiteKey = runtimeEnvironment.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  // The sign-up consent devices (S4), decided on the server. This screen shows
  // them only in the sign-up step of a sign-in that proved an address with no
  // account (section 5.2a); the sign-up screen shows them up front.
  const signupConsentEnabled = await signupConsentAvailable(
    getTrustedIpCountry(await headers())
  ).catch(() => false);
  const consent = { signupConsentEnabled, mode: "signin" as const };

  if (!isLanguage(locale)) {
    return <SignInPageContent turnstileSiteKey={turnstileSiteKey} {...consent} />;
  }

  return (
    <LanguageProvider initialLang={locale} forceInitialLang>
      <SignInPageContent turnstileSiteKey={turnstileSiteKey} {...consent} />
    </LanguageProvider>
  );
}
