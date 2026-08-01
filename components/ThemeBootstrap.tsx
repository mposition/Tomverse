import {
  THEME_COOKIE_NAME,
  THEME_STORAGE_KEY,
  THEME_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/theme";

/**
 * UI-001. Applies an explicit theme choice *before the first paint*.
 *
 * The defect this closes: `.dark` could only ever be written by React, so the
 * document painted in the server's theme and snapped to the user's after
 * hydration. `app/globals.css` now answers the common case without any script
 * -- a visitor with no explicit choice gets `prefers-color-scheme` straight
 * from the stylesheet -- but it cannot answer the one case that contradicts
 * the OS: a visitor whose system is dark and who chose light here. That choice
 * lives in a cookie, and on a `force-static` marketing page no cookie ever
 * reaches the HTML.
 *
 * Why the theme is not simply rendered into that HTML. Marketing routes are
 * `force-static` and publicly cacheable, so a per-visitor class in the
 * prerendered body would be a cache-poisoning bug, not a feature: the first
 * visitor's theme would be served to everyone behind the same cache entry.
 * The document language can be resolved per request precisely because it is a
 * property of the *route* (`/ko`, `/en`); a theme is a property of the
 * *visitor* at the same URL. Dynamic application routes have no such
 * constraint and do render the class server-side -- see DocumentShell.
 *
 * Why an inline script rather than a component. Any React-side read -- an
 * effect, a layout effect, a lazy initializer -- runs after the browser has
 * already painted. An inline script runs synchronously during HTML parsing,
 * which is the documented Next.js approach for this exact problem
 * (`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`).
 *
 * Why this is not a CSP relaxation. Static marketing routes are served a
 * hash-based policy built from the prerendered HTML itself
 * (`lib/staticMarketingCsp.ts`), so this script is hashed exactly like the
 * consent reservation already rendered beside it. Dynamic routes carry a nonce
 * and pass it in. Nothing is allowlisted and `'unsafe-inline'` is never added.
 *
 * The priority order is the one stated in lib/theme.ts, and the localStorage
 * read is a migration path: a choice made before the cookie existed is applied
 * and then written to the cookie, so it survives into the server render on the
 * next request and this script stops being needed for that visitor.
 */
const BOOTSTRAP_SCRIPT = `(function(){try{
var d=document.documentElement;
var c=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE_NAME}=(dark|light|system)/);
var t=c&&c[1];
if(!t){var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(s==="dark"||s==="light"||s==="system"){t=s;
document.cookie=${JSON.stringify(THEME_COOKIE_NAME)}+"="+t+"; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax";}}
if(!t)return;
d.classList.toggle("dark",t==="dark");
d.classList.toggle("light",t==="light");
d.dataset.theme=t;
d.style.colorScheme=(t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches))?"dark":"light";
}catch(e){}})()`.replace(/\n/g, "");

export function ThemeBootstrap({ nonce }: { nonce?: string }) {
  return (
    <script
      // Mirrors MarketingConsentReservation: React warns when a component
      // renders a <script>, and on a client-side navigation the tag is
      // inserted through the DOM where it would never execute anyway.
      // Rendering it as inert data on the client keeps both honest -- it runs
      // on hard navigations, and soft ones already have the applied theme.
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: BOOTSTRAP_SCRIPT }}
    />
  );
}
