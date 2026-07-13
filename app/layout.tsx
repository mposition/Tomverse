export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { Language } from "@/components/LanguageProvider";
import type { Session } from "next-auth";
import { cookies, headers } from "next/headers";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import { prisma } from "@/lib/prisma";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";
import { StructuredData } from "@/components/seo/StructuredData";

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

const detectInitialLanguage = (acceptLanguage: string | null): Language => {
  const candidates =
    acceptLanguage
      ?.toLowerCase()
      .split(",")
      .map((part) => part.split(";")[0]?.trim())
      .filter(Boolean) ?? [];

  for (const candidate of candidates) {
    if (candidate === "ko" || candidate.startsWith("ko-")) return "ko";
    if (candidate === "zh" || candidate.startsWith("zh-")) return "zh";
    if (candidate === "fr" || candidate.startsWith("fr-")) return "fr";
    if (candidate === "de" || candidate.startsWith("de-")) return "de";
    if (candidate === "es" || candidate.startsWith("es-")) return "es";
    if (candidate === "pt" || candidate.startsWith("pt-")) return "pt";
    if (candidate === "en" || candidate.startsWith("en-")) return "en";
  }

  return "en";
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let session: Session | null = null;
  const requestHeaders = await headers();
  const pathnameLocale = requestHeaders
    .get("x-tomverse-pathname")
    ?.split("/")
    .filter(Boolean)[0]
    ?.toLowerCase();
  const initialLang =
    pathnameLocale === "en" ||
    pathnameLocale === "ko" ||
    pathnameLocale === "zh" ||
    pathnameLocale === "fr" ||
    pathnameLocale === "de" ||
    pathnameLocale === "es" ||
    pathnameLocale === "pt"
      ? pathnameLocale
      : detectInitialLanguage(requestHeaders.get("accept-language"));
  const nonce = requestHeaders.get("x-nonce");
  const countryCandidate = requestHeaders.get("cf-ipcountry")?.trim().toUpperCase();
  const analyticsCountry =
    countryCandidate && /^[A-Z]{2}$/.test(countryCandidate)
      ? countryCandidate
      : "ZZ";

  try {
    const e2eAuthCookie =
      process.env.E2E_AUTH_BYPASS === "true"
        ? (await cookies()).get("__tomverse_e2e_auth")?.value
        : null;

    if (process.env.E2E_AUTH_BYPASS === "true" && e2eAuthCookie === "1") {
      session = {
        user: {
          id: "qa-user",
          name: "QA User",
          email: "qa@tomverse.app",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      } as Session;
    } else {
      session = await getServerSession(authOptions);
    }
  } catch (e) {
    console.error("Layout session fetch error:", e);
  }

  let initialAnalyticsPlan: "Guest" | "Free" | "Pro" | "Max" = session?.user?.id
    ? "Free"
    : "Guest";
  let analyticsUserCreatedAt: string | null = null;
  if (session?.user?.id && process.env.E2E_AUTH_BYPASS !== "true") {
    try {
      const analyticsUser = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { plan: true, createdAt: true },
      });
      initialAnalyticsPlan =
        analyticsUser?.plan === "Pro" || analyticsUser?.plan === "Max"
          ? analyticsUser.plan
          : "Free";
      analyticsUserCreatedAt = analyticsUser?.createdAt?.toISOString() || null;
    } catch (error) {
      console.error("Layout analytics context fetch error:", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const configuredMeasurementId = process.env.GA4_MEASUREMENT_ID?.trim();
  const measurementId =
    configuredMeasurementId && /^G-[A-Z0-9]+$/.test(configuredMeasurementId)
      ? configuredMeasurementId
      : null;

  return (
    <html
      lang={initialLang}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <StructuredData
          nonce={nonce}
          data={{
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                "@id": `${SITE_ORIGIN}/#organization`,
                name: SITE_NAME,
                url: SITE_ORIGIN,
                logo: `${SITE_ORIGIN}/tomverse-logo.png`,
              },
              {
                "@type": "SoftwareApplication",
                "@id": `${SITE_ORIGIN}/#software-application`,
                name: SITE_NAME,
                url: SITE_ORIGIN,
                description:
                  "A multi-model AI workspace for comparing answers, analyzing files, and organizing conversations.",
                applicationCategory: "BusinessApplication",
                applicationSubCategory: "Artificial intelligence workspace",
                operatingSystem: "Any modern web browser",
                isAccessibleForFree: true,
                offers: {
                  "@type": "Offer",
                  price: "0",
                  priceCurrency: "USD",
                },
                publisher: { "@id": `${SITE_ORIGIN}/#organization` },
              },
            ],
          }}
        />
        <SessionProviderWrapper session={session}>
          <LanguageProvider initialLang={initialLang}>
            <AnalyticsProvider
              country={analyticsCountry}
              initialPlan={initialAnalyticsPlan}
              measurementId={measurementId}
              nonce={nonce}
              userCreatedAt={analyticsUserCreatedAt}
              disabled={process.env.E2E_AUTH_BYPASS === "true"}
            >
              {children}
            </AnalyticsProvider>
          </LanguageProvider>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}
