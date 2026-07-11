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

  return (
    <html
      lang={initialLang}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SessionProviderWrapper session={session}>
          <LanguageProvider initialLang={initialLang}>{children}</LanguageProvider>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}
