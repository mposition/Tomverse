import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";
import { ThemeController } from "@/components/ThemeController";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  applicationName: SITE_NAME,
  title: {
    default: "Tomverse Insight by Tomverse | Multi-AI Comparison & Review",
    template: "%s | Tomverse AI",
  },
  description:
    "Compare GPT, Claude, and Gemini side by side, then use AI Review to identify differences, omissions, and points that need verification.",
  authors: [{ name: "Tomverse AI", url: SITE_ORIGIN }],
  creator: "Tomverse AI",
  publisher: "Tomverse AI",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeController />
        {children}
      </body>
    </html>
  );
}
