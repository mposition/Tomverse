"use client";

import Script from "next/script";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

type ConsentState = "loading" | "unset" | "accepted" | "declined";

const GUEST_QUICK_START_ACTIVE_KEY = "tomverse_guest_quick_start_active_v2";
const GUEST_QUICK_START_EVENT = "tomverse:guest-quick-start";

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

  return (
    <>
      {children}
      {analyticsEnabled && analyticsClientReady && measurementId ? (
        <Script
          id="tomverse-ga4"
          src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
          strategy="afterInteractive"
          nonce={nonce || undefined}
        />
      ) : null}
      {!disabled &&
      resolvedPolicy &&
      consentPromptReady &&
      (consent === "unset" || showPreferences) ? (
        <aside
          role="dialog"
          aria-label={promptCopy.title}
          className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-1/2 z-[100] w-[min(46rem,calc(100vw-1rem))] -translate-x-1/2 rounded-xl border border-zinc-700 bg-zinc-950/95 p-2 text-zinc-100 shadow-2xl shadow-black/40 backdrop-blur sm:p-3"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <p className="text-[10px] leading-4 text-zinc-300 sm:hidden">
                {promptCopy.mobileBody}{" "}
                <Link href="/privacy" className="font-bold text-blue-300 hover:text-blue-200">
                  {copy.privacy}
                </Link>
              </p>
              <div className="hidden sm:block">
                <p className="text-xs font-black">{promptCopy.title}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{promptCopy.body}</p>
                <Link href="/privacy" className="mt-0.5 inline-flex text-[11px] font-bold text-blue-300 hover:text-blue-200">
                  {copy.privacy}
                </Link>
              </div>
            </div>
            <div className="flex shrink-0 gap-1 sm:gap-2">
              <button
                type="button"
                onClick={decline}
                className="h-8 rounded-lg border border-zinc-600 bg-zinc-900 px-2 text-[10px] font-black text-white hover:bg-zinc-800 sm:px-3 sm:text-[11px]"
              >
                {promptCopy.decline}
              </button>
              <button
                type="button"
                onClick={accept}
                className="h-8 rounded-lg border border-zinc-600 bg-zinc-900 px-2 text-[10px] font-black text-white hover:bg-zinc-800 sm:px-3 sm:text-[11px]"
              >
                {promptCopy.accept}
              </button>
            </div>
          </div>
        </aside>
      ) : null}
      {!disabled &&
      consentPromptReady &&
      !showPreferences &&
      !isMobileChatTextEntryActive &&
      (consent === "accepted" || consent === "declined") ? (
        <button
          type="button"
          data-testid="analytics-settings-button"
          onClick={() => setShowPreferences(true)}
          className="fixed bottom-2 right-2 z-[60] rounded-full border border-zinc-700 bg-zinc-950/90 px-2.5 py-1 text-[10px] font-bold text-zinc-400 shadow-lg backdrop-blur hover:text-zinc-100"
        >
          {copy.settings}
        </button>
      ) : null}
    </>
  );
}
