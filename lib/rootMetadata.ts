import type { Metadata, Viewport } from "next";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";

/**
 * The document-level metadata every root layout shares.
 *
 * VAL-004 / RECON-I18N-001. The app has more than one root layout -- the
 * localized marketing routes need `<html lang>` to come from their own route
 * param, which a shared layout above them cannot see. Splitting the layouts
 * would have duplicated this block per root, and a title template or an
 * `metadataBase` that drifted between roots is the kind of difference nobody
 * notices until a share card renders wrong. It lives here instead, and each
 * root re-exports it.
 */
export const rootMetadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  applicationName: SITE_NAME,
  title: {
    default: "Tomverse Insight by Tomverse | Multi-AI Comparison & Review",
    template: "%s | Tomverse Insight",
  },
  description:
    "Compare GPT, Claude, and Gemini side by side, then use AI Review to identify differences, omissions, and points that need verification.",
  authors: [{ name: "Tomverse Insight", url: SITE_ORIGIN }],
  creator: "Tomverse Insight",
  publisher: "Tomverse Insight",
  category: "technology",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "Tomverse Insight by Tomverse | Multi-AI Comparison & Review",
    description:
      "Compare GPT, Claude, and Gemini side by side, then use AI Review to identify differences, omissions, and points that need verification.",
    url: SITE_ORIGIN,
    locale: "en_AU",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Tomverse Insight by Tomverse — compare GPT, Claude, and Gemini side by side",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tomverse Insight by Tomverse | Multi-AI Comparison & Review",
    description:
      "Compare GPT, Claude, and Gemini side by side, then use AI Review to identify differences, omissions, and points that need verification.",
    images: [
      {
        url: "/twitter-image",
        alt: "Tomverse Insight by Tomverse — compare GPT, Claude, and Gemini side by side",
      },
    ],
  },
  verification: {
    ...(process.env.GOOGLE_SITE_VERIFICATION
      ? { google: process.env.GOOGLE_SITE_VERIFICATION }
      : {}),
    ...(process.env.BING_SITE_VERIFICATION
      ? {
          other: {
            "msvalidate.01": process.env.BING_SITE_VERIFICATION,
          },
        }
      : {}),
  },
};

/**
 * The viewport every root layout shares, for the same reason `rootMetadata`
 * is shared: there is more than one root and they must not drift apart.
 */
export const rootViewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Required for `env(safe-area-inset-*)` to resolve to anything but 0px. The
  // chat header, composer and every bottom sheet already reserve space with
  // those insets; without `viewport-fit=cover` all of that padding is inert and
  // controls sit under the notch / Dynamic Island / home indicator.
  viewportFit: "cover",
  // Resize the layout viewport when the software keyboard opens, so the
  // `100dvh` app shell keeps the composer above the keyboard instead of behind
  // it. Without this, `dvh` tracks browser chrome but not the keyboard.
  interactiveWidget: "resizes-content",
  // Tint the mobile browser chrome to match the app surfaces defined in
  // app/globals.css; keep these in step with `--background`.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};
