import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";
import { ThemeController } from "@/components/ThemeController";
import { fontVariables } from "@/lib/fonts";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";

export const metadata: Metadata = {
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // VAL-004. The proxy resolves the document language for the request; see
  // lib/documentLanguage.ts for why the attribute has to be right in the
  // served markup rather than corrected after hydration.
  //
  // On a statically prerendered route this header is absent, and "en" is the
  // correct answer there: those routes are built once, with English copy, and
  // the localized marketing routes declare their own language on the content
  // they render.
  const documentLanguage = (await headers()).get(DOCUMENT_LANGUAGE_HEADER);
  const lang = isSupportedDocumentLanguage(documentLanguage)
    ? documentLanguage
    : "en";

  return (
    <html
      lang={lang}
      suppressHydrationWarning
      className={`${fontVariables} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeController />
        {children}
      </body>
    </html>
  );
}
