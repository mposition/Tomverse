import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ModelCatalogProvider } from "@/components/ModelCatalogProvider";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { AVAILABLE_MODELS } from "@/lib/models";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

// The page imports its stylesheets; the test runner has no bundler, so give the
// CommonJS loader an empty module for `.css` before the page is loaded.
createRequire(import.meta.url).extensions[".css"] = (module: { exports: unknown }) => { module.exports = {}; };
const loadModelsPage = async () => (await import("@/components/marketing/v2/models/ModelsPage")).ModelsPage;

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

const render = (ModelsPage: Awaited<ReturnType<typeof loadModelsPage>>, language: (typeof SUPPORTED_LANGUAGES)[number]) => renderToStaticMarkup(
  <AppRouterContext.Provider value={ssrRouter}>
    <PathnameContext.Provider value={language === "en" ? "/models" : `/${language}/models`}>
      <SessionProvider session={null}>
        <LanguageProvider initialLang={language}>
          <ModelCatalogProvider initialModels={fixtureModels}>
            <ModelsPage />
          </ModelCatalogProvider>
        </LanguageProvider>
      </SessionProvider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>
);

test("Models access-tier copy renders for Guest and Free models in every locale", async () => {
  const ModelsPage = await loadModelsPage();
  for (const language of SUPPORTED_LANGUAGES) {
    const html = render(ModelsPage, language);
    const { list } = modelsPageContent[language];

    // The explanation of every plan, and each model card's own plan chip.
    assert.ok(html.includes(list.planNote.replaceAll("&", "&amp;")), `${language}: plan note is rendered`);
    assert.ok(html.includes(`>${list.plans.Guest}</span>`), `${language}: Guest model chip is rendered`);
    assert.ok(html.includes(`>${list.plans.Free}</span>`), `${language}: Free model chip is rendered`);
    assert.ok(html.includes('data-model-id="models-test-guest"'), `${language}: Guest model is rendered`);
    assert.ok(html.includes('data-model-id="models-test-free"'), `${language}: Free model is rendered`);
    // Only the two catalogue models are listed, and the count says so.
    assert.equal([...html.matchAll(/<article /g)].length, 2, `${language}: lists exactly the catalogue's models`);
    assert.ok(html.includes(list.count.replace("{shown}", "2").replace("{total}", "2")), `${language}: result count`);
  }
});
