"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ExternalLink, Menu, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingLanguageSwitcher } from "./MarketingLanguageSwitcher";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { localizedPath } from "@/lib/seo";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

const resourceLinks: Record<Language, Array<{ label: string; path: string }>> = {
  en: [
    { label: "Compare AI models", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "AI file analysis", path: "/ai-for-file-analysis" },
  ],
  ko: [
    { label: "AI 모델 비교", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "AI 파일 분석", path: "/ai-for-file-analysis" },
  ],
  zh: [
    { label: "比较 AI 模型", path: "/compare-ai-models" },
    { label: "ChatGPT 与 Claude", path: "/chatgpt-vs-claude" },
    { label: "AI 文件分析", path: "/ai-for-file-analysis" },
  ],
  fr: [
    { label: "Comparer les modèles", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Analyse de fichiers", path: "/ai-for-file-analysis" },
  ],
  de: [
    { label: "KI-Modelle vergleichen", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "KI-Dateianalyse", path: "/ai-for-file-analysis" },
  ],
  es: [
    { label: "Comparar modelos", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Análisis de archivos", path: "/ai-for-file-analysis" },
  ],
  pt: [
    { label: "Comparar modelos", path: "/compare-ai-models" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Análise de arquivos", path: "/ai-for-file-analysis" },
  ],
};

const chrome = {
  en: {
    app: "Open app",
    menu: "Menu",
    close: "Close menu",
    topMenu: [
      { label: "About", href: "/about" },
      { label: "Features", href: "/#features" },
      { label: "Models", href: "/models" },
      { label: "Status", href: "/status" },
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
      { label: "Status", href: "/status" },
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
      { label: "상태", href: "/status" },
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
      { label: "상태", href: "/status" },
    ],
  },
  zh: {
    app: "打开应用",
    menu: "菜单",
    close: "关闭菜单",
    topMenu: [
      { label: "介绍", href: "/about" },
      { label: "功能", href: "/#features" },
      { label: "模型", href: "/models" },
      { label: "服务状态", href: "/status" },
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
      { label: "服务状态", href: "/status" },
    ],
  },
  fr: {
    app: "Ouvrir l'app",
    menu: "Menu",
    close: "Fermer le menu",
    topMenu: [
      { label: "A propos", href: "/about" },
      { label: "Fonctionnalites", href: "/#features" },
      { label: "Modeles", href: "/models" },
      { label: "Statut", href: "/status" },
      { label: "Tarifs", href: "/pricing" },
      { label: "Securite", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "Support", href: "/support" },
    ],
    footerMenu: [
      { label: "Conditions", href: "/terms" },
      { label: "Remboursement", href: "/refund" },
      { label: "Confidentialite", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Statut", href: "/status" },
    ],
  },
  de: {
    app: "App offnen",
    menu: "Menu",
    close: "Menu schliessen",
    topMenu: [
      { label: "Uber uns", href: "/about" },
      { label: "Funktionen", href: "/#features" },
      { label: "Modelle", href: "/models" },
      { label: "Status", href: "/status" },
      { label: "Preise", href: "/pricing" },
      { label: "Sicherheit", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "Support", href: "/support" },
    ],
    footerMenu: [
      { label: "Bedingungen", href: "/terms" },
      { label: "Ruckerstattung", href: "/refund" },
      { label: "Datenschutz", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Status", href: "/status" },
    ],
  },
  es: {
    app: "Abrir app",
    menu: "Menu",
    close: "Cerrar menu",
    topMenu: [
      { label: "Acerca de", href: "/about" },
      { label: "Funciones", href: "/#features" },
      { label: "Modelos", href: "/models" },
      { label: "Estado", href: "/status" },
      { label: "Precios", href: "/pricing" },
      { label: "Seguridad", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "Soporte", href: "/support" },
    ],
    footerMenu: [
      { label: "Terminos", href: "/terms" },
      { label: "Reembolso", href: "/refund" },
      { label: "Privacidad", href: "/privacy" },
      { label: "Soporte", href: "/support" },
      { label: "Estado", href: "/status" },
    ],
  },
  pt: {
    app: "Abrir app",
    menu: "Menu",
    close: "Fechar menu",
    topMenu: [
      { label: "Sobre", href: "/about" },
      { label: "Recursos", href: "/#features" },
      { label: "Modelos", href: "/models" },
      { label: "Status", href: "/status" },
      { label: "Precos", href: "/pricing" },
      { label: "Seguranca", href: "/safety" },
      { label: "FAQ", href: "/faq" },
      { label: "Suporte", href: "/support" },
    ],
    footerMenu: [
      { label: "Termos", href: "/terms" },
      { label: "Reembolso", href: "/refund" },
      { label: "Privacidade", href: "/privacy" },
      { label: "Suporte", href: "/support" },
      { label: "Status", href: "/status" },
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
  const labels = chrome[lang] ?? chrome.en;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const chatHref = `/chat?lang=${encodeURIComponent(lang)}`;

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
            <Link
              key={item.href}
              href={item.href}
              target={item.href === "/status" ? "_blank" : undefined}
              rel={item.href === "/status" ? "noopener noreferrer" : undefined}
              prefetch={item.href === "/status" ? false : undefined}
              aria-label={
                item.href === "/status"
                  ? statusLinkLabel(item.label, lang)
                  : undefined
              }
              title={
                item.href === "/status" ? statusNewTabCopy[lang] : undefined
              }
              data-testid={item.href === "/status" ? "header-status-link" : undefined}
              className="inline-flex items-center gap-1 hover:text-zinc-950 dark:hover:text-white"
            >
              {item.label}
              {item.href === "/status" && (
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              )}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <MarketingLanguageSwitcher />
          <Link
            href={chatHref}
            onClick={() =>
              trackProductEvent("cta_start_click", 0, {
                cta_location: "marketing_header",
              })
            }
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
                target={item.href === "/status" ? "_blank" : undefined}
                rel={item.href === "/status" ? "noopener noreferrer" : undefined}
                prefetch={item.href === "/status" ? false : undefined}
                aria-label={
                  item.href === "/status"
                    ? statusLinkLabel(item.label, lang)
                    : undefined
                }
                title={
                  item.href === "/status" ? statusNewTabCopy[lang] : undefined
                }
                data-testid={item.href === "/status" ? "mobile-status-link" : undefined}
                onClick={() => setIsMenuOpen(false)}
                className="flex items-center gap-2 rounded-xl px-3 py-3 text-base font-black text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {item.label}
                {item.href === "/status" && (
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                )}
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
              href={chatHref}
              onClick={() => {
                setIsMenuOpen(false);
                trackProductEvent("cta_start_click", 0, {
                  cta_location: "marketing_mobile_menu",
                });
              }}
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
  const labels = chrome[lang] ?? chrome.en;

  return (
    <footer className="border-t border-zinc-200 bg-white py-10 dark:border-zinc-800 dark:bg-zinc-950">
      <div className={`mx-auto flex ${maxWidth} flex-col gap-5 px-4 text-sm text-zinc-500 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8`}>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200 dark:ring-zinc-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
          </span>
          <span className="font-bold text-zinc-700 dark:text-zinc-300">Tomverse AI</span>
          <span>© 2026</span>
        </div>
        <nav className="flex flex-wrap gap-4">
          {labels.footerMenu.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              target={item.href === "/status" ? "_blank" : undefined}
              rel={item.href === "/status" ? "noopener noreferrer" : undefined}
              prefetch={item.href === "/status" ? false : undefined}
              aria-label={
                item.href === "/status"
                  ? statusLinkLabel(item.label, lang)
                  : undefined
              }
              title={
                item.href === "/status" ? statusNewTabCopy[lang] : undefined
              }
              data-testid={item.href === "/status" ? "footer-status-link" : undefined}
              className="inline-flex items-center gap-1 hover:text-zinc-950 dark:hover:text-white"
            >
              {item.label}
              {item.href === "/status" && (
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              )}
            </Link>
          ))}
          {resourceLinks[lang].map((item) => (
            <Link
              key={item.path}
              href={localizedPath(lang, item.path)}
              className="hover:text-zinc-950 dark:hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
