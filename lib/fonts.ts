import { Geist, Geist_Mono, Noto_Sans_KR, Noto_Sans_SC } from "next/font/google";

// Preload policy is documented in docs/ui-contracts/typography.md. In short:
// only the Latin UI face is preloaded on every route; mono and the CJK faces
// are self-hosted but fetched on demand, so a Latin marketing page never pays
// for bytes it does not render.

export const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

export const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

export const notoSansKr = Noto_Sans_KR({
  variable: "--font-noto-sans-kr",
  display: "swap",
  preload: false,
});

export const notoSansSc = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  display: "swap",
  preload: false,
});

export const fontVariables = [
  geistSans.variable,
  geistMono.variable,
  notoSansKr.variable,
  notoSansSc.variable,
].join(" ");
