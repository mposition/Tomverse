import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";

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
    default: "Tomverse AI | Compare Leading AI Models",
    template: "%s | Tomverse AI",
  },
  description:
    "Tomverse AI helps you compare leading AI models, work with files, and organize useful conversations in one workspace.",
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
    title: "Tomverse AI | Compare Leading AI Models",
    description:
      "Compare leading AI models side by side, analyze files, and organize useful conversations in one workspace.",
    url: SITE_ORIGIN,
    locale: "en_AU",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Tomverse AI — compare leading AI models in one workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tomverse AI | Compare Leading AI Models",
    description:
      "Compare leading AI models side by side, analyze files, and organize useful conversations in one workspace.",
    images: [
      {
        url: "/twitter-image",
        alt: "Tomverse AI — compare leading AI models in one workspace",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
