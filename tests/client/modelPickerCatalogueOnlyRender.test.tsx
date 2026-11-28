import assert from "node:assert/strict";
import test from "node:test";
import { createRef, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/components/LanguageProvider";
import { ModelCatalogue } from "@/components/chat/ModelCatalogue";
import { ModelPickerPanel } from "@/components/chat/ModelPickerPanel";
import { EMPTY_MODEL_CATALOGUE_FILTERS } from "@/lib/modelCatalogueFilters";
import type { AiModel } from "@/lib/models";
import { modelPickerStepCopy } from "@/lib/modelPickerPresentation";
import { en } from "@/locales/en";

/**
 * Code lists the coding catalogue in the Chat model picker. That catalogue has
 * no Chat use cases, so the picker opens on the full list and drops the two
 * Chat-only lines: the use-case filter and "Chat uses one answer model".
 */
const coder: AiModel = {
  id: "catalogue-coder", name: "Catalogue Coder", apiModel: "catalogue-coder", provider: "openai", icon: "", bestFor: "200K context window",
  minimumPlan: "Guest", usageClass: "standard", creditWeight: 3, enabled: true, status: "enabled",
};
const noop = () => {};

function panel(props: Partial<ComponentProps<typeof ModelPickerPanel>>) {
  return renderToStaticMarkup(<LanguageProvider initialLang="en" forceInitialLang>
    <ModelPickerPanel models={[coder]} singleModelSelection selectedModelIds={[coder.id]} maxSelectableModels={1} currentPlan="Max"
      isGuestMode={false} isMobileShell={false} isCompactLayout={false} isKeyboardCompact={false} modelStatuses={{}}
      hasImageAttachments={false} favoriteModelIds={[]} recentModelIds={[]} personalizedModelIds={[]} activeSelectedCount={1}
      selectedBaseCredits={3} searchInputRef={createRef()} escapeHandlerRef={{ current: null }} onToggleModel={() => true}
      onRequestSwap={noop} onToggleFavorite={noop} onRememberRecentModel={noop} onBackToActions={noop} onDone={noop} onTrackEvent={noop}
      {...props} />
  </LanguageProvider>);
}

test("a catalogue-only picker opens on the full list and says nothing Chat-specific", () => {
  const code = panel({ catalogueOnly: true });
  assert.match(code, new RegExp(`data-testid="model-picker-title"[^>]*>${modelPickerStepCopy.en.allModelsTitle}<`));
  assert.doesNotMatch(code, /data-testid="model-recommendations/);
  assert.doesNotMatch(code, /data-testid="model-picker-open-all"/);
  assert.ok(!code.includes(en.chat.singleModelRequired));
  // Back leaves the picker: there is no recommended screen to step back to.
  assert.ok(!code.includes(`aria-label="${modelPickerStepCopy.en.backToRecommended}"`));
});

test("the Chat picker still opens on its recommendations", () => {
  const chat = panel({});
  assert.match(chat, new RegExp(`data-testid="model-picker-title"[^>]*>${modelPickerStepCopy.en.recommendedTitle}<`));
  assert.match(chat, /data-testid="model-picker-open-all"/);
  assert.ok(chat.includes(en.chat.singleModelRequired));
});

function catalogue(hideTaskFilter: boolean, creditFreeModelIds?: string[]) {
  return renderToStaticMarkup(<LanguageProvider initialLang="en" forceInitialLang><ModelCatalogue models={[coder]} lang="en" t={(key) => key} searchQuery="" filters={EMPTY_MODEL_CATALOGUE_FILTERS}
    onFiltersChange={noop} isFilterSheetOpen={false} onFilterSheetOpenChange={noop} selectedModelIds={[coder.id]} currentPlan="Max"
    isGuestMode={false} isMobileShell={false} hideTaskFilter={hideTaskFilter} creditFreeModelIds={creditFreeModelIds} modelStatuses={{}} hasImageAttachments={false}
    favoriteModelIds={[]} recentModelIds={[]} onToggleFavorite={noop} onSelectModel={noop} /></LanguageProvider>);
}

test("the coding catalogue is listed without the Chat use-case filter", () => {
  assert.doesNotMatch(catalogue(true), /data-testid="model-task-filter"/);
  assert.match(catalogue(true), /data-model-id="catalogue-coder"/);
  assert.match(catalogue(true), /data-testid="model-filter-sheet-trigger"/);
  assert.match(catalogue(false), /data-testid="model-task-filter"/);
});

test("a credit-free model (a provider CLI on the person's subscription) shows no usage meter or credit estimate", () => {
  assert.match(catalogue(true), /data-testid="model-credit-badge"/);
  assert.doesNotMatch(catalogue(true, [coder.id]), /data-testid="model-credit-badge"/);
  assert.match(catalogue(true, [coder.id]), /data-model-id="catalogue-coder"/);
  assert.match(panel({ catalogueOnly: true }), /Base estimate/);
  const free = panel({ catalogueOnly: true, creditFreeModelIds: [coder.id] });
  assert.doesNotMatch(free, /Base estimate/);
  assert.match(free, /data-testid="model-selection-summary"/);
});
