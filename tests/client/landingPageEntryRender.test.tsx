import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { LanguageProvider } from "@/components/LanguageProvider";
import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { chatProductUiCopy } from "@/lib/chatProductUiCopy";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/language";

const guestCopyBoundaries: Record<Language, readonly RegExp[]> = {
  en: [/when.*available/i, /text questions/i, /existing guest limit/i, /browser/i, /attachments.*manual/i],
  ko: [/제공되는 경우/, /텍스트 질문/, /기존 Guest 한도/, /브라우저/, /첨부.*수동/],
  zh: [/可用时/, /文字问题/, /现有访客限额/, /浏览器/, /附件.*手动/],
  fr: [/disponible/i, /questions textuelles/i, /limite d’invité actuelle/i, /navigateur/i, /pièces jointes.*manuelle/i],
  de: [/verfügbar/i, /Textfragen/i, /bestehenden Gastlimits/i, /Browser/i, /Anhänge.*manuelle/i],
  es: [/disponible/i, /preguntas de texto/i, /límite de invitado actual/i, /navegador/i, /adjuntos.*manual/i],
  pt: [/disponível/i, /perguntas de texto/i, /limite de visitante atual/i, /navegador/i, /anexos.*manual/i],
};

// Mount the real client page with the same routing contexts its language
// switcher reads during Next prerendering; no navigation occurs in SSR.
const ssrRouter: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "landing-ssr-fixture",
};

const render = (language: Language, authenticated = false) => renderToStaticMarkup(
  <AppRouterContext.Provider value={ssrRouter}>
    <PathnameContext.Provider value={language === "en" ? "/" : `/${language}`}>
      <SessionProvider session={authenticated
        ? { user: { id: "account-a" }, expires: "2099-01-01T00:00:00.000Z" }
        : null}>
        <LanguageProvider initialLang={language}>
          <LandingPageContent />
        </LanguageProvider>
      </SessionProvider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>
);

test("the Review product page retains direct comparison CTAs in every locale", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const html = render(language);
    for (const testId of ["landing-primary-cta", "landing-final-cta"]) {
      assert.ok(html.includes('href="/review?lang=' + language + '"'), language + ": canonical Review entry");
      assert.ok(html.includes('data-testid="' + testId + '"'), language + ": comparison action");
    }
    assert.doesNotMatch(html, /href="\/chat\?lang=/);
  }
});

test("Guest Chat copy retains the existing allowance and manual attachment boundary", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    for (const boundary of guestCopyBoundaries[language]) {
      assert.match(chatProductUiCopy[language].guestChatDescription, boundary);
    }
  }
});

test("the authenticated Review page stays a comparison entry", () => {
  const html = render("en", true);
  assert.doesNotMatch(html, /data-testid="landing-chat-product-cta"/);
  assert.doesNotMatch(html, /data-testid="landing-hero-signup-note"/);
  assert.match(html, /href="\/review\?lang=en"/);
});
