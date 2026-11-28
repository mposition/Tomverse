/**
 * The response headers of a public share page that next.config.ts and the
 * proxy also need, in a module with no imports: next.config.ts is loaded by
 * Next's config loader, outside the app's module graph, so it cannot follow an
 * `@/` path (see its own note on lib/robotsPolicyCore.ts).
 *
 * Policy: docs/policy/generated-artifacts.md section 19.
 */

/** Where share pages live: `/share/a/<token>`. The conversation share page is `/share/<token>`. */
export const ARTIFACT_SHARE_PAGE_PREFIX = "/share/a/";

export const isArtifactSharePagePath = (pathname: string) => pathname.startsWith(ARTIFACT_SHARE_PAGE_PREFIX);

/**
 * Every powerful feature off for the page and everything inside it. Stricter
 * than the site-wide policy, which keeps the microphone and location for this
 * origin's own chat.
 */
export const ARTIFACT_SHARE_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
  "browsing-topics=()",
  "fullscreen=()",
  "display-capture=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * The headers that replace the site-wide ones on a share page. Set both in
 * next.config.ts (a later rule for the same path wins over the site-wide
 * rule) and by the route itself, so the result is the same whichever of the
 * two Next applies last.
 *
 *   * The page's own policy carries the CSP `sandbox` directive, and HTML says
 *     a navigation answered with sandbox flags and a Cross-Origin-Opener-Policy
 *     other than `unsafe-none` is a network error. The site-wide
 *     `same-origin-allow-popups` would make the page fail to open in a browser
 *     that follows that rule, so this path says `unsafe-none`. The page opens
 *     no window (no `allow-popups`) and its origin is opaque.
 *   * No referrer at all: the token is the whole of the link's secret.
 */
export const ARTIFACT_SHARE_OVERRIDE_HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "unsafe-none" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: ARTIFACT_SHARE_PERMISSIONS_POLICY },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
] as const;
