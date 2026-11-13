import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ImageCatalogList, ImageModelDetail, ImageModelForm } from "@/components/admin/modelCatalog/ImageCatalogViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { imageCatalogItems } from "@/lib/adminModelCatalogFlow";

const en = adminMessagesFor(adminModelCatalogMessages, "en");
const ko = adminMessagesFor(adminModelCatalogMessages, "ko");
const noop = () => {};

const draft = {
  pricingVersion: "qwen-image-2.0-2026-11-12-llm",
  prices: [
    { quality: "low", size: "1024x1024", credits: 24, outputCostMicroUsd: 20_000 },
    { quality: "medium", size: "1024x1024", credits: 41, outputCostMicroUsd: 35_000 },
  ],
  verification: { verifiedAt: "2026-11-12", sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"], thinkingCapMicroUsd: 0 },
};
const floors = [
  { quality: "low", size: "1024x1024", floor: 24 },
  { quality: "medium", size: "1024x1024", floor: 41 },
];

const items = imageCatalogItems({
  models: [
    {
      id: "gpt-image-2",
      name: "GPT Image 2",
      provider: "openai",
      apiModelId: "gpt-image-2",
      source: "code",
      enabled: null,
      holdReason: null,
      disabledReason: null,
      pricingVersion: "gpt-image-2-v3",
      prices: [{ quality: "low", size: "1024x1024", credits: 6, outputCostMicroUsd: 5_000 }],
      floors: [{ quality: "low", size: "1024x1024", floor: 6 }],
      priceVerification: { verifiedAt: "2026-11-03", sources: ["https://developers.openai.com/api/docs/pricing"], thinkingCapMicroUsd: 0 },
      admissionIfEnabled: { admitted: true },
      draft: null,
    },
  ],
  pending: [
    { modelId: "gemini-nano-banana-2.1", profile: { provider: "google" }, draft: null, problem: "invalid_full_profile" },
    {
      modelId: "qwen-image-2.0",
      profile: { provider: "qwen", apiModelId: "qwen-image-2.0", name: "Qwen Image 2.0" },
      draft,
      draftReview: { floors, reasons: [] },
      problem: "no_price_revision",
    },
  ],
});
const qwen = items.find((item) => item.id === "qwen-image-2.0")!;

test("the list puts the models waiting for the operator first, each with one next action and no internal code", () => {
  const html = renderToStaticMarkup(
    <ImageCatalogList m={en} items={items} onOpen={noop} onAction={noop} onHold={noop} onInherit={noop} />
  );
  assert.equal(html.match(/data-testid="model-catalog-pending-image"/g)?.length, 2);
  assert.match(html, /data-stage="profile_invalid"/);
  assert.match(html, /data-stage="draft_ready"/);
  assert.match(html, />Fix model details</);
  assert.match(html, />Check prices</);
  assert.match(html, /The model details are not valid/);
  assert.doesNotMatch(html, /invalid_full_profile|no_price_revision/);
  assert.match(html, /GPT Image 2/);
  assert.match(html, /1 option · 6 credits/);
  assert.match(html, />1 serving</);
});

test("the price check shows each option's cost and floor, and an edit below the floor locks the apply button", () => {
  const clean = renderToStaticMarkup(
    <ImageModelDetail m={en} item={qwen} edits={{ "medium|1024x1024": "45" }} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} onRename={async () => true} />
  );
  assert.match(clean, /\$0\.035/);
  assert.match(clean, />Draft 41</);
  assert.match(clean, />Floor \+4</);
  assert.match(clean, /alibabacloud\.com\/help\/en\/model-studio\/model-pricing/);
  assert.match(clean, /LLM draft · 1 cell changed by you/);
  const applyButton = (html: string) => html.match(/<button[^>]*data-testid="model-catalog-apply"[^>]*>/)?.[0] ?? "";
  assert.ok(applyButton(clean));
  assert.doesNotMatch(applyButton(clean), / disabled=""/);

  const below = renderToStaticMarkup(
    <ImageModelDetail m={en} item={qwen} edits={{ "medium|1024x1024": "40" }} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} onRename={async () => true} />
  );
  assert.match(below, />Below 41</);
  assert.match(applyButton(below), / disabled=""/);
  assert.match(below, /Fix 1 cell to apply\./);
  // A cell under its floor means the check would not pass, so it is not promised.
  assert.match(clean, /Expected check: passes/);
  assert.doesNotMatch(below, /Expected check: passes/);
});

