import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ModelCatalogProvider } from "@/components/ModelCatalogProvider";
import { ModelsPageContent, modelsPageCopy } from "@/components/marketing/ModelsPageContent";
import { AVAILABLE_MODELS } from "@/lib/models";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

const ssrRouter: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "models-access-tier-ssr-fixture",
};

const guestModel = AVAILABLE_MODELS.find((model) => model.minimumPlan === "Guest")!;
const freeModel = AVAILABLE_MODELS.find((model) => model.minimumPlan === "Free")!;
const fixtureModels = [
  { ...guestModel, id: "models-test-guest", name: "Guest model", publiclyListed: true },
  { ...freeModel, id: "models-test-free", name: "Free model", publiclyListed: true },
];

const render = (language: (typeof SUPPORTED_LANGUAGES)[number]) => renderToStaticMarkup(
  <AppRouterContext.Provider value={ssrRouter}>
    <PathnameContext.Provider value={language === "en" ? "/models" : `/${language}/models`}>
      <SessionProvider session={null}>
        <LanguageProvider initialLang={language}>
          <ModelCatalogProvider initialModels={fixtureModels}>
            <ModelsPageContent />
          </ModelCatalogProvider>
        </LanguageProvider>
      </SessionProvider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>
);

test("Models access-tier copy renders for Guest and Free models in every locale", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const html = render(language);
    const content = modelsPageCopy[language];

    for (const key of ["planExplanation", "planHintGuest", "planHintFree"] as const) {
      assert.ok(html.includes(content[key]), `${language}: ${key} is rendered`);
    }
    assert.ok(html.includes('data-model-id="models-test-guest"'), `${language}: Guest model is rendered`);
    assert.ok(html.includes('data-model-id="models-test-free"'), `${language}: Free model is rendered`);
  }
});
