"use client";

import Script from "next/script";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import {
  analyticsConsent,
  configureAnalyticsClient,
  consumeSignupStarted,
  disableAnalyticsClient,
  setAnalyticsConsent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import {
  normalizeAnalyticsCountry,
  type AnalyticsConsentMode,
  type ResolvedAnalyticsConsentPolicy,
} from "@/lib/analyticsConsentPolicy";
import { ANALYTICS_PREFERENCES_OPEN_EVENT } from "@/lib/analyticsPreferencesEvents";

type ConsentState = "loading" | "unset" | "accepted" | "declined";

const GUEST_QUICK_START_ACTIVE_KEY = "tomverse_guest_quick_start_active_v2";
const GUEST_QUICK_START_EVENT = "tomverse:guest-quick-start";

// The chat shells register a flex-flow slot rendered directly above the
// composer. When present, the consent notice portals into it instead of
// floating as a viewport-fixed overlay, so it reserves its own space and
// can never cover composer controls (STG-F001).
type ChatConsentSlotSetter = (node: HTMLDivElement | null) => void;
const ChatConsentSlotContext = createContext<ChatConsentSlotSetter | null>(null);

export function useChatConsentSlotRef(): ChatConsentSlotSetter {
  const register = useContext(ChatConsentSlotContext);
  return register || (() => {});
}

// The sign-in page registers a slot in normal document flow right after the
// login card. Portaling the notice there (instead of a viewport-fixed bar)
// guarantees it can never cross over the card, the OAuth buttons, or the
// terms/privacy links -- on short viewports the page simply grows taller and
// scrolls, rather than a fixed element risking an overlap that would need to
// be measured at runtime (UI-P1-02).
type AuthConsentSlotSetter = (node: HTMLDivElement | null) => void;
const AuthConsentSlotContext = createContext<AuthConsentSlotSetter | null>(null);

export function useAuthConsentSlotRef(): AuthConsentSlotSetter {
  const register = useContext(AuthConsentSlotContext);
  return register || (() => {});
}

// Marketing pages register a slot directly under the sticky header. Before
// FINAL-F001 the notice stayed a bottom-anchored viewport-fixed card there,
// which at <=360px wide viewports landed exactly on the hero's primary CTA:
// document.elementFromPoint() at the CTA's centre returned the notice's own
// body copy, so the CTA could not be tapped at all while consent was
// pending. A bottom overlay cannot avoid that by shrinking -- at 360x640 the
// hero CTA ends 16px above the fold, so any bottom-anchored card taller than
// 16px covers it. Putting the notice in normal document flow (the same fix
// STG-F001 used for the chat composer) removes the overlap by construction
// at every viewport and scroll offset.
type MarketingConsentSlotSetter = (node: HTMLDivElement | null) => void;
const MarketingConsentSlotContext =
  createContext<MarketingConsentSlotSetter | null>(null);

export function useMarketingConsentSlotRef(): MarketingConsentSlotSetter {
  const register = useContext(MarketingConsentSlotContext);
  return register || (() => {});
}

// Rendered by MarketingChrome's header for every marketing route. It stays
// `empty:hidden` so a resolved (accepted/declined) consent state costs no
// layout box and no CLS.
export function MarketingConsentSlot({
  maxWidth = "max-w-7xl",
}: {
  maxWidth?: string;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const register = useMarketingConsentSlotRef();

  useEffect(() => {
    register(node);
    return () => register(null);
  }, [node, register]);

  return (
    <div
      ref={setNode}
      data-testid="marketing-consent-slot"
      className={`mx-auto ${maxWidth} px-4 py-2 empty:hidden sm:px-6 lg:px-8`}
    />
  );
}

const consentCopy: Record<
  Language,
  {
    title: string;
    body: string;
    mobileBody: string;
    accept: string;
    decline: string;
    privacy: string;
    settings: string;
    noticeTitle: string;
    noticeBody: string;
    noticeMobileBody: string;
    keepOn: string;
    turnOff: string;
  }
> = {
  en: {
    title: "Privacy-safe product analytics",
    body: "With your permission, Tomverse measures product usage and campaign attribution. Prompts, responses, filenames, and file contents are never included.",
    mobileBody: "Help improve Tomverse. Prompts and file contents are never collected.",
    accept: "Allow analytics",
    decline: "Decline",
    privacy: "Privacy policy",
    settings: "Analytics settings",
    noticeTitle: "Privacy-safe analytics is on",
    noticeBody: "In this region, Tomverse starts privacy-minimized product analytics with a clear opt-out. Prompts, responses, filenames, and file contents are never included, and advertising storage stays off.",
    noticeMobileBody: "Privacy-safe analytics is on. Prompts and files are never collected; you can turn it off now.",
    keepOn: "Keep analytics on",
    turnOff: "Turn off analytics",
  },
  ko: {
    title: "개인정보를 보호하는 제품 분석",
    body: "동의하면 Tomverse가 제품 사용과 캠페인 유입을 측정합니다. 프롬프트, 응답, 파일명 및 파일 내용은 절대 포함하지 않습니다.",
    mobileBody: "Tomverse 개선에 동의하시겠어요? 질문과 파일 내용은 수집하지 않습니다.",
    accept: "분석 허용",
    decline: "거부",
    privacy: "개인정보 처리방침",
    settings: "분석 설정",
    noticeTitle: "개인정보 보호 분석이 활성화되어 있습니다",
    noticeBody: "이 지역에서는 명확한 거부 기능과 함께 개인정보를 최소화한 제품 분석을 시작합니다. 프롬프트, 응답, 파일명 및 파일 내용은 포함하지 않으며 광고 저장 기능은 계속 꺼져 있습니다.",
    noticeMobileBody: "개인정보 보호 분석이 켜져 있습니다. 질문과 파일은 수집하지 않으며 지금 끌 수 있습니다.",
    keepOn: "분석 유지",
    turnOff: "분석 끄기",
  },
  zh: {
    title: "保护隐私的产品分析",
    body: "经您同意，Tomverse 会衡量产品使用和活动归因。绝不会收集提示词、回复、文件名或文件内容。",
    mobileBody: "帮助改进 Tomverse。绝不收集提示词和文件内容。",
    accept: "允许分析",
    decline: "拒绝",
    privacy: "隐私政策",
    settings: "分析设置",
    noticeTitle: "隐私保护分析已开启",
    noticeBody: "在此地区，Tomverse 会启动数据最小化的产品分析，并提供明确的退出选项。绝不会包含提示词、回复、文件名或文件内容，广告存储仍保持关闭。",
    noticeMobileBody: "隐私保护分析已开启。不会收集提示词或文件，您可立即关闭。",
    keepOn: "保持开启",
    turnOff: "关闭分析",
  },
  fr: {
    title: "Analyse produit respectueuse de la vie privée",
    body: "Avec votre accord, Tomverse mesure l’usage du produit et l’attribution des campagnes. Les prompts, réponses, noms et contenus de fichiers ne sont jamais inclus.",
    mobileBody: "Aidez à améliorer Tomverse. Prompts et fichiers ne sont jamais collectés.",
    accept: "Autoriser",
    decline: "Refuser",
    privacy: "Confidentialité",
    settings: "Paramètres d’analyse",
    noticeTitle: "L’analyse respectueuse de la vie privée est active",
    noticeBody: "Dans cette région, Tomverse active une analyse produit minimisée avec une option de refus claire. Les prompts, réponses, noms et contenus de fichiers ne sont jamais inclus, et le stockage publicitaire reste désactivé.",
    noticeMobileBody: "L’analyse respectueuse de la vie privée est active. Vous pouvez la désactiver maintenant.",
    keepOn: "Garder active",
    turnOff: "Désactiver",
  },
  de: {
    title: "Datenschutzfreundliche Produktanalyse",
    body: "Mit Ihrer Zustimmung misst Tomverse Produktnutzung und Kampagnenzuordnung. Prompts, Antworten, Dateinamen und Dateiinhalte werden niemals erfasst.",
    mobileBody: "Tomverse verbessern. Prompts und Dateiinhalte werden nie erfasst.",
    accept: "Analyse erlauben",
    decline: "Ablehnen",
    privacy: "Datenschutz",
    settings: "Analyse-Einstellungen",
    noticeTitle: "Datenschutzfreundliche Analyse ist aktiv",
    noticeBody: "In dieser Region startet Tomverse eine datensparsame Produktanalyse mit klarer Widerspruchsmöglichkeit. Prompts, Antworten, Dateinamen und Dateiinhalte werden nie einbezogen; Werbespeicher bleibt deaktiviert.",
    noticeMobileBody: "Datenschutzfreundliche Analyse ist aktiv und kann jetzt deaktiviert werden.",
    keepOn: "Aktiv lassen",
    turnOff: "Deaktivieren",
  },
  es: {
    title: "Analítica de producto con privacidad",
    body: "Con tu permiso, Tomverse mide el uso del producto y la atribución de campañas. Nunca se incluyen prompts, respuestas, nombres ni contenidos de archivos.",
    mobileBody: "Ayuda a mejorar Tomverse. Nunca recogemos prompts ni archivos.",
    accept: "Permitir analítica",
    decline: "Rechazar",
    privacy: "Privacidad",
    settings: "Ajustes de analítica",
    noticeTitle: "La analítica con privacidad está activa",
    noticeBody: "En esta región, Tomverse inicia analítica de producto minimizada con una opción clara para desactivarla. Nunca se incluyen prompts, respuestas, nombres ni contenidos de archivos, y el almacenamiento publicitario sigue desactivado.",
    noticeMobileBody: "La analítica con privacidad está activa. Puedes desactivarla ahora.",
    keepOn: "Mantener activa",
    turnOff: "Desactivar",
  },
  pt: {
    title: "Análise de produto com privacidade",
    body: "Com a sua permissão, o Tomverse mede a utilização do produto e a atribuição de campanhas. Prompts, respostas, nomes e conteúdos de ficheiros nunca são incluídos.",
    mobileBody: "Ajude a melhorar o Tomverse. Nunca recolhemos prompts nem ficheiros.",
    accept: "Permitir análise",
    decline: "Recusar",
    privacy: "Privacidade",
    settings: "Definições de análise",
    noticeTitle: "A análise com privacidade está ativa",
    noticeBody: "Nesta região, o Tomverse inicia análise de produto minimizada com uma opção clara de recusa. Prompts, respostas, nomes e conteúdos de ficheiros nunca são incluídos, e o armazenamento publicitário permanece desativado.",
    noticeMobileBody: "A análise com privacidade está ativa. Pode desativá-la agora.",
    keepOn: "Manter ativa",
    turnOff: "Desativar",
  },
};

export function AnalyticsProvider({
  children,
  country,
  initialPlan,
  measurementId,
  nonce,
  userCreatedAt,
  initialConsentMode = null,
  disabled = false,
}: {
  children: React.ReactNode;
  country: string;
  initialPlan: "Guest" | "Free" | "Pro" | "Max";
  measurementId: string | null;
  nonce: string | null;
  userCreatedAt: string | null;
  initialConsentMode?: AnalyticsConsentMode | null;
  disabled?: boolean;
}) {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const [consent, setConsent] = useState<ConsentState>("loading");
  const [resolvedPolicy, setResolvedPolicy] =
    useState<ResolvedAnalyticsConsentPolicy | null>(() =>
      initialConsentMode
        ? {
            country: normalizeAnalyticsCountry(country),
            mode: initialConsentMode,
          }
        : null
    );
  const [analyticsClientReady, setAnalyticsClientReady] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [chatConsentReady, setChatConsentReady] = useState(false);
  const [isMobileChatTextEntryActive, setIsMobileChatTextEntryActive] =
    useState(false);
  const [chatConsentSlot, setChatConsentSlot] = useState<HTMLDivElement | null>(
    null
  );
  const [authConsentSlot, setAuthConsentSlot] = useState<HTMLDivElement | null>(
    null
  );
  const [marketingConsentSlot, setMarketingConsentSlot] =
    useState<HTMLDivElement | null>(null);
  const lifecycleCheckedRef = useRef(false);
  const copy = consentCopy[lang];

  useEffect(() => {
    if (initialConsentMode || disabled) return;
    const controller = new AbortController();
    let cancelled = false;

    fetch("/api/analytics/consent-policy", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Analytics consent policy unavailable");
        const body = (await response.json()) as Partial<ResolvedAnalyticsConsentPolicy>;
        if (
          (body.mode !== "opt_in" && body.mode !== "notice_opt_out") ||
          normalizeAnalyticsCountry(body.country) !== body.country
        ) {
          throw new Error("Invalid analytics consent policy");
        }
        if (!cancelled) setResolvedPolicy(body as ResolvedAnalyticsConsentPolicy);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setResolvedPolicy({ country: "ZZ", mode: "opt_in" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [disabled, initialConsentMode]);

  useEffect(() => {
    let cancelled = false;
    if (disabled) {
      disableAnalyticsClient();
      queueMicrotask(() => {
        if (!cancelled) setConsent("declined");
      });
      return () => {
        cancelled = true;
      };
    }
    const stored = analyticsConsent();
    queueMicrotask(() => {
      if (cancelled) return;
      setConsent(
        stored === "accepted"
          ? "accepted"
          : stored === "declined"
            ? "declined"
            : "unset"
      );
    });
    return () => {
      cancelled = true;
    };
  }, [disabled]);

  useEffect(() => {
    let cancelled = false;
    const scheduleChatConsentReady = (ready: boolean) => {
      queueMicrotask(() => {
        if (!cancelled) setChatConsentReady(ready);
      });
    };
    const isChatPath = pathname === "/chat";
    if (!isChatPath) {
      scheduleChatConsentReady(false);
      return () => {
        cancelled = true;
      };
    }
    if (initialPlan !== "Guest") {
      scheduleChatConsentReady(true);
      return () => {
        cancelled = true;
      };
    }

    scheduleChatConsentReady(false);
    const handleQuickStartVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ visible?: unknown }>).detail;
      setChatConsentReady(detail?.visible !== true);
    };
    window.addEventListener(GUEST_QUICK_START_EVENT, handleQuickStartVisibility);

    const timeout = window.setTimeout(() => {
      setChatConsentReady(
        window.sessionStorage.getItem(GUEST_QUICK_START_ACTIVE_KEY) !== "1"
      );
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener(GUEST_QUICK_START_EVENT, handleQuickStartVisibility);
    };
  }, [initialPlan, pathname]);

  useEffect(() => {
    if (pathname !== "/chat") {
      queueMicrotask(() => setIsMobileChatTextEntryActive(false));
      return;
    }

    let frameId: number | null = null;
    const nonTextInputTypes = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "radio",
      "range",
      "reset",
      "submit",
    ]);
    const update = () => {
      frameId = null;
      const activeElement = document.activeElement;
      const isTextEntry =
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLInputElement &&
          !nonTextInputTypes.has(activeElement.type)) ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable);
      const visualViewport = window.visualViewport;
      const keyboardReducedViewport = Boolean(
        visualViewport && window.innerHeight - visualViewport.height > 120
      );
      const isMobile = window.matchMedia("(max-width: 767px)").matches;
      setIsMobileChatTextEntryActive(
        isMobile && (isTextEntry || keyboardReducedViewport)
      );
    };
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(update);
    };

    document.addEventListener("focusin", scheduleUpdate);
    document.addEventListener("focusout", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      document.removeEventListener("focusin", scheduleUpdate);
      document.removeEventListener("focusout", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    };
  }, [pathname]);

  useEffect(() => {
    if (disabled) return;
    const openPreferences = () => setShowPreferences(true);
    window.addEventListener(
      ANALYTICS_PREFERENCES_OPEN_EVENT,
      openPreferences
    );
    return () => {
      window.removeEventListener(
        ANALYTICS_PREFERENCES_OPEN_EVENT,
        openPreferences
      );
    };
  }, [disabled]);

  const analyticsEnabled = Boolean(
    resolvedPolicy &&
      (consent === "accepted" ||
        (consent === "unset" && resolvedPolicy.mode === "notice_opt_out"))
  );

  useEffect(() => {
    if (disabled || !analyticsEnabled || !resolvedPolicy) return;
    let cancelled = false;
    const runtime = configureAnalyticsClient({
      country: resolvedPolicy.country,
      language: lang,
      measurementId,
      plan: initialPlan,
    });
    queueMicrotask(() => {
      if (!cancelled) setAnalyticsClientReady(true);
    });
    if (!lifecycleCheckedRef.current) {
      lifecycleCheckedRef.current = true;

      const now = Date.now();
      const createdAt = userCreatedAt || runtime.firstSeenAt;
      const createdAtMs = new Date(createdAt).getTime();
      if (Number.isFinite(createdAtMs)) {
        const ageMs = now - createdAtMs;
        const dayMs = 24 * 60 * 60 * 1000;
        if (ageMs >= dayMs && ageMs < dayMs * 2) {
          trackProductEventOnce("return_day_1", "return_day_1");
        }
        if (ageMs >= dayMs * 7 && ageMs < dayMs * 8) {
          trackProductEventOnce("return_day_7", "return_day_7");
        }
      }

      const signup = userCreatedAt ? consumeSignupStarted() : null;
      if (signup && Number.isFinite(new Date(userCreatedAt!).getTime())) {
        const accountAgeMs = now - new Date(userCreatedAt!).getTime();
        if (accountAgeMs >= 0 && accountAgeMs <= 60 * 60 * 1000) {
          trackProductEventOnce("signup_completed", "signup_completed", 0, {
            method: signup.method,
          });
        }
      }
    }
    return () => {
      cancelled = true;
    };
  }, [analyticsEnabled, disabled, initialPlan, lang, measurementId, resolvedPolicy, userCreatedAt]);

  const accept = () => {
    setAnalyticsConsent("accepted");
    setConsent("accepted");
    setShowPreferences(false);
  };

  const decline = () => {
    setAnalyticsConsent("declined");
    disableAnalyticsClient();
    setConsent("declined");
    setShowPreferences(false);
  };

  const consentPromptReady = pathname !== "/chat" || chatConsentReady;
  const defaultEnabledNotice =
    consent === "unset" &&
    resolvedPolicy?.mode === "notice_opt_out" &&
    !showPreferences;
  const promptCopy = defaultEnabledNotice
    ? {
        title: copy.noticeTitle,
        body: copy.noticeBody,
        mobileBody: copy.noticeMobileBody,
        accept: copy.keepOn,
        decline: copy.turnOff,
      }
    : copy;

  // On /chat, once a shell has registered a slot above the composer, the
  // notice portals there instead of floating fixed over the viewport --
  // that slot reserves real layout space, so it can never cover composer
  // controls at any width. On /auth/signin the sign-in page registers a
  // similar slot right after the login card, and marketing routes register
  // one under the sticky header (FINAL-F001). Everywhere else (and before a
  // route's slot exists, e.g. the initial shell-loading skeleton) the
  // original fixed corner overlay is used instead.
  const inlineSlot =
    pathname === "/chat"
      ? chatConsentSlot
      : pathname === "/auth/signin"
        ? authConsentSlot
        : marketingConsentSlot;

  const showConsentPrompt =
    !disabled &&
    resolvedPolicy &&
    consentPromptReady &&
    (consent === "unset" || showPreferences);

  // Secondary, non-alarming styling: a light card on light theme and a
  // muted dark card on dark theme (instead of the old always-black
  // high-contrast bar), so the notice reads as an ordinary compact toast
  // rather than a warning that outweighs the surrounding page (UI-P1-02).
  const consentButtonClass =
    "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-zinc-300 bg-white px-2.5 text-[10px] font-black text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:focus-visible:ring-offset-zinc-900 sm:px-3 sm:text-[11px]";

  // The body copy used to carry `min-w-0` next to a `shrink-0` action pair, so
  // on narrow viewports it absorbed all of the shrink instead of triggering
  // the wrap this row already allows -- the audit measured 34.6px of body
  // width at 320px. Giving the copy a real minimum makes the existing
  // flex-wrap do its job: when the copy and the actions no longer both fit,
  // the actions drop to their own line rather than crushing the sentence.
  // It stays content-driven, so a locale with long action labels wraps at a
  // wider viewport than English does instead of at a hard-coded breakpoint.
  const noticeInner = (
    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-between sm:gap-3">
      <div className="min-w-[10rem] flex-1">
        <p className="text-[10px] leading-4 text-zinc-600 dark:text-zinc-300 sm:hidden">
          {promptCopy.mobileBody}{" "}
          <Link
            href="/privacy"
            className="font-bold text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
          >
            {copy.privacy}
          </Link>
        </p>
        <div className="hidden sm:block">
          <p className="text-xs font-black text-zinc-900 dark:text-zinc-50">{promptCopy.title}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{promptCopy.body}</p>
          <Link
            href="/privacy"
            className="mt-0.5 inline-flex text-[11px] font-bold text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
          >
            {copy.privacy}
          </Link>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="analytics-consent-decline"
          onClick={decline}
          className={consentButtonClass}
        >
          {promptCopy.decline}
        </button>
        <button
          type="button"
          data-testid="analytics-consent-accept"
          onClick={accept}
          className={consentButtonClass}
        >
          {promptCopy.accept}
        </button>
      </div>
    </div>
  );

  return (
    <ChatConsentSlotContext.Provider value={setChatConsentSlot}>
      <AuthConsentSlotContext.Provider value={setAuthConsentSlot}>
        <MarketingConsentSlotContext.Provider value={setMarketingConsentSlot}>
        {children}
        {analyticsEnabled && analyticsClientReady && measurementId ? (
          <Script
            id="tomverse-ga4"
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
            strategy="afterInteractive"
            nonce={nonce || undefined}
          />
        ) : null}
        {showConsentPrompt && inlineSlot
          ? createPortal(
              <div
                role="region"
                aria-label={promptCopy.title}
                data-testid="chat-consent-notice"
                className={
                  inlineSlot === marketingConsentSlot
                    ? // The marketing slot already supplies the page gutter, so
                      // the card spans it and never needs its own max-width.
                      "rounded-xl border border-zinc-200 bg-white/95 p-2 text-zinc-700 shadow-md shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:shadow-black/20 sm:p-3"
                    : "mx-2 mb-2 rounded-xl border border-zinc-200 bg-white/95 p-2 text-zinc-700 shadow-md shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:shadow-black/20 sm:mx-4 sm:ml-auto sm:max-w-sm sm:p-3"
                }
              >
                {noticeInner}
              </div>,
              inlineSlot
            )
          : null}
        {showConsentPrompt && !inlineSlot ? (
          <aside
            role="region"
            aria-label={promptCopy.title}
            data-testid="chat-consent-notice"
            className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-[100] w-[min(26rem,calc(100vw-1.5rem))] rounded-xl border border-zinc-200 bg-white/95 p-2 text-zinc-700 shadow-lg shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:shadow-black/30 sm:p-3"
          >
            {noticeInner}
          </aside>
        ) : null}
        {!disabled &&
        consentPromptReady &&
        !showPreferences &&
        !isMobileChatTextEntryActive &&
        !(pathname === "/chat" && initialPlan !== "Guest") &&
        (consent === "accepted" || consent === "declined") ? (
          <button
            type="button"
            data-testid="analytics-settings-button"
            onClick={() => setShowPreferences(true)}
            className={`fixed right-2 z-[60] rounded-full border border-zinc-700 bg-zinc-950/90 px-2.5 py-1 text-[10px] font-bold text-zinc-400 shadow-lg backdrop-blur hover:text-zinc-100 ${
              pathname === "/chat"
                ? // The chat sidebar/drawer offers its own path back to this
                  // (the account menu for signed-in users, an inline button
                  // next to "Login" for guests), so this floating overlay
                  // only needs to cover desktop, where it doesn't compete
                  // with the composer for space.
                  "hidden bottom-[5.5rem] md:inline-flex md:bottom-2"
                : "bottom-2"
            }`}
          >
            {copy.settings}
          </button>
        ) : null}
        </MarketingConsentSlotContext.Provider>
      </AuthConsentSlotContext.Provider>
    </ChatConsentSlotContext.Provider>
  );
}
