import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
// A relative path, not the `@/` alias: this file is loaded by Next's config
// loader rather than by the app's module graph, so tsconfig paths do not
// apply here.
import { robotsDecision } from "./lib/robotsPolicyCore";

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // `microphone=(self)` restores the feature's own default allowlist for this
    // origin, rather than granting anything new. The empty list that was here
    // before disables the feature for *every* origin including this one, which
    // is stricter than "off by default" -- `getUserMedia` rejects with
    // `NotAllowedError` before any permission prompt, so neither a user
    // granting microphone access nor `feature.voiceInputEnabled` could reach
    // the recorder. Voice input (docs/policy/voice-input.md §8) needs the
    // document's own origin allowed, and nothing more: no `*`, no third-party
    // origin, and every other feature here stays disabled.
    //
    // The permissions-policy integration in the Media Capture and Streams
    // specification is what makes an empty list decisive rather than advisory:
    // https://www.w3.org/TR/mediacapture-streams/#permissions-policy-integration
    //
    // Verified against a real document response and a real `getUserMedia` in
    // tests/e2e/microphone-permissions-policy.spec.ts, which does not replace
    // the device API -- replacing it is exactly how this went unnoticed.
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin-allow-popups",
  },
  {
    key: "X-Permitted-Cross-Domain-Policies",
    value: "none",
  },
];

// lib/seo.ts is the canonical home for this, but importing it here would pull
// the app's module graph into the config loader. The duplication is held to
// one value and pinned by tests/robotsRoute.test.mjs, which reads this file
// and compares the literal with `SITE_ORIGIN`.
const CANONICAL_SITE_ORIGIN = "https://tomverse.app";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["officeparser"],
  // Workspace packages ship TypeScript source and no build output, so the app
  // that consumes them compiles them (docs/policy/shared-packages.md).
  // That is the point: a package with its own build step would need its own
  // target decisions, and the first thing to diverge would be exactly the
  // chat behaviour these packages exist to keep identical.
  transpilePackages: ["@tomverse/chat-core"],
  experimental: {
    sri: {
      algorithm: "sha384",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // Belt to app/robots.ts's braces, on every response a non-canonical
      // deployment serves.
      //
      // `robots.txt` and `X-Robots-Tag` do different jobs, and only the second
      // one is about indexing: Google is explicit that a disallowed URL can
      // still surface in results when something links to it, because the
      // refusal stops the fetch and not the listing. A `noindex` header is
      // read by whatever did fetch the page and keeps it out of the index.
      //
      // Neither is access control. If staging ever holds something that must
      // not be read, the answer is authentication, not a header.
      //
      // Evaluated at build time, like the robots decision itself -- so a
      // deployment that changes `PUBLIC_APP_URL` has to rebuild before either
      // of them changes.
      ...(robotsDecision(CANONICAL_SITE_ORIGIN, process.env).kind === "canonical"
        ? []
        : [
            {
              source: "/:path*",
              headers: [
                {
                  key: "X-Robots-Tag",
                  value: "noindex, nofollow, noarchive",
                },
              ],
            },
          ]),
      {
        source: "/share/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive",
          },
        ],
      },
    ];
  },
};

const sentryBuildConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
);

export default sentryBuildConfigured
  ? withSentryConfig(nextConfig, {
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: !process.env.CI,
      sourcemaps: {
        deleteSourcemapsAfterUpload: true,
      },
    })
  : nextConfig;
