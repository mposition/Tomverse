"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowRight, ExternalLink, Menu, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingLanguageSwitcher } from "./MarketingLanguageSwitcher";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";
import { LocaleSupportNotice } from "./LocaleSupportNotice";
import { developerToolsCopy } from "@/locales/developerTools";
import { CHAT_PRODUCT_PATH, CLI_DOWNLOAD_PATH, DEVELOPERS_PATH, REVIEW_PRODUCT_PATH, VSCODE_GUIDE_PATH } from "@/lib/marketingRoutes";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useMarketingChatEntry } from "./MarketingChatAvailability";

// Prefix only paths with an explicit `/[locale]` route. Legal pages keep their
// existing unprefixed destinations; service status takes its locale as a query.
//
// Without this the brand link and the "Features" anchor sent a visitor on
// /ko to `/`, which is the English canonical URL: the copy stayed Korean
// (localStorage), but the URL, the canonical tag and og:locale all switched
// to English mid-visit.
const localizedHref = (lang: Language, href: string) => {
  if (href === "/status") return `/status?lang=${encodeURIComponent(lang)}`;
  const resolvedHref = href.startsWith("/#") ? `${REVIEW_PRODUCT_PATH}${href.slice(1)}` : href;
  if (lang === "en") return resolvedHref;
  const [path, hash] = resolvedHref.split("#");
  const basePath = path || "/";
  if (!(LOCALIZED_SEO_PATHS as readonly string[]).includes(basePath)) return href;
  return `${localizedPath(lang, basePath)}${hash ? `#${hash}` : ""}`;
};

