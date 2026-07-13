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

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tomverse",
  description:
    "Tomverse AI helps you compare leading AI models, work with files, and organize useful conversations in one workspace.",
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
  const initialLang = detectInitialLanguage(requestHeaders.get("accept-language"));
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
