"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowRight, ExternalLink, Menu, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingConsentSlot } from "@/components/analytics/AnalyticsProvider";
import { MarketingLanguageSwitcher } from "./MarketingLanguageSwitcher";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";
import { LocaleSupportNotice } from "./LocaleSupportNotice";
import { marketingProductEntryHref, REVIEW_PRODUCT_PATH } from "@/lib/marketingRoutes";

// Only these paths actually have a `/[locale]` route (app/[locale]), so only
// these may be prefixed. `/models`, `/pricing`, `/faq`, `/terms` and the rest
// are single-route pages that pick their language up from LanguageProvider --
// prefixing them would 404.
//
// Without this the brand link and the "Features" anchor sent a visitor on
// /ko to `/`, which is the English canonical URL: the copy stayed Korean
// (localStorage), but the URL, the canonical tag and og:locale all switched
// to English mid-visit.
const localizedHref = (lang: Language, href: string) => {
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
  fr: {
    app: "Ouvrir Review",
    appSignedIn: "Revenir a Review",
    menu: "Menu",
    close: "Fermer le menu",
    topMenu: [
      { label: "Fonctionnement", href: "/#how-it-works" },
      { label: "Modeles", href: "/models" },
      { label: "Tarifs", href: "/pricing" },
      { label: "Confiance", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Conditions", href: "/terms" },
      { label: "Remboursement", href: "/refund" },
      { label: "Confidentialite", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Statut", href: "/status" },
    ],
  },
  de: {
    app: "Review oeffnen",
    appSignedIn: "Zurueck zu Review",
    menu: "Menu",
    close: "Menu schliessen",
    topMenu: [
      { label: "Funktionsweise", href: "/#how-it-works" },
      { label: "Modelle", href: "/models" },
      { label: "Preise", href: "/pricing" },
      { label: "Vertrauen", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Bedingungen", href: "/terms" },
      { label: "Ruckerstattung", href: "/refund" },
      { label: "Datenschutz", href: "/privacy" },
      { label: "Support", href: "/support" },
      { label: "Status", href: "/status" },
    ],
  },
  es: {
    app: "Abrir Review",
    appSignedIn: "Volver a Review",
    menu: "Menu",
    close: "Cerrar menu",
    topMenu: [
      { label: "Como funciona", href: "/#how-it-works" },
      { label: "Modelos", href: "/models" },
      { label: "Precios", href: "/pricing" },
      { label: "Confianza", href: "/#trust" },
    ],
    footerMenu: [
      { label: "FAQ", href: "/faq" },
      { label: "Terminos", href: "/terms" },
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
      { label: "Precos", href: "/pricing" },
      { label: "Confianca", href: "/#trust" },
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
};

export function MarketingHeader(props: MarketingHeaderProps = {}) {
  return props.variant === "launch" ? <LaunchMarketingHeader {...props} /> : <LegacyMarketingHeader {...props} />;
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHeroCtaVisible, setIsHeroCtaVisible] = useState(false);
  const chatHref = marketingProductEntryHref("review", lang, sessionStatus === "authenticated");
  // "Try it" is wrong for someone who already has an account open in another
  // tab -- on /pricing it read as an invitation to sign up again. Both labels
  // lead to the same place, so the loading state keeps the signed-out wording
  // rather than flashing a neutral placeholder on every prerendered marketing
  // page; only the wording changes once the session resolves, never the
  // destination.
  const appCtaLabel =
    sessionStatus === "authenticated" ? labels.appSignedIn : labels.app;

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
          {labels.topMenu.map((item) => (
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
            href={chatHref}
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
            {labels.topMenu.map((item) => (
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
              href={chatHref}
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
      <MarketingConsentSlot maxWidth={maxWidth} />
      <LocaleSupportNotice
        localizedContentAvailable={localizedContentAvailable}
        maxWidth={maxWidth}
      />
    </>
  );
}

type MarketingFooterProps = { maxWidth?: string; variant?: "default" | "launch" };

export function MarketingFooter(props: MarketingFooterProps = {}) {
  return props.variant === "launch" ? <LaunchMarketingFooter {...props} /> : <LegacyMarketingFooter {...props} />;
}

function LegacyMarketingFooter({ maxWidth = "max-w-7xl" }: MarketingFooterProps) {
  const { lang } = useLanguage();
  const labels = chrome[lang] ?? chrome.en;

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
    login: "로그인", start: "Chat 시작하기", back: "Chat으로 돌아가기", navigation: "주요 메뉴",
    description: "여러 AI를 한곳에서 사용하고, 질문에 맞는 모델을 선택하며, 서로 다른 답변의 관점을 비교하는 AI 작업 공간입니다.",
    caution: "중요한 판단 전 AI 답변을 직접 확인하세요.",
  },
  zh: {
    products: "产品", help: "帮助", policies: "政策", guides: "使用指南",
    models: "探索模型", pricing: "价格方案", helpCentre: "帮助中心", faq: "常见问题", support: "联系客服",
    status: "服务状态", safety: "安全与数据处理", privacy: "隐私政策", terms: "使用条款", refund: "退款政策",
    login: "登录", start: "开始 Chat", back: "返回 Chat", navigation: "主导航",
    description: "在同一个地方使用多个 AI，为问题选择模型，并比较回答中的不同观点。",
    caution: "做出重要决定前，请自行核实 AI 的回答。",
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

function LaunchMarketingHeader({
  maxWidth = "max-w-7xl",
  localizedContentAvailable = true,
  chatHref: suppliedChatHref,
  reviewInfoHref,
}: MarketingHeaderProps) {
  const { lang } = useLanguage();
  const copy = launchChrome[lang];
  const menuCopy = chrome[lang];
  const { status } = useSession();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const chatHref = suppliedChatHref ?? marketingProductEntryHref("chat", lang, status === "authenticated");
  const items = [
    { label: "Chat", href: chatHref, key: "chat" },
    { label: "Review", href: reviewInfoHref ?? localizedPath(lang, REVIEW_PRODUCT_PATH), key: "review" },
    { label: copy.pricing, href: "/pricing", key: "pricing" },
    { label: copy.models, href: "/models", key: "models" },
  ];
  const loginHref = `/auth/signin?callbackUrl=${encodeURIComponent(chatHref)}`;
  const appLabel = status === "authenticated" ? copy.back : copy.start;

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
      <header className="relative z-40 border-b border-white/10 bg-zinc-950 text-white" data-testid="launch-marketing-header">
        <div className={`mx-auto flex min-h-[72px] ${maxWidth} flex-wrap items-center justify-between gap-[12px] px-[16px] py-3 sm:px-6 lg:flex-nowrap lg:px-[64px]`}>
          <Link href={localizedHref(lang, "/")} className={`flex shrink-0 items-center gap-[8px] ${launchFocus}`} data-testid="marketing-brand-link" onClick={() => setIsMenuOpen(false)}>
            <span className="flex h-[36px] w-[36px] shrink-0 overflow-hidden rounded-[10px] bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
            </span>
            <span className="text-sm font-bold tracking-tight max-[240px]:sr-only sm:text-lg" data-testid="marketing-brand-name">Tomverse</span>
          </Link>
          <nav aria-label={copy.navigation} className="hidden items-center gap-6 text-sm font-semibold lg:flex">
            {items.map((item) => <Link key={item.key} href={item.href} data-testid={`header-${item.key}-link`} className={`py-3 text-zinc-300 transition hover:text-white ${launchFocus}`}>{item.label}</Link>)}
          </nav>
          <div className="flex min-w-0 items-center gap-[8px]">
            <div className="min-w-0 [&>label]:h-[44px] [&>label]:max-w-[126px] [&>label]:border-zinc-700 [&>label]:bg-zinc-900 [&>label]:text-zinc-100 [&_select]:text-zinc-100 [&_select]:[color-scheme:dark]">
              <MarketingLanguageSwitcher />
            </div>
            {status !== "authenticated" && <Link href={loginHref} className={`hidden px-2 py-3 text-sm font-semibold text-zinc-300 hover:text-white xl:inline-flex ${launchFocus}`}>{copy.login}</Link>}
            <Link href={chatHref} data-testid="marketing-header-app-cta" data-session-state={status} onClick={() => trackStart("marketing_header")} className={`hidden min-h-[44px] items-center gap-2 rounded-full bg-blue-600 px-5 py-2 text-center text-sm font-bold hover:bg-blue-500 lg:inline-flex ${launchFocus}`}>
              {appLabel}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
            <button ref={menuButtonRef} type="button" aria-label={isMenuOpen ? menuCopy.close : menuCopy.menu} aria-controls={menuId} aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)} data-testid="marketing-menu-button" className={`inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 lg:hidden ${launchFocus}`}>
              {isMenuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
          </div>
        </div>
        {isMenuOpen && <nav id={menuId} ref={menuRef} aria-label={copy.navigation} className={`mx-auto grid ${maxWidth} gap-1 border-t border-white/10 px-[16px] py-4 lg:hidden`}>
          {items.map((item) => <Link key={item.key} href={item.href} data-testid={`mobile-${item.key}-link`} onClick={() => setIsMenuOpen(false)} className={`rounded-lg px-3 py-3 font-semibold hover:bg-zinc-900 ${launchFocus}`}>{item.label}</Link>)}
          {status !== "authenticated" && <Link href={loginHref} onClick={() => setIsMenuOpen(false)} className={`rounded-lg px-3 py-3 font-semibold hover:bg-zinc-900 ${launchFocus}`}>{copy.login}</Link>}
          <Link href={chatHref} data-testid="marketing-mobile-app-cta" data-session-state={status} onClick={() => { setIsMenuOpen(false); trackStart("marketing_mobile_menu"); }} className={`mt-3 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3 text-sm font-bold hover:bg-blue-500 ${launchFocus}`}>
            {appLabel}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Link>
        </nav>}
      </header>
      <MarketingConsentSlot maxWidth={maxWidth} />
      <LocaleSupportNotice localizedContentAvailable={localizedContentAvailable} maxWidth={maxWidth} />
    </>
  );
}

function LaunchMarketingFooter({ maxWidth = "max-w-7xl" }: MarketingFooterProps) {
  const { lang } = useLanguage();
  const copy = launchChrome[lang];
  const columns = [
    { title: copy.products, items: [
      { label: "Tomverse Chat", href: marketingProductEntryHref("chat", lang) },
      { label: "Tomverse Review", href: localizedPath(lang, REVIEW_PRODUCT_PATH) },
      { label: copy.models, href: "/models" }, { label: copy.pricing, href: "/pricing" },
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
    <footer className="bg-zinc-950 text-zinc-400" data-testid="launch-marketing-footer">
      <div className={`mx-auto ${maxWidth} px-[16px] pb-8 pt-12 sm:px-6 lg:px-[64px]`}>
        <div className="grid gap-x-8 gap-y-10 lg:grid-cols-[1.8fr_3fr]">
          <div>
            <Link href={localizedHref(lang, "/")} className={`inline-flex items-center gap-3 text-2xl font-bold tracking-tight text-white ${launchFocus}`}>
              <span className="h-[36px] w-[36px] overflow-hidden rounded-[10px] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
              </span>Tomverse
            </Link>
            <p className="mt-4 max-w-md text-sm leading-6">{copy.description}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4">
            {columns.map((column) => <nav key={column.title} aria-label={column.title}>
              <h2 className="mb-3 text-sm font-semibold text-zinc-100">{column.title}</h2>
              <ul className="space-y-1">
                {column.items.map((item) => <li key={item.href}>
                  <Link href={item.href} target={item.href === "/status" ? "_blank" : undefined} rel={item.href === "/status" ? "noopener noreferrer" : undefined} prefetch={item.href === "/status" ? false : undefined} aria-label={item.href === "/status" ? statusLinkLabel(item.label, lang) : undefined} title={item.href === "/status" ? statusNewTabCopy[lang] : undefined} data-testid={item.href === "/status" ? "footer-status-link" : undefined} className={`inline-flex min-h-[36px] max-w-full items-center gap-1.5 py-1 text-sm leading-5 transition hover:text-white ${launchFocus}`}>
                    <span className="min-w-0 break-words">{item.label}</span>{item.href === "/status" && <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />}
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
