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
  } https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://*.googleapis.com https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com${
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
      } https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com`,
      `style-src 'self' 'nonce-${nonce}'${
        isDevelopment ? " 'unsafe-inline'" : ""
      } https://accounts.google.com https://challenges.cloudflare.com`,
      "style-src-attr 'unsafe-inline'"
    ),
    "report-uri /api/security/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
