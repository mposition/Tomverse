import { ANALYTICS_CONSENT_STORAGE_KEY } from "@/lib/productAnalyticsShared";

/**
 * R-05-A. Reserves the marketing consent slot's height *before the first
 * paint*, for visitors who have not decided yet.
 *
 * The defect this closes: marketing routes are `force-static`, so the
 * prerendered HTML paints first and the consent notice only appears after
 * `/api/analytics/consent-policy` resolves -- around 900ms in. Inserting a
 * ~78-94px band under the header at that point pushes the whole hero down, and
 * that single shift was the entire CLS budget: measured median 0.1095 at
 * 360x640 and 0.1466 at 320x568, against a 0.1 gate.
 *
 * Why an inline script rather than a component. The reservation is only correct
 * for visitors whose consent is still unresolved -- a returning accepted or
 * declined visitor must keep costing zero layout box, which
 * `tests/e2e/marketing-consent-hero.spec.ts` asserts exactly. That decision
 * lives in `localStorage`, which no server render can see, and any React-side
 * read (`useEffect`, `useLayoutEffect`, a lazy initializer in a Client
 * Component) happens after the browser has already painted the static HTML.
 * Measured: doing the reservation from an effect made CLS *worse* (0.1095 ->
 * 0.132), because it turned a 78px insertion into a 94px one. An inline script
 * runs synchronously during HTML parsing, before anything is painted, which is
 * the documented Next.js approach for exactly this class of problem
 * (`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`).
 *
 * Why this is not a CSP relaxation. Static marketing routes are served with a
 * hash-based policy, and `getStaticMarketingCspHashes` collects the hashes of
 * every inline `<script>` and `<style>` straight out of the prerendered HTML
 * (`lib/staticMarketingCsp.ts`). This script is hashed like the JSON-LD block
 * already rendered next to it; nothing is allowlisted, and no nonce is needed.
 * It is also confined to the two `force-static` marketing layouts through
 * `MarketingShell`, so it never reaches the nonce + `strict-dynamic` routes.
 *
 * The matching `min-height` rules live in `app/globals.css`, keyed on the
 * `data-consent-pending` attribute this script sets. `AnalyticsProvider`
 * removes the attribute as soon as the decision resolves, so the reserved band
 * collapses to nothing the moment it stops being needed.
 */
const RESERVATION_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
  ANALYTICS_CONSENT_STORAGE_KEY
)});if(v!=="accepted"&&v!=="declined"){document.documentElement.setAttribute("data-consent-pending","")}}catch(e){}})()`;

export function MarketingConsentReservation() {
  return (
    <script
      // React warns in development when a component renders a <script>, and on
      // a client-side navigation the tag is inserted via the DOM, where it
      // would never execute anyway. Rendering it as data on the client keeps
      // both cases honest: it runs on hard navigations, and is inert on soft
      // ones, where `AnalyticsProvider` already knows the decision.
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: RESERVATION_SCRIPT }}
    />
  );
}
