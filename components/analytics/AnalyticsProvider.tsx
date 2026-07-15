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
  },
  ko: {
    title: "개인정보를 보호하는 제품 분석",
    body: "동의하면 Tomverse가 제품 사용과 캠페인 유입을 측정합니다. 프롬프트, 응답, 파일명 및 파일 내용은 절대 포함하지 않습니다.",
    mobileBody: "Tomverse 개선에 동의하시겠어요? 질문과 파일 내용은 수집하지 않습니다.",
    accept: "분석 허용",
    decline: "거부",
    privacy: "개인정보 처리방침",
    settings: "분석 설정",
  },
  zh: {
    title: "保护隐私的产品分析",
    body: "经您同意，Tomverse 会衡量产品使用和活动归因。绝不会收集提示词、回复、文件名或文件内容。",
    mobileBody: "帮助改进 Tomverse。绝不收集提示词和文件内容。",
    accept: "允许分析",
    decline: "拒绝",
    privacy: "隐私政策",
    settings: "分析设置",
  },
  fr: {
    title: "Analyse produit respectueuse de la vie privée",
    body: "Avec votre accord, Tomverse mesure l’usage du produit et l’attribution des campagnes. Les prompts, réponses, noms et contenus de fichiers ne sont jamais inclus.",
    mobileBody: "Aidez à améliorer Tomverse. Prompts et fichiers ne sont jamais collectés.",
    accept: "Autoriser",
    decline: "Refuser",
    privacy: "Confidentialité",
    settings: "Paramètres d’analyse",
  },
  de: {
    title: "Datenschutzfreundliche Produktanalyse",
    body: "Mit Ihrer Zustimmung misst Tomverse Produktnutzung und Kampagnenzuordnung. Prompts, Antworten, Dateinamen und Dateiinhalte werden niemals erfasst.",
    mobileBody: "Tomverse verbessern. Prompts und Dateiinhalte werden nie erfasst.",
    accept: "Analyse erlauben",
    decline: "Ablehnen",
    privacy: "Datenschutz",
    settings: "Analyse-Einstellungen",
  },
  es: {
    title: "Analítica de producto con privacidad",
    body: "Con tu permiso, Tomverse mide el uso del producto y la atribución de campañas. Nunca se incluyen prompts, respuestas, nombres ni contenidos de archivos.",
    mobileBody: "Ayuda a mejorar Tomverse. Nunca recogemos prompts ni archivos.",
    accept: "Permitir analítica",
    decline: "Rechazar",
    privacy: "Privacidad",
    settings: "Ajustes de analítica",
  },
  pt: {
    title: "Análise de produto com privacidade",
    body: "Com a sua permissão, o Tomverse mede a utilização do produto e a atribuição de campanhas. Prompts, respostas, nomes e conteúdos de ficheiros nunca são incluídos.",
    mobileBody: "Ajude a melhorar o Tomverse. Nunca recolhemos prompts nem ficheiros.",
    accept: "Permitir análise",
    decline: "Recusar",
    privacy: "Privacidade",
    settings: "Definições de análise",
  },
};

export function AnalyticsProvider({
  children,
  country,
  initialPlan,
  measurementId,
  nonce,
  userCreatedAt,
  disabled = false,
}: {
  children: React.ReactNode;
  country: string;
  initialPlan: "Guest" | "Free" | "Pro" | "Max";
  measurementId: string | null;
  nonce: string | null;
  userCreatedAt: string | null;
  disabled?: boolean;
}) {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const [consent, setConsent] = useState<ConsentState>("loading");
  const [showPreferences, setShowPreferences] = useState(false);
  const [chatConsentReady, setChatConsentReady] = useState(false);
  const lifecycleCheckedRef = useRef(false);
  const copy = consentCopy[lang];

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
    if (disabled || consent !== "accepted") return;
    const runtime = configureAnalyticsClient({
      country,
      language: lang,
      measurementId,
      plan: initialPlan,
    });
    if (lifecycleCheckedRef.current) return;
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
  }, [consent, country, disabled, initialPlan, lang, measurementId, userCreatedAt]);

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

  return (
    <>
      {children}
      {consent === "accepted" && measurementId ? (
        <Script
          id="tomverse-ga4"
          src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
          strategy="afterInteractive"
          nonce={nonce || undefined}
        />
      ) : null}
      {!disabled && consentPromptReady && (consent === "unset" || showPreferences) ? (
        <aside
          role="dialog"
          aria-label={copy.title}
          className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-1/2 z-[100] w-[min(46rem,calc(100vw-1rem))] -translate-x-1/2 rounded-xl border border-zinc-700 bg-zinc-950/95 p-2 text-zinc-100 shadow-2xl shadow-black/40 backdrop-blur sm:p-3"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <p className="text-[10px] leading-4 text-zinc-300 sm:hidden">
                {copy.mobileBody}{" "}
                <Link href="/privacy" className="font-bold text-blue-300 hover:text-blue-200">
                  {copy.privacy}
                </Link>
              </p>
              <div className="hidden sm:block">
                <p className="text-xs font-black">{copy.title}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{copy.body}</p>
                <Link href="/privacy" className="mt-0.5 inline-flex text-[11px] font-bold text-blue-300 hover:text-blue-200">
                  {copy.privacy}
                </Link>
              </div>
            </div>
            <div className="flex shrink-0 gap-1 sm:gap-2">
              <button
                type="button"
                onClick={decline}
                className="h-8 rounded-lg border border-zinc-700 px-2 text-[10px] font-black text-zinc-300 hover:bg-zinc-900 sm:px-3 sm:text-[11px]"
              >
                {copy.decline}
              </button>
              <button
                type="button"
                onClick={accept}
                className="h-8 rounded-lg bg-blue-600 px-2 text-[10px] font-black text-white hover:bg-blue-500 sm:px-3 sm:text-[11px]"
              >
                {copy.accept}
              </button>
            </div>
          </div>
        </aside>
      ) : null}
      {!disabled &&
      consentPromptReady &&
      !showPreferences &&
      (consent === "accepted" || consent === "declined") ? (
        <button
          type="button"
          onClick={() => setShowPreferences(true)}
          className="fixed bottom-2 right-2 z-[60] rounded-full border border-zinc-700 bg-zinc-950/90 px-2.5 py-1 text-[10px] font-bold text-zinc-400 shadow-lg backdrop-blur hover:text-zinc-100"
        >
          {copy.settings}
        </button>
      ) : null}
    </>
  );
}
