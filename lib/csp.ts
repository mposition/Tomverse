const isDevelopment = process.env.NODE_ENV === "development";
const shouldUpgradeInsecureRequests =
  process.env.DISABLE_CSP_UPGRADE_INSECURE_REQUESTS !== "true";

const r2Origin = (() => {
  try {
    const endpoint = process.env.R2_ENDPOINT;
    return endpoint ? new URL(endpoint).origin : null;
  } catch {
    return null;
  }
})();

// Cloudflare edge features that inject a script are turned off in Cloudflare,
// not allowlisted here. Two have hit this policy so far:
//
//   Browser Insights          static.cloudflareinsights.com/beacon.min.js
//   Email Address Obfuscation /cdn-cgi/scripts/*/cloudflare-static/email-decode.min.js
//
// Neither tag carries the nonce, because neither exists at build time -- the
// edge adds it to the response on the way out. So the rule is the same for any
// future one, whatever the host: an injected script has no nonce, and a policy
// that admits it has stopped being a nonce policy.
//
// The two failed differently, which is worth knowing before reading a report:
//
// - Browser Insights loads from a third-party host, so `'self'` never covered
//   it and both policies reported it (FINAL-F005). Allowlisting the host would
//   have helped only the static marketing policy below -- 'strict-dynamic'
//   makes host sources inert -- and would have put a third-party RUM script
//   outside the analytics consent gate GA4 is explicitly held behind.
//
// - Email Address Obfuscation loads same-origin, so the static marketing
//   policy's `'self'` already admitted it and it ran there unreported; only
//   the strict policy, where 'strict-dynamic' voids `'self'`, saw it. It was
//   found on 2026-08-22 through the operational alert for a real
//   CSP_VIOLATION_DETECTED on /auth/admin-reauthenticate, which renders the
//   signed-in operator's address. With the decode script blocked that address
//   stayed `[email protected]` on screen. Cloudflare enables this feature by
//   default at signup, so it was never switched on deliberately; it was
//   switched off zone-wide instead (docs/ops/email-sending-domains.md
//   section 3.5.7). Same-origin is therefore not a reason to leave one of these
//   alone -- it only decides which of the two policies reports it.
const directives = (
  scriptDirective: string,
  styleDirective: string,
  styleAttributeDirective: string
) => [
  "default-src 'self'",
  scriptDirective,
  styleDirective,
  styleAttributeDirective,
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  `connect-src 'self'${
    isDevelopment ? " ws: http:" : ""
  } https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://*.googleapis.com https://www.google-analytics.com https://region1.google-analytics.com https://*.google-analytics.com https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com${
    r2Origin ? ` ${r2Origin}` : ""
  }`,
  "frame-src https://accounts.google.com https://content.googleapis.com https://docs.google.com https://drive.google.com https://challenges.cloudflare.com",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(shouldUpgradeInsecureRequests ? ["upgrade-insecure-requests"] : []),
];

export const createStrictCsp = (nonce: string) =>
  [
    ...directives(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
        isDevelopment ? " 'unsafe-eval'" : ""
      } https://accounts.google.com https://apis.google.com https://www.googletagmanager.com https://challenges.cloudflare.com`,
      `style-src 'self' 'nonce-${nonce}'${
        isDevelopment ? " 'unsafe-inline'" : ""
      } https://accounts.google.com https://challenges.cloudflare.com`,
      "style-src-attr 'unsafe-inline'"
    ),
    "report-uri /api/security/csp-report",
    "report-to csp-endpoint",
  ].join("; ");

export const createStaticMarketingCsp = ({
  scriptHashes = [],
  styleHashes = [],
}: {
  scriptHashes?: string[];
  styleHashes?: string[];
} = {}) =>
  [
    ...directives(
      `script-src 'self'${
        isDevelopment ? " 'unsafe-inline' 'unsafe-eval'" : ""
      }${scriptHashes.length ? ` ${scriptHashes.join(" ")}` : ""} https://accounts.google.com https://apis.google.com https://www.googletagmanager.com https://challenges.cloudflare.com`,
      `style-src 'self'${
        isDevelopment ? " 'unsafe-inline'" : ""
      }${styleHashes.length ? ` ${styleHashes.join(" ")}` : ""} https://accounts.google.com https://challenges.cloudflare.com`,
      "style-src-attr 'unsafe-inline'"
    ),
    "report-uri /api/security/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