const resourceLinks: Record<Language, Array<{ label: string; path: string }>> = {
  en: [
    { label: "Compare AI models", path: "/compare-ai-models" },
    { label: "AI answer review", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "AI file analysis", path: "/ai-for-file-analysis" },
  ],
  ko: [
    { label: "AI 모델 비교", path: "/compare-ai-models" },
    { label: "AI 답변 교차검토", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "AI 파일 분석", path: "/ai-for-file-analysis" },
  ],
  zh: [
    { label: "比较 AI 模型", path: "/compare-ai-models" },
    { label: "AI 回答交叉审查", path: "/ai-answer-review" },
    { label: "ChatGPT 与 Claude", path: "/chatgpt-vs-claude" },
    { label: "AI 文件分析", path: "/ai-for-file-analysis" },
  ],
  "zh-Hant": [
    { label: "比較 AI 模型", path: "/compare-ai-models" },
    { label: "AI 回答交叉審查", path: "/ai-answer-review" },
    { label: "ChatGPT 與 Claude", path: "/chatgpt-vs-claude" },
    { label: "AI 檔案分析", path: "/ai-for-file-analysis" },
  ],
  fr: [
    { label: "Comparer les modèles", path: "/compare-ai-models" },
    { label: "Revue des réponses IA", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Analyse de fichiers", path: "/ai-for-file-analysis" },
  ],
  de: [
    { label: "KI-Modelle vergleichen", path: "/compare-ai-models" },
    { label: "KI-Antworten prüfen", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "KI-Dateianalyse", path: "/ai-for-file-analysis" },
  ],
  es: [
    { label: "Comparar modelos", path: "/compare-ai-models" },
    { label: "Revisar respuestas de IA", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Análisis de archivos", path: "/ai-for-file-analysis" },
  ],
  pt: [
    { label: "Comparar modelos", path: "/compare-ai-models" },
    { label: "Revisar respostas de IA", path: "/ai-answer-review" },
    { label: "ChatGPT vs Claude", path: "/chatgpt-vs-claude" },
    { label: "Análise de arquivos", path: "/ai-for-file-analysis" },
  ],
};

const chrome = {
  en: {
    app: "Open Review",
    appSignedIn: "Back to Review",
    menu: "Menu",
    close: "Close menu",
    topMenu: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "Models", href: "/models" },
      { label: "Pricing", href: "/pricing" },
      { label: "Trust", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Terms", href: "/terms" },
      { label: "Refund", href: "/refund" },
      { label: "Privacy", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Status", href: "/status" },
    ],
  },
  ko: {
    app: "Review 열기",
    appSignedIn: "Review로 돌아가기",
    menu: "메뉴",
    close: "메뉴 닫기",
    topMenu: [
      { label: "작동 방식", href: "/#how-it-works" },
      { label: "모델", href: "/models" },
      { label: "요금", href: "/pricing" },
      { label: "신뢰", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "이용약관", href: "/terms" },
      { label: "환불", href: "/refund" },
      { label: "개인정보", href: "/privacy" },
      { label: "지원", href: "/support" },
      { label: "상태", href: "/status" },
    ],
  },
  zh: {
    app: "打开 Review",
    appSignedIn: "返回 Review",
    menu: "菜单",
    close: "关闭菜单",
    topMenu: [
      { label: "运作方式", href: "/#how-it-works" },
      { label: "模型", href: "/models" },
      { label: "价格", href: "/pricing" },
      { label: "信任", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "条款", href: "/terms" },
      { label: "退款", href: "/refund" },
      { label: "隐私", href: "/privacy" },
      { label: "支持", href: "/support" },
      { label: "服务状态", href: "/status" },
    ],
  },
  "zh-Hant": {
    app: "開啟 Review",
    appSignedIn: "返回 Review",
    menu: "選單",
    close: "關閉選單",
    topMenu: [
      { label: "運作方式", href: "/#how-it-works" },
      { label: "模型", href: "/models" },
      { label: "價格", href: "/pricing" },
      { label: "信任", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "條款", href: "/terms" },
      { label: "退款", href: "/refund" },
      { label: "隱私", href: "/privacy" },
      { label: "支援", href: "/support" },
      { label: "服務狀態", href: "/status" },
    ],
  },
  fr: {
    app: "Ouvrir Review",
    appSignedIn: "Revenir à Review",
    menu: "Menu",
    close: "Fermer le menu",
    topMenu: [
      { label: "Fonctionnement", href: "/#how-it-works" },
      { label: "Modèles", href: "/models" },
      { label: "Tarifs", href: "/pricing" },
      { label: "Confiance", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Conditions", href: "/terms" },
      { label: "Remboursement", href: "/refund" },
      { label: "Confidentialité", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Statut", href: "/status" },
    ],
  },
  de: {
    app: "Review öffnen",
    appSignedIn: "Zurück zu Review",
    menu: "Menü",
    close: "Menü schließen",
    topMenu: [
      { label: "Funktionsweise", href: "/#how-it-works" },
      { label: "Modelle", href: "/models" },
      { label: "Preise", href: "/pricing" },
      { label: "Vertrauen", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Bedingungen", href: "/terms" },
      { label: "Rückerstattung", href: "/refund" },
      { label: "Datenschutz", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Status", href: "/status" },
    ],
  },
  es: {
    app: "Abrir Review",
    appSignedIn: "Volver a Review",
    menu: "Menú",
    close: "Cerrar menú",
    topMenu: [
      { label: "Cómo funciona", href: "/#how-it-works" },
      { label: "Modelos", href: "/models" },
      { label: "Precios", href: "/pricing" },
      { label: "Confianza", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Términos", href: "/terms" },
      { label: "Reembolso", href: "/refund" },
      { label: "Privacidad", href: "/privacy" },
      { label: "Soporte", href: "/support" },
      { label: "Estado", href: "/status" },
    ],
  },
  pt: {
    app: "Abrir o Review",
    appSignedIn: "Voltar ao Review",
    menu: "Menu",
    close: "Fechar menu",
    topMenu: [
      { label: "Como funciona", href: "/#how-it-works" },
      { label: "Modelos", href: "/models" },
      { label: "Preços", href: "/pricing" },
      { label: "Confiança", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
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
    appSignedIn: string;
    menu: string;
    close: string;
    topMenu: Array<{ label: string; href: string }>;
    footerMenu: Array<{ label: string; href: string }>;
  }
>;

type MarketingHeaderProps = {
  maxWidth?: string;
  localizedContentAvailable?: boolean;
  variant?: "default" | "launch";
  chatHref?: string;
  reviewInfoHref?: string;
  showMobileEntry?: boolean;
};

export function MarketingHeader(props: MarketingHeaderProps = {}) {
  return props.variant === "default" ? <LegacyMarketingHeader {...props} /> : <LaunchMarketingHeader {...props} />;
}

function LegacyMarketingHeader({
  maxWidth = "max-w-7xl",
  localizedContentAvailable = true,
}: {
  maxWidth?: string;
  localizedContentAvailable?: boolean;
}) {
  const { lang } = useLanguage();
  const labels = chrome[lang] ?? chrome.en;
  const { status: sessionStatus } = useSession();
  const entry = useMarketingChatEntry();
  const navigationItems = [
    { label: lang === "ko" ? "채팅" : lang === "zh" || lang === "zh-Hant" ? "聊天" : "Chat", href: entry.chatHref },
    { label: lang === "ko" ? "리뷰" : lang === "zh" ? "回答比较" : lang === "zh-Hant" ? "回答比較" : "Review", href: REVIEW_PRODUCT_PATH },
    ...labels.topMenu.slice(1),
  ];
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHeroCtaVisible, setIsHeroCtaVisible] = useState(false);
  // Availability determines the product entry; copy follows that destination.
  const primaryHref = entry.primaryHref;
  const appCtaLabel = entry.primaryProduct === "chat"
    ? sessionStatus === "authenticated" ? launchChrome[lang].back : launchChrome[lang].start
    : sessionStatus === "authenticated" ? labels.appSignedIn : labels.app;

  useEffect(() => {
    const heroCta = document.getElementById("landing-hero-primary");
    if (!heroCta) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsHeroCtaVisible(entry.isIntersecting),
      { threshold: 0.35 }
    );
    observer.observe(heroCta);
    return () => observer.disconnect();
  }, []);

  const headerCtaClass = isHeroCtaVisible
    ? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
    : "bg-blue-600 text-white shadow-sm shadow-blue-950/20 hover:bg-blue-500";

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      {/*
        FINAL-F001 / EXT-REAUDIT-F002 (WCAG 1.4.4 Resize text). UI-TOUCH-001
        gave this row's three controls a real 44px box, which is the right call
        for touch -- but it expressed them in rem, so at a 200% root font size
        they became 88px and pushed /pricing 102px past a 320px viewport (94px
        before, so the target fix made the overflow slightly worse).

        The fix keeps every 44px target exactly as UI-TOUCH-001 intended and
        removes the rem growth instead: the controls are sized in px, and so is
        this row's non-text chrome -- the gutter, the gaps and the logo square.
        Those are decoration and spacing, not customer text, so freezing them
        costs nothing at 200% while leaving room for the text that does scale.

        The row stays `h-16` and non-wrapping on purpose. `flex-wrap` also
        fixes 200%, but it regresses the ordinary case: the right-hand group's
        max-content width exceeds what is left after the brand at 320 and
        360px, so the browser wraps instead of letting the language switcher
        shrink -- a two-row, 92px header on the most common phone widths.
        Shrinking is what FINAL-F004 chose deliberately, so it is preserved.

        Verified at 320/390px on /, /pricing, /privacy and /chat, in English
        and Korean, by tests/e2e/root-font-resize-text.spec.ts.
      */}
      <div className={`mx-auto flex h-16 ${maxWidth} items-center justify-between gap-[12px] px-[16px] sm:px-6 lg:px-8`}>
        {/*
          FINAL-F004: the brand used to be the only shrinkable item in this
          row, so the language switcher's 10.5rem cap pushed it down to 60px
          at 320px and the `truncate` collapsed the brand to "T.".
          The brand is now shrink-0 and drops the qualifier (never a partial
          word) on narrow viewports, while the switcher absorbs the shrink.
          The logo is decorative here, so its alt is empty and the link's
          accessible name is exactly the visible brand text.
        */}
        <Link
          href={localizedHref(lang, "/")}
          className="flex shrink-0 items-center gap-[8px] sm:gap-3"
          data-testid="marketing-brand-link"
          onClick={() => setIsMenuOpen(false)}
        >
          <span className="flex h-[36px] w-[36px] shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 dark:ring-zinc-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
          </span>
          <span
            data-testid="marketing-brand-name"
            className="whitespace-nowrap text-sm font-bold"
          >
            {/*
              UI-005. Below ~240px of viewport -- a 320px phone at 200% zoom,
              which WCAG reflow expects to work -- the row's three fixed items
              (logo, language switcher, menu button) already need every pixel,
              and the brand word was what tipped the header into horizontal
              overflow. It goes screen-reader-only there rather than truncating
              to a fragment, so the link keeps its accessible name and the logo
              still reads as home. FINAL-F004's "never a partial word" contract
              is preserved: the word is either whole or absent.

              There used to be two spans here, a short one and a wide one, and
              the only difference between them was the `Review` qualifier. The
              brand is the platform now, so there is one word at every width
              and the pair collapsed into this line.
            */}
            <span className="max-[240px]:sr-only">Tomverse</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-5 text-sm font-semibold text-zinc-600 dark:text-zinc-300 lg:flex">
          {navigationItems.map((item) => (
            <Link
              key={item.href}
              href={localizedHref(lang, item.href)}
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
              data-testid={
                item.href === "/status"
                  ? "header-status-link"
                  : item.href === "/#how-it-works"
                    ? "header-features-link"
                    : item.href === "/#trust"
                      ? "header-trust-link"
                      : undefined
              }
              className="inline-flex items-center gap-1 hover:text-zinc-950 dark:hover:text-white"
            >
              {item.label}
              {item.href === "/status" && (
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              )}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 items-center gap-[8px]">
          <MarketingLanguageSwitcher />
          <Link
            href={primaryHref}
            onClick={() =>
              trackProductEvent("cta_start_click", 0, {
                cta_location: "marketing_header",
              })
            }
            // Matches the 44px floor its two row-mates now carry (UI-TOUCH-001)
            // so the header's controls stay a single, even row rather than a
            // 40px CTA flanked by 44px neighbours. Expressed in px, not rem,
            // so a 200% root font cannot double it into the overflow that
            // FINAL-F001 tracks -- the label inside still scales.
            data-testid="marketing-header-app-cta"
            data-session-state={sessionStatus}
            className={`hidden h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-bold transition sm:inline-flex ${headerCtaClass}`}
          >
            {appCtaLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <button
            type="button"
            aria-label={isMenuOpen ? labels.close : labels.menu}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((open) => !open)}
            data-testid="marketing-menu-button"
            // UI-TOUCH-001. This is the only way to reach the top menu below
            // `lg`, so it is a core mobile action and owns a real 44x44 box
            // rather than a 40x40 one grown by a pseudo-element -- the header
            // has the room, and a real box is what a hit test can prove.
            //
            // FINAL-F001: that box is in px rather than rem. As `h-11 w-11` it
            // was 44x44 normally but 88x88 at a 200% root font size, which is
            // what carried the header off-screen; px keeps the target at the
            // minimum at every text scale, and the icon still scales.
            className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-zinc-300 bg-white text-zinc-800 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 lg:hidden"
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {isMenuOpen && (
        <div className="border-t border-zinc-200 bg-white px-4 py-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 lg:hidden">
          <nav className={`mx-auto grid ${maxWidth} gap-2`}>
            {navigationItems.map((item) => (
              <Link
                key={item.href}
                href={localizedHref(lang, item.href)}
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
                data-testid={
                  item.href === "/status"
                    ? "mobile-status-link"
                    : item.href === "/#how-it-works"
                      ? "mobile-features-link"
                      : item.href === "/#trust"
                        ? "mobile-trust-link"
                        : undefined
                }
                onClick={() => setIsMenuOpen(false)}
                className="flex items-center gap-2 rounded-xl px-3 py-3 text-base font-bold text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {item.label}
                {item.href === "/status" && (
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                )}
              </Link>
            ))}
            <Link
              href={primaryHref}
              onClick={() => {
                setIsMenuOpen(false);
                trackProductEvent("cta_start_click", 0, {
                  cta_location: "marketing_mobile_menu",
                });
              }}
              data-testid="marketing-mobile-app-cta"
              data-session-state={sessionStatus}
              className={`mt-3 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition ${headerCtaClass}`}
            >
              {appCtaLabel}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      )}
      </header>
      {/*
        FINAL-F001: the analytics consent notice renders here, in normal
        document flow, instead of as a bottom-anchored fixed overlay that
        covered the hero's primary CTA on <=360px viewports.
      */}
      <LocaleSupportNotice
        localizedContentAvailable={localizedContentAvailable}
        maxWidth={maxWidth}
      />
    </>
  );
}

type MarketingFooterProps = { maxWidth?: string; variant?: "default" | "launch" };

export function MarketingFooter(props: MarketingFooterProps = {}) {
  return props.variant === "default" ? <LegacyMarketingFooter {...props} /> : <LaunchMarketingFooter {...props} />;
}

function LegacyMarketingFooter({ maxWidth = "max-w-7xl" }: MarketingFooterProps) {
  const { lang } = useLanguage();
  const labels = chrome[lang] ?? chrome.en;
  const entry = useMarketingChatEntry();

  return (
    <footer className="border-t border-zinc-200 bg-white py-10 dark:border-zinc-800 dark:bg-zinc-950">
      <div className={`mx-auto flex ${maxWidth} flex-col gap-5 px-4 text-sm text-zinc-500 dark:text-zinc-400 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8`}>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200 dark:ring-zinc-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
          </span>
          <span className="font-bold text-zinc-700 dark:text-zinc-300">Tomverse</span>
          <span>© 2026</span>
        </div>
        <nav className="flex flex-wrap gap-4">
          <Link href={entry.chatHref} className="hover:text-zinc-950 dark:hover:text-white">Tomverse Chat</Link>
          <Link href={localizedHref(lang, REVIEW_PRODUCT_PATH)} className="hover:text-zinc-950 dark:hover:text-white">Tomverse Review</Link>
          {labels.footerMenu.map((item) => (
            <Link
              key={item.href}
              href={item.href === "/status" ? `/status?lang=${encodeURIComponent(lang)}` : localizedHref(lang, item.href)}
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

const launchChrome = {
  en: {
    products: "Products", help: "Help", policies: "Policies", guides: "Guides",
    models: "Explore models", pricing: "Pricing", helpCentre: "Help centre", faq: "FAQ", support: "Contact support",
    status: "Service status", safety: "Safety and data", privacy: "Privacy policy", terms: "Terms of use", refund: "Refund policy",
    login: "Sign in", start: "Start Chat", back: "Back to Chat", navigation: "Main navigation",
    description: "Use several AIs in one place, choose models for your questions and compare different perspectives on the answers.",
    caution: "Check AI answers yourself before making important decisions.",
  },
  ko: {
    products: "제품", help: "도움말", policies: "정책", guides: "활용 가이드",
    models: "모델 살펴보기", pricing: "요금제", helpCentre: "도움말 센터", faq: "자주 묻는 질문", support: "고객 지원",
    status: "서비스 상태", safety: "안전과 데이터 처리", privacy: "개인정보 처리방침", terms: "이용약관", refund: "환불 정책",
    login: "로그인", start: "채팅 시작하기", back: "채팅으로 돌아가기", navigation: "주요 메뉴",
    description: "여러 AI를 한곳에서 사용하고, 질문에 맞는 모델을 선택하며, 서로 다른 답변의 관점을 비교하는 AI 작업 공간입니다.",
    caution: "중요한 판단 전 AI 답변을 직접 확인하세요.",
  },
  zh: {
    products: "产品", help: "帮助", policies: "政策", guides: "使用指南",
    models: "探索模型", pricing: "价格方案", helpCentre: "帮助中心", faq: "常见问题", support: "联系客服",
    status: "服务状态", safety: "安全与数据处理", privacy: "隐私政策", terms: "使用条款", refund: "退款政策",
    login: "登录", start: "开始聊天", back: "返回聊天", navigation: "主导航",
    description: "在同一个地方使用多个 AI，为问题选择模型，并比较回答中的不同观点。",
    caution: "做出重要决定前，请自行核实 AI 的回答。",
  },
  "zh-Hant": {
    products: "產品", help: "說明", policies: "政策", guides: "使用指南",
    models: "探索模型", pricing: "價格方案", helpCentre: "說明中心", faq: "常見問題", support: "聯絡客服",
    status: "服務狀態", safety: "安全與資料處理", privacy: "隱私權政策", terms: "使用條款", refund: "退款政策",
    login: "登入", start: "開始聊天", back: "返回聊天", navigation: "主導覽",
    description: "在同一個地方使用多個 AI，為問題選擇模型，並比較回答中的不同觀點。",
    caution: "做出重要決定前，請自行查證 AI 的回答。",
  },
  fr: {
    products: "Produits", help: "Aide", policies: "Politiques", guides: "Guides",
    models: "Explorer les modèles", pricing: "Tarifs", helpCentre: "Centre d’aide", faq: "Questions fréquentes", support: "Contacter l’assistance",
    status: "État du service", safety: "Sécurité et données", privacy: "Confidentialité", terms: "Conditions d’utilisation", refund: "Remboursements",
    login: "Connexion", start: "Démarrer Chat", back: "Revenir à Chat", navigation: "Navigation principale",
    description: "Utilisez plusieurs IA au même endroit, choisissez des modèles pour vos questions et comparez leurs points de vue.",
    caution: "Vérifiez les réponses IA avant toute décision importante.",
  },
  de: {
    products: "Produkte", help: "Hilfe", policies: "Richtlinien", guides: "Anleitungen",
    models: "Modelle entdecken", pricing: "Tarife", helpCentre: "Hilfecenter", faq: "Häufige Fragen", support: "Support kontaktieren",
    status: "Servicestatus", safety: "Sicherheit und Daten", privacy: "Datenschutz", terms: "Nutzungsbedingungen", refund: "Erstattungen",
    login: "Anmelden", start: "Chat starten", back: "Zurück zu Chat", navigation: "Hauptnavigation",
    description: "Nutzen Sie mehrere KIs an einem Ort, wählen Sie Modelle für Ihre Fragen und vergleichen Sie unterschiedliche Perspektiven.",
    caution: "Prüfen Sie KI-Antworten vor wichtigen Entscheidungen selbst.",
  },
  es: {
    products: "Productos", help: "Ayuda", policies: "Políticas", guides: "Guías",
    models: "Explorar modelos", pricing: "Planes", helpCentre: "Centro de ayuda", faq: "Preguntas frecuentes", support: "Contactar soporte",
    status: "Estado del servicio", safety: "Seguridad y datos", privacy: "Privacidad", terms: "Términos de uso", refund: "Reembolsos",
    login: "Iniciar sesión", start: "Empezar Chat", back: "Volver a Chat", navigation: "Navegación principal",
    description: "Usa varias IA en un mismo lugar, elige modelos para tus preguntas y compara diferentes perspectivas en sus respuestas.",
    caution: "Verifica las respuestas de IA antes de tomar decisiones importantes.",
  },
  pt: {
    products: "Produtos", help: "Ajuda", policies: "Políticas", guides: "Guias",
    models: "Explorar modelos", pricing: "Planos", helpCentre: "Central de ajuda", faq: "Perguntas frequentes", support: "Contatar suporte",
    status: "Status do serviço", safety: "Segurança e dados", privacy: "Privacidade", terms: "Termos de uso", refund: "Reembolsos",
    login: "Entrar", start: "Começar Chat", back: "Voltar ao Chat", navigation: "Navegação principal",
    description: "Use várias IAs em um só lugar, escolha modelos para suas perguntas e compare diferentes perspectivas nas respostas.",
    caution: "Verifique as respostas de IA antes de tomar decisões importantes.",
  },
} satisfies Record<Language, Record<string, string>>;

const launchFocus = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400";

type NavEntry = { title: string; body: string; href: string };
type NavCopy = { chat: string; review: string; developers: string; models: string; chatMenu: string; developersMenu: string; soon: string; apiKeys: string; chatItems: NavEntry[]; developerItems: NavEntry[] };

// Homepage V2 navigation (owner approval 2026-11-20): 채팅 and 개발자 open
// drop-downs into their pages' sections. `{n}` is the live provider count.
const navEntries = (lang: Language): NavCopy => {
  const c = launchNav[lang];
  return {
    ...c,
    chatItems: c.chatItems.map((item, i) => ({ ...item, href: `${CHAT_PRODUCT_PATH}${["", "#continue", "#create", "#plugins", "#mobile"][i]}` })),
    developerItems: [
      { ...c.developerItems[0], href: DEVELOPERS_PATH },
      { ...c.developerItems[2], href: CLI_DOWNLOAD_PATH },
      { title: "Tomverse for VS Code", body: developerToolsCopy[lang].editor, href: VSCODE_GUIDE_PATH },
      { ...c.developerItems[1], href: `${DEVELOPERS_PATH}#connect` },
    ],
  };
};
const launchNav: Record<Language, Omit<NavCopy, "chatItems" | "developerItems"> & { chatItems: Array<Omit<NavEntry, "href">>; developerItems: Array<Omit<NavEntry, "href">> }> = {
  ko: {
    chat: "채팅", review: "답변 비교", developers: "개발자", models: "모델", chatMenu: "채팅 기능", developersMenu: "개발자 메뉴", soon: "곧 출시", apiKeys: "API 키 관리",
    chatItems: [
      { title: "스마트 자동(Smart Adaptive)", body: "질문을 다듬고 맞는 모델로" }, { title: "대화 이어가기", body: "다른 AI의 대화를 가져와 계속" },
      { title: "이미지 · 파일", body: "생성, 사진 편집, 파일 변환" }, { title: "플러그인 · MCP", body: "업무 도구를 대화 안으로" }, { title: "모바일 앱", body: "Android · iOS 곧 출시" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "API 키 하나로 공급자 {n}곳" }, { title: "코딩 도구 연결", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Tomverse CLI 설치", body: "터미널의 코딩 에이전트" },
    ],
  },
  en: {
    chat: "Chat", review: "Review", developers: "Developers", models: "Models", chatMenu: "Chat features", developersMenu: "Developer menu", soon: "Coming soon", apiKeys: "Manage API keys",
    chatItems: [
      { title: "Smart Adaptive", body: "Sharpens the question, picks the model" }, { title: "Continue a conversation", body: "Bring a chat from another AI and carry on" },
      { title: "Images · files", body: "Generation, photo editing, file conversion" }, { title: "Plugins · MCP", body: "Your work tools inside the chat" }, { title: "Mobile apps", body: "Android · iOS coming soon" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "{n} providers with one API key" }, { title: "Connect coding tools", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Install Tomverse CLI", body: "A coding agent in your terminal" },
    ],
  },
  zh: {
    chat: "聊天", review: "回答比较", developers: "开发者", models: "模型", chatMenu: "聊天功能", developersMenu: "开发者菜单", soon: "即将推出", apiKeys: "管理 API 密钥",
    chatItems: [
      { title: "Smart Adaptive", body: "优化问题，匹配合适的模型" }, { title: "继续对话", body: "导入其他 AI 的对话并继续" },
      { title: "图片 · 文件", body: "生成、照片编辑、文件转换" }, { title: "插件 · MCP", body: "把工作工具带进对话" }, { title: "移动应用", body: "Android · iOS 即将推出" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "一个 API 密钥，{n} 家提供商" }, { title: "连接编程工具", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "安装 Tomverse CLI", body: "终端里的编程代理" },
    ],
  },
  "zh-Hant": {
    chat: "聊天", review: "回答比較", developers: "開發者", models: "模型", chatMenu: "聊天功能", developersMenu: "開發者選單", soon: "即將推出", apiKeys: "管理 API 金鑰",
    chatItems: [
      { title: "Smart Adaptive", body: "優化問題，配對合適的模型" }, { title: "繼續對話", body: "匯入其他 AI 的對話並繼續" },
      { title: "圖片 · 檔案", body: "生成、照片編輯、檔案轉換" }, { title: "外掛 · MCP", body: "把工作工具帶進對話" }, { title: "行動應用程式", body: "Android · iOS 即將推出" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "一組 API 金鑰，{n} 家供應商" }, { title: "連接程式設計工具", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "安裝 Tomverse CLI", body: "終端機裡的程式設計代理" },
    ],
  },
  fr: {
    chat: "Chat", review: "Review", developers: "Développeurs", models: "Modèles", chatMenu: "Fonctions de Chat", developersMenu: "Menu développeurs", soon: "Bientôt", apiKeys: "Gérer les clés API",
    chatItems: [
      { title: "Smart Adaptive", body: "Affine la question, choisit le modèle" }, { title: "Reprendre une conversation", body: "Importez une conversation d’une autre IA" },
      { title: "Images · fichiers", body: "Génération, retouche photo, conversion" }, { title: "Plugins · MCP", body: "Vos outils de travail dans la conversation" }, { title: "Applications mobiles", body: "Android · iOS bientôt" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "{n} fournisseurs avec une seule clé API" }, { title: "Connecter vos outils", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Installer Tomverse CLI", body: "Un agent de code dans votre terminal" },
    ],
  },
  de: {
    chat: "Chat", review: "Review", developers: "Entwickler", models: "Modelle", chatMenu: "Chat-Funktionen", developersMenu: "Entwicklermenü", soon: "In Kürze", apiKeys: "API-Schlüssel verwalten",
    chatItems: [
      { title: "Smart Adaptive", body: "Schärft die Frage, wählt das Modell" }, { title: "Unterhaltung fortsetzen", body: "Chats aus anderen KIs übernehmen" },
      { title: "Bilder · Dateien", body: "Erstellen, Fotobearbeitung, Umwandlung" }, { title: "Plugins · MCP", body: "Ihre Arbeitstools im Chat" }, { title: "Mobile Apps", body: "Android · iOS in Kürze" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "{n} Anbieter mit einem API-Schlüssel" }, { title: "Coding-Tools verbinden", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Tomverse CLI installieren", body: "Ein Coding-Agent im Terminal" },
    ],
  },
  es: {
    chat: "Chat", review: "Review", developers: "Desarrolladores", models: "Modelos", chatMenu: "Funciones de Chat", developersMenu: "Menú de desarrolladores", soon: "Muy pronto", apiKeys: "Gestionar claves de API",
    chatItems: [
      { title: "Smart Adaptive", body: "Afina la pregunta y elige el modelo" }, { title: "Continuar una conversación", body: "Trae un chat de otra IA y sigue" },
      { title: "Imágenes · archivos", body: "Generación, edición de fotos, conversión" }, { title: "Plugins · MCP", body: "Tus herramientas de trabajo en el chat" }, { title: "Apps móviles", body: "Android · iOS muy pronto" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "{n} proveedores con una clave de API" }, { title: "Conectar herramientas", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Instalar Tomverse CLI", body: "Un agente de código en tu terminal" },
    ],
  },
  pt: {
    chat: "Chat", review: "Review", developers: "Desenvolvedores", models: "Modelos", chatMenu: "Recursos do Chat", developersMenu: "Menu de desenvolvedores", soon: "Em breve", apiKeys: "Gerenciar chaves de API",
    chatItems: [
      { title: "Smart Adaptive", body: "Refina a pergunta e escolhe o modelo" }, { title: "Continuar uma conversa", body: "Traga um chat de outra IA e continue" },
      { title: "Imagens · arquivos", body: "Geração, edição de fotos, conversão" }, { title: "Plugins · MCP", body: "Suas ferramentas de trabalho no chat" }, { title: "Apps móveis", body: "Android · iOS em breve" },
    ],
    developerItems: [
      { title: "Tomverse API", body: "{n} provedores com uma chave de API" }, { title: "Conectar ferramentas", body: "Codex · Claude Code · Cursor · VS Code" }, { title: "Instalar o Tomverse CLI", body: "Um agente de código no seu terminal" },
    ],
  },
};

function NavMenu({ label, items, testId, href, menuLabel, n, lang }: {
  label: string; items: NavEntry[]; testId: string; href: string; menuLabel: string; n: number; lang: Language;
}) {
  return <div className="group relative">
    <Link href={localizedHref(lang, href)} data-testid={testId}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white group-focus-within:text-white ${launchFocus}`}>
      <span className="after:ml-1 after:text-[11px] after:text-zinc-400 after:content-['▾'_/_'']">{label}</span>
    </Link>
    {/* Opens on hover and on keyboard focus within; every entry is also a plain link on its page. */}
    <div role="group" aria-label={menuLabel}
      className="invisible absolute left-[-16px] top-full z-50 grid min-w-[280px] gap-0.5 rounded-2xl bg-[rgb(28_30_37/0.97)] p-2 opacity-0 shadow-[inset_0_0_0_1px_#31343f,0_24px_60px_-20px_rgb(0_0_0/0.6)] backdrop-blur-xl transition duration-150 before:absolute before:inset-x-0 before:-top-3 before:h-3 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 mt-2">
      {items.map((item) => <Link key={item.href} href={localizedHref(lang, item.href)}
        className={`grid gap-0.5 rounded-[10px] px-3 py-2.5 hover:bg-[#272a33] ${launchFocus}`}>
        <b className="text-sm font-bold text-zinc-50">{item.title}</b>
        <span className="text-xs font-medium text-zinc-400">{item.body.replaceAll("{n}", String(n))}</span>
      </Link>)}
    </div>
  </div>;
}

function LaunchMarketingHeader({
  maxWidth = "max-w-7xl",
  localizedContentAvailable = true,
  chatHref: suppliedChatHref,
  reviewInfoHref,
  showMobileEntry = false,
}: MarketingHeaderProps) {
  const { lang } = useLanguage();
  const copy = launchChrome[lang];
  const menuCopy = chrome[lang];
  const { status } = useSession();
  const entry = useMarketingChatEntry();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const chatHref = entry.chatAvailable ? suppliedChatHref ?? entry.chatHref : entry.chatHref;
  const nav = navEntries(lang);
  const { publicModels } = useModelCatalog();
  const providerCount = new Set(publicModels.map((model) => model.provider)).size;
  const n = providerCount >= 3 ? providerCount : 12;
  // The header and footer go to pages; the CTA opens the app.
  const items = [
    { label: nav.chat, href: CHAT_PRODUCT_PATH, key: "chat", menu: nav.chatItems, menuLabel: nav.chatMenu },
    { label: nav.review, href: reviewInfoHref ?? localizedPath(lang, REVIEW_PRODUCT_PATH), key: "review" },
    { label: nav.developers, href: DEVELOPERS_PATH, key: "developers", menu: nav.developerItems, menuLabel: nav.developersMenu },
    { label: copy.pricing, href: "/pricing", key: "pricing" },
    { label: nav.models, href: "/models", key: "models" },
  ];
  const primaryHref = entry.chatAvailable ? chatHref : entry.reviewHref;
  const loginHref = `/auth/signin?callbackUrl=${encodeURIComponent(primaryHref)}`;
  const appLabel = entry.primaryProduct === "chat"
    ? status === "authenticated" ? copy.back : copy.start
    : status === "authenticated" ? menuCopy.appSignedIn : menuCopy.app;

  useEffect(() => {
    if (!isMenuOpen) return;
    menuRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setIsMenuOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      desktop.removeEventListener("change", closeOnDesktop);
    };
  }, [isMenuOpen]);

  const trackStart = (location: string) => trackProductEvent("cta_start_click", 0, { cta_location: location });

  return (
    <>
      <header className="relative z-40 border-b border-white/[0.08] lg:sticky lg:top-0 bg-[rgb(17_19_24/0.82)] text-white backdrop-blur-xl backdrop-saturate-150" data-testid="launch-marketing-header">
        <div className={`mx-auto ${showMobileEntry ? "grid grid-cols-[minmax(0,1fr)_auto] lg:flex" : "flex flex-wrap"} min-h-[72px] ${maxWidth} items-center justify-between gap-[12px] px-[16px] py-3 sm:px-6 lg:flex-nowrap lg:px-[64px]`}>
          <Link href={localizedHref(lang, "/")} className={`flex shrink-0 ${showMobileEntry ? "min-w-0 flex-wrap" : ""} items-center gap-[8px] ${launchFocus}`} data-testid="marketing-brand-link" onClick={() => setIsMenuOpen(false)}>
            <span className="flex h-[36px] w-[36px] shrink-0 overflow-hidden rounded-[10px] bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
            </span>
            <span className="text-sm font-bold tracking-[-0.02em] max-[240px]:sr-only sm:text-lg"><span data-testid="marketing-brand-name" className="after:content-['.'_/_'']">Tomverse</span></span>
          </Link>
          <nav aria-label={copy.navigation} className="hidden items-center gap-1 text-sm font-semibold lg:flex">
            {items.map((item) => item.menu
              ? <NavMenu key={item.key} label={item.label} items={item.menu} href={item.href} testId={`header-${item.key}-link`} menuLabel={item.menuLabel} n={n} lang={lang} />
              : <Link key={item.key} href={localizedHref(lang, item.href)} data-testid={`header-${item.key}-link`} className={`inline-flex items-center gap-1 rounded-full px-3 py-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white ${launchFocus}`}>
                <span className={item.key === "review" ? "after:ml-1 after:text-[11px] after:text-[#5b8dff] after:content-['✦'_/_'']" : undefined}>{item.label}</span>
              </Link>)}
          </nav>
          <div className={`${showMobileEntry ? "contents lg:flex" : "flex"} min-w-0 items-center gap-[8px]`}>
            <div className="min-w-0 [&>label]:h-[44px] [&>label]:max-w-[126px] [&>label]:border-zinc-700 [&>label]:bg-zinc-900 [&>label]:text-zinc-100 [&_select]:text-zinc-100 [&_select]:[color-scheme:dark]">
              <MarketingLanguageSwitcher />
            </div>
            {status !== "authenticated" && <Link href={loginHref} className={`hidden shrink-0 whitespace-nowrap px-2 py-3 text-sm font-semibold text-zinc-300 hover:text-white lg:inline-flex ${launchFocus}`}>{copy.login}</Link>}
            <Link href={primaryHref} data-testid="marketing-header-app-cta" data-session-state={status} onClick={() => trackStart("marketing_header")} className={`${showMobileEntry ? "col-start-1 row-start-2 inline-flex min-w-0 justify-center px-3 lg:px-5" : "hidden px-5"} min-h-[44px] items-center gap-2 whitespace-nowrap rounded-full bg-[#155dfb] py-2 text-center text-sm font-bold shadow-[0_10px_40px_-12px_rgb(21_93_251/0.8)] transition hover:-translate-y-px hover:bg-[#144ee0] lg:inline-flex ${launchFocus}`}>
              {appLabel}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
            <button ref={menuButtonRef} type="button" aria-label={isMenuOpen ? menuCopy.close : menuCopy.menu} aria-controls={menuId} aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)} data-testid="marketing-menu-button" className={`${showMobileEntry ? "col-start-2 row-start-2 justify-self-end" : ""} inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 lg:hidden ${launchFocus}`}>
              {isMenuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
          </div>
        </div>
        {isMenuOpen && <nav id={menuId} ref={menuRef} aria-label={copy.navigation} className={`mx-auto grid ${maxWidth} gap-1 border-t border-white/10 px-[16px] py-4 lg:hidden`}>
          {items.map((item) => <div key={item.key} className="grid">
            <Link href={localizedHref(lang, item.href)} data-testid={`mobile-${item.key}-link`} onClick={() => setIsMenuOpen(false)} className={`rounded-lg px-3 py-3 font-semibold hover:bg-zinc-900 ${launchFocus}`}>{item.label}</Link>
            {item.key === "developers" && <div className="grid gap-1 border-l border-zinc-700 pl-3 ml-3" aria-label={nav.developersMenu}>
              {nav.developerItems.map((child) => <Link key={child.href} href={localizedHref(lang, child.href)} onClick={() => setIsMenuOpen(false)} className={`rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 ${launchFocus}`}>{child.title}</Link>)}
            </div>}
          </div>)}
          {status !== "authenticated" && <Link href={loginHref} onClick={() => setIsMenuOpen(false)} className={`rounded-lg px-3 py-3 font-semibold hover:bg-zinc-900 ${launchFocus}`}>{copy.login}</Link>}
          <Link href={primaryHref} data-testid="marketing-mobile-app-cta" data-session-state={status} onClick={() => { setIsMenuOpen(false); trackStart("marketing_mobile_menu"); }} className={`mt-3 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3 text-sm font-bold hover:bg-blue-500 ${launchFocus}`}>
            {appLabel}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Link>
        </nav>}
      </header>
      <LocaleSupportNotice localizedContentAvailable={localizedContentAvailable} maxWidth={maxWidth} />
    </>
  );
}

function LaunchMarketingFooter({ maxWidth = "max-w-7xl" }: MarketingFooterProps) {
  const { lang } = useLanguage();
  const copy = launchChrome[lang];
  const nav = navEntries(lang);
  const columns: Array<{ title: string; items: Array<{ label: string; href: string; soon?: boolean }> }> = [
    { title: copy.products, items: [
      { label: "Tomverse Chat", href: CHAT_PRODUCT_PATH },
      { label: "Tomverse Review", href: localizedPath(lang, REVIEW_PRODUCT_PATH) },
      { label: nav.chatItems[3].title, href: `${CHAT_PRODUCT_PATH}#plugins` },
      { label: nav.chatItems[4].title, href: `${CHAT_PRODUCT_PATH}#mobile`, soon: true },
      { label: copy.models, href: "/models" }, { label: copy.pricing, href: "/pricing" },
    ] },
    { title: nav.developers, items: [
      { label: "Tomverse API", href: DEVELOPERS_PATH },
      { label: nav.apiKeys, href: "/settings/api" },
      { label: nav.developerItems[1].title, href: CLI_DOWNLOAD_PATH },
      { label: "Tomverse for VS Code", href: VSCODE_GUIDE_PATH },
    ] },
    { title: copy.help, items: [
      { label: copy.helpCentre, href: "/support/help-centre" }, { label: copy.faq, href: "/faq" },
      { label: copy.support, href: "/support" }, { label: copy.status, href: "/status" },
    ] },
    { title: copy.guides, items: resourceLinks[lang].map((item) => ({ label: item.label, href: localizedPath(lang, item.path) })) },
    { title: copy.policies, items: [
      { label: copy.safety, href: "/safety" }, { label: copy.privacy, href: "/privacy" },
      { label: copy.terms, href: "/terms" }, { label: copy.refund, href: "/refund" },
    ] },
  ];
  return (
    <footer className="border-t border-zinc-800 bg-zinc-950 text-zinc-400" data-testid="launch-marketing-footer">
      <div className={`mx-auto ${maxWidth} px-[16px] pb-8 pt-12 sm:px-6 lg:px-[64px]`}>
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-[1.8fr_3fr]">
          <div className="min-w-0">
            <Link href={localizedHref(lang, "/")} className={`inline-flex max-w-full flex-wrap items-center gap-3 text-2xl font-bold tracking-tight text-white ${launchFocus}`}>
              <span className="h-[36px] w-[36px] shrink-0 overflow-hidden rounded-[10px] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
              </span><span className="min-w-0 tracking-[-0.02em] [overflow-wrap:anywhere] after:content-['.'_/_'']">Tomverse</span>
            </Link>
            <p className="mt-4 max-w-md text-sm leading-6">{copy.description}</p>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-8 max-[240px]:grid-cols-1 sm:grid-cols-3 xl:grid-cols-5">
            {columns.map((column) => <nav key={column.title} aria-label={column.title} className="min-w-0 [overflow-wrap:anywhere]">
              <h2 className="mb-3 text-sm font-semibold text-zinc-100">{column.title}</h2>
              <ul className="space-y-1">
                {column.items.map((item) => <li key={item.href}>
                  <Link href={localizedHref(lang, item.href)} target={item.href === "/status" ? "_blank" : undefined} rel={item.href === "/status" ? "noopener noreferrer" : undefined} prefetch={item.href === "/status" ? false : undefined} aria-label={item.href === "/status" ? statusLinkLabel(item.label, lang) : undefined} title={item.href === "/status" ? statusNewTabCopy[lang] : undefined} data-testid={item.href === "/status" ? "footer-status-link" : undefined} className={`inline-flex min-h-[36px] max-w-full items-center gap-1.5 py-1 text-sm leading-5 transition hover:text-white ${launchFocus}`}>
                    <span className="min-w-0 break-words">{item.label}{item.soon && <em className="ml-1 text-[11px] font-semibold not-italic text-[#5b8dff]">{nav.soon}</em>}</span>{item.href === "/status" && <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />}
                  </Link>
                </li>)}
              </ul>
            </nav>)}
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-3 border-t border-zinc-800 pt-6 text-xs leading-5 sm:flex-row sm:justify-between sm:gap-8">
          <p>© 2026 Tomverse</p><p>{copy.caution}</p>
        </div>
      </div>
    </footer>
  );
}