test("a draft the judge refuses for another reason offers only a new draft, in words", () => {
  const refused = { ...qwen, draftReview: { floors, reasons: ["worst_case_cost_unbounded"] } };
  const html = renderToStaticMarkup(
    <ImageModelDetail m={en} item={refused} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} onRename={async () => true} />
  );
  assert.match(html, /No reasoning cost cap is stated/);
  assert.match(html, />Make a new draft</);
  assert.doesNotMatch(html, /data-testid="model-catalog-apply"/);
});

test("while drafting, the detail shows the elapsed time instead of the table", () => {
  const html = renderToStaticMarkup(
    <ImageModelDetail m={ko} item={qwen} edits={{}} drafting="0:42" onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} onRename={async () => true} />
  );
  assert.match(html, /0:42 경과 · 최대 2:00/);
  assert.doesNotMatch(html, /data-testid="model-catalog-price-table"/);
});

test("the add form asks for provider, API id, name, sizes and qualities, and names the default pricing page", () => {
  const html = renderToStaticMarkup(
    <ImageModelForm
      m={ko}
      mode="add"
      value={{ provider: "qwen", apiModelId: "qwen-image-2.0", name: "Qwen Image 2.0", sizes: ["1024x1024"], qualities: ["low", "high"], sources: "" }}
      onChange={noop}
      providers={[
        { provider: "openai", defaultSources: [], hosts: [] },
        { provider: "qwen", defaultSources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"], hosts: ["www.alibabacloud.com", "help.aliyun.com"] },
      ]}
      sizes={["1024x1024", "1536x1024", "1024x1536"]}
      qualities={["low", "medium", "high"]}
    />
  );
  assert.doesNotMatch(html, /JSON/);
  assert.match(html, /aria-pressed="true"[^>]*>qwen</);
  assert.match(html, /aria-pressed="false"[^>]*>가로 1536×1024</);
  assert.match(html, /기본: https:\/\/www\.alibabacloud\.com/);
  assert.match(html, /허용 도메인: www\.alibabacloud\.com, help\.aliyun\.com/);
});

test("a serving model with a new draft can still be held from its card and its detail", () => {
  const [repriced] = imageCatalogItems({
    models: [
      {
        id: "gpt-image-2",
        name: "GPT Image 2",
        provider: "openai",
        apiModelId: "gpt-image-2",
        source: "code",
        enabled: null,
        holdReason: null,
        disabledReason: null,
        pricingVersion: "gpt-image-2-v3",
        prices: [{ quality: "low", size: "1024x1024", credits: 6, outputCostMicroUsd: 5_000 }],
        floors: [{ quality: "low", size: "1024x1024", floor: 6 }],
        priceVerification: { verifiedAt: "2026-11-03", sources: ["https://developers.openai.com/api/docs/pricing"], thinkingCapMicroUsd: 0 },
        admissionIfEnabled: { admitted: true },
        draft,
        draftReview: { floors, reasons: ["worst_case_cost_unbounded"] },
      },
    ],
  });
  const list = renderToStaticMarkup(
    <ImageCatalogList m={en} items={[repriced]} onOpen={noop} onAction={noop} onHold={noop} onInherit={noop} />
  );
  assert.match(list, /data-stage="draft_ready"/);
  assert.match(list, /data-testid="model-catalog-hold"/);
  assert.match(list, />Serving</);
  const detail = renderToStaticMarkup(
    <ImageModelDetail m={en} item={repriced} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} onRename={async () => true} />
  );
  // Even when the judge refuses the draft, the live model can be stopped.
  assert.match(detail, /data-testid="model-catalog-hold"/);
  assert.match(detail, />Make a new draft</);
});
