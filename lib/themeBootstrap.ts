import { THEME_PREFERENCES, THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * UI-001. The theme is applied by `ThemeController`, which is a `useEffect` and
 * therefore runs only after hydration. Until then the document paints with the
 * `:root` defaults -- white -- so every load of a product whose default theme is
 * dark started with a full-screen light flash. On the statically prerendered
 * marketing routes the cached HTML is always light-first, so the flash is
 * unconditional there.
 *
 * This is the blocking bootstrap that closes that gap: it runs synchronously
 * during parse, before the first paint, and applies exactly what
 * `applyThemePreference` in lib/theme.ts would apply. `ThemeController` still
 * owns everything afterwards -- later changes, cross-tab `storage` events and
 * the `prefers-color-scheme` listener for `system`.
 *
 * Constraints this has to satisfy, all of them load-bearing:
 *
 * - **No external request.** It is self-contained, so `script-src 'self'` plus a
 *   nonce (dynamic routes) or a hash (prerendered routes) is enough.
 * - **Byte-stable.** `lib/staticMarketingCsp.ts` hashes the inline scripts it
 *   finds in the prerendered HTML at runtime. If this string varied per request
 *   the hash would not match and the script would be blocked under
 *   `CSP_MODE=enforce`, so nothing here is interpolated per request.
 * - **Safe on bad input.** `localStorage` can throw (Safari private mode, a
 *   blocked third-party context) and can hold anything at all, so the read is
 *   wrapped and the value is validated against the same union `lib/theme.ts`
 *   accepts. Anything unrecognised falls back to "system", matching
 *   `readStoredThemePreference() ?? "system"` in ThemeController.
 * - **Same result as the React path.** Writing `class`, `data-theme` and
 *   `color-scheme` here and something else after hydration would trade the flash
 *   for a hydration mismatch.
 */
const THEME_BOOTSTRAP_SOURCE = `(function(){try{
var d=document.documentElement;
var s=null;
try{s=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){}
var allowed=${JSON.stringify([...THEME_PREFERENCES])};
var t=allowed.indexOf(s)>-1?s:"system";
var dark=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
d.classList.toggle("dark",dark);
d.dataset.theme=t;
d.style.colorScheme=dark?"dark":"light";
}catch(e){}})();`;

/**
 * Collapsed to a single line so the emitted bytes are stable and small; the
 * readable form lives above.
 */
export const THEME_BOOTSTRAP_SCRIPT = THEME_BOOTSTRAP_SOURCE.replace(/\n/g, "");
