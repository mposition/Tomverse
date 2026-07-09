import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";

const r2Origin = (() => {
  try {
    const endpoint = process.env.R2_ENDPOINT;
    return endpoint ? new URL(endpoint).origin : null;
  } catch {
    return null;
  }
})();

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${
    isDevelopment ? " 'unsafe-eval'" : ""
  } https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
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
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
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
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
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

const nextConfig: NextConfig = {
  serverExternalPackages: ["officeparser"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
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

export default nextConfig;
