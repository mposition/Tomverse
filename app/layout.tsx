export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { Session } from "next-auth";
import { cookies } from "next/headers";

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
  description: "Tomverse 하나로 끝내세요! 다양한 최신 AI 모델의 답변을 동시에 비교하고 활용할 수 있는 올인원 AI 플랫폼입니다.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
    let session: Session | null = null;
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
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full overflow-hidden flex flex-col">
              <SessionProviderWrapper session={session}>
                  <LanguageProvider initialLang="en">
                      {children}
                  </LanguageProvider>
        </SessionProviderWrapper>      
      </body>
    </html>
  );
}
