"use client";

import Script from "next/script";
import Link from "next/link";
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

const consentCopy: Record<
  Language,
  { title: string; body: string; accept: string; decline: string; privacy: string; settings: string }
> = {
  en: {
    title: "Privacy-safe product analytics",
    body: "With your permission, Tomverse measures product usage and campaign attribution. Prompts, responses, filenames, and file contents are never included.",
    accept: "Allow analytics",
    decline: "Decline",
    privacy: "Privacy policy",
    settings: "Analytics settings",
  },
  ko: {
    title: "개인정보를 보호하는 제품 분석",
    body: "동의하면 Tomverse가 제품 사용과 캠페인 유입을 측정합니다. 프롬프트, 응답, 파일명 및 파일 내용은 절대 포함하지 않습니다.",
    accept: "분석 허용",
    decline: "거부",
    privacy: "개인정보 처리방침",
    settings: "분석 설정",
  },
  zh: {
    title: "保护隐私的产品分析",
    body: "经您同意，Tomverse 会衡量产品使用和活动归因。绝不会收集提示词、回复、文件名或文件内容。",
    accept: "允许分析",
    decline: "拒绝",
    privacy: "隐私政策",
    settings: "分析设置",
  },
  fr: {
    title: "Analyse produit respectueuse de la vie privée",
    body: "Avec votre accord, Tomverse mesure l’usage du produit et l’attribution des campagnes. Les prompts, réponses, noms et contenus de fichiers ne sont jamais inclus.",
    accept: "Autoriser",
    decline: "Refuser",
    privacy: "Confidentialité",
    settings: "Paramètres d’analyse",
  },
  de: {
    title: "Datenschutzfreundliche Produktanalyse",
    body: "Mit Ihrer Zustimmung misst Tomverse Produktnutzung und Kampagnenzuordnung. Prompts, Antworten, Dateinamen und Dateiinhalte werden niemals erfasst.",
    accept: "Analyse erlauben",
    decline: "Ablehnen",
    privacy: "Datenschutz",
    settings: "Analyse-Einstellungen",
  },
  es: {
    title: "Analítica de producto con privacidad",
    body: "Con tu permiso, Tomverse mide el uso del producto y la atribución de campañas. Nunca se incluyen prompts, respuestas, nombres ni contenidos de archivos.",
    accept: "Permitir analítica",
    decline: "Rechazar",
    privacy: "Privacidad",
    settings: "Ajustes de analítica",
  },
  pt: {
    title: "Análise de produto com privacidade",
    body: "Com a sua permissão, o Tomverse mede a utilização do produto e a atribuição de campanhas. Prompts, respostas, nomes e conteúdos de ficheiros nunca são incluídos.",
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
  const [consent, setConsent] = useState<ConsentState>("loading");
  const [showPreferences, setShowPreferences] = useState(false);
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
      {!disabled && (consent === "unset" || showPreferences) ? (
        <aside
          role="dialog"
          aria-label={copy.title}
          className="fixed bottom-4 left-1/2 z-[100] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-2xl shadow-black/40"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-black">{copy.title}</p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">{copy.body}</p>
              <Link href="/privacy" className="mt-1 inline-flex text-xs font-bold text-blue-300 hover:text-blue-200">
                {copy.privacy}
              </Link>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={decline}
                className="h-10 rounded-xl border border-zinc-700 px-4 text-xs font-black text-zinc-300 hover:bg-zinc-900"
              >
                {copy.decline}
              </button>
              <button
                type="button"
                onClick={accept}
                className="h-10 rounded-xl bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-500"
              >
                {copy.accept}
              </button>
            </div>
          </div>
        </aside>
      ) : null}
      {!disabled &&
      !showPreferences &&
      (consent === "accepted" || consent === "declined") ? (
        <button
          type="button"
          onClick={() => setShowPreferences(true)}
          className="fixed bottom-3 right-3 z-[60] rounded-full border border-zinc-700 bg-zinc-950/90 px-3 py-1.5 text-[11px] font-bold text-zinc-400 shadow-lg backdrop-blur hover:text-zinc-100"
        >
          {copy.settings}
        </button>
      ) : null}
    </>
  );
}
