"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingLanguageSwitcher } from "./MarketingLanguageSwitcher";

const chrome = {
  en: {
    app: "Open app",
    menu: "Menu",
    close: "Close menu",
    topMenu: [
      { label: "About", href: "/about" },
      { label: "Features", href: "/#features" },
      { label: "Models", href: "/models" },
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "Support", href: "/support" },
    ],
    footerMenu: [
      { label: "Terms", href: "/terms" },
      { label: "Refund", href: "/refund" },
      { label: "Privacy", href: "/privacy" },
      { label: "Support", href: "/support" },
    ],
  },
  ko: {
    app: "앱 열기",
    menu: "메뉴",
    close: "메뉴 닫기",
    topMenu: [
      { label: "소개", href: "/about" },
      { label: "기능", href: "/#features" },
      { label: "모델", href: "/models" },
      { label: "요금", href: "/pricing" },
      { label: "보안", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "지원", href: "/support" },
    ],
    footerMenu: [
      { label: "이용약관", href: "/terms" },
      { label: "환불", href: "/refund" },
      { label: "개인정보", href: "/privacy" },
      { label: "지원", href: "/support" },
    ],
  },
  zh: {
    app: "打开应用",
    menu: "菜单",
    close: "关闭菜单",
    topMenu: [
      { label: "关于", href: "/about" },
      { label: "功能", href: "/#features" },
      { label: "模型", href: "/models" },
      { label: "价格", href: "/pricing" },
      { label: "安全", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "支持", href: "/support" },
    ],
    footerMenu: [
      { label: "条款", href: "/terms" },
      { label: "退款", href: "/refund" },
      { label: "隐私", href: "/privacy" },
      { label: "支持", href: "/support" },
    ],
  },
} satisfies Record<
  Language,
  {
    app: string;
    menu: string;
    close: string;
    topMenu: Array<{ label: string; href: string }>;
    footerMenu: Array<{ label: string; href: string }>;
  }
>;

export function MarketingHeader({ maxWidth = "max-w-7xl" }: { maxWidth?: string }) {
  const { lang } = useLanguage();
  const labels = chrome[lang];
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className={`mx-auto flex h-16 ${maxWidth} items-center justify-between gap-3 px-4 sm:px-6 lg:px-8`}>
        <Link href="/" className="flex min-w-0 items-center gap-3" onClick={() => setIsMenuOpen(false)}>
          <span className="flex h-9 w-9 shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 dark:ring-zinc-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
          </span>
          <span className="truncate text-sm font-black">Tomverse AI</span>
        </Link>
        <nav className="hidden items-center gap-5 text-sm font-semibold text-zinc-600 dark:text-zinc-300 lg:flex">
          {labels.topMenu.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-zinc-950 dark:hover:text-white">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <MarketingLanguageSwitcher />
          <Link
            href="/chat"
            className="hidden h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white shadow-sm shadow-blue-950/20 transition hover:bg-blue-500 sm:inline-flex"
          >
            {labels.app}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <button
            type="button"
            aria-label={isMenuOpen ? labels.close : labels.menu}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((open) => !open)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 bg-white text-zinc-800 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 lg:hidden"
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {isMenuOpen && (
        <div className="border-t border-zinc-200 bg-white px-4 py-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 lg:hidden">
          <nav className={`mx-auto grid ${maxWidth} gap-2`}>
            {labels.topMenu.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsMenuOpen(false)}
                className="rounded-xl px-3 py-3 text-base font-black text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {item.label}
              </Link>
            ))}
            <div className="my-2 h-px bg-zinc-200 dark:bg-zinc-800" />
            {labels.footerMenu.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsMenuOpen(false)}
                className="rounded-xl px-3 py-2 text-sm font-bold text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/chat"
              onClick={() => setIsMenuOpen(false)}
              className="mt-3 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500"
            >
              {labels.app}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

export function MarketingFooter({ maxWidth = "max-w-7xl" }: { maxWidth?: string }) {
  const { lang } = useLanguage();
  const labels = chrome[lang];

  return (
    <footer className="border-t border-zinc-200 py-8 dark:border-zinc-800">
      <div className={`mx-auto flex ${maxWidth} flex-col gap-4 px-4 text-sm text-zinc-500 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8`}>
        <span className="font-semibold">Tomverse AI</span>
        <div className="flex flex-wrap gap-5">
          {labels.footerMenu.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-zinc-900 dark:hover:text-white">
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
