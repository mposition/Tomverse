import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodingModelDetail, CodingModelForm } from "@/components/admin/modelCatalog/CodingCatalogViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { codingCatalogItems } from "@/lib/adminModelCatalogFlow";

const en = adminMessagesFor(adminModelCatalogMessages, "en");
const ko = adminMessagesFor(adminModelCatalogMessages, "ko");
const noop = () => {};

const PRICING = "https://www.anthropic.com/pricing";

const profile = {
  name: "Claude Sonnet 5.5",
  provider: "anthropic",
  apiModelId: "claude-sonnet-5-5",
  minimumPlan: "Pro" as const,
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, creditWeight: 12, verifiedAt: "2026-11-12", sources: [PRICING] },
};

const items = codingCatalogItems({
  models: [
    { modelId: "broken-coder", enabled: null, holdReason: null, profile: { name: 1 }, problem: "invalid_profile", admission: null, draft: null },
    {
      modelId: "claude-sonnet-5-5",
      enabled: null,
      holdReason: null,
      profile: null,
      problem: "no_profile",
      admission: null,
      draft: profile,
      draftReview: { floor: 9, reasons: [] },
    },
    {
      modelId: "gpt-6-coder",
      enabled: true,
      holdReason: null,
      profile: { ...profile, name: "GPT 6 Coder", provider: "openai", apiModelId: "gpt-6-coder" },
      problem: null,
      admission: { admitted: true },
      draft: null,
      floor: 10,
    },
  ],
});
const sonnet = items.find((item) => item.id === "claude-sonnet-5-5")!;

test("the profile check shows prices and evidence read-only and the operator's three fields editable", () => {
  const applyButton = (html: string) => html.match(/<button[^>]*data-testid="model-catalog-coding-apply"[^>]*>/)?.[0] ?? "";
  const clean = renderToStaticMarkup(
    <CodingModelDetail m={en} item={sonnet} edits={{ creditWeight: "15" }} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(clean, /data-testid="model-catalog-coding-name"/);
  assert.match(clean, /data-testid="model-catalog-coding-weight"[^>]*value="15"/);
  assert.match(clean, /aria-pressed="true"[^>]*>Pro</);
  assert.match(clean, />Draft 12</);
  assert.match(clean, />Minimum 9</);
  assert.match(clean, />Floor \+6</);
  // Prices and evidence are text, not inputs.
  assert.match(clean, />\$3</);
  assert.match(clean, />\$15</);
  assert.match(clean, />200,000</);
  assert.match(clean, /anthropic\.com\/pricing/);
  // Provider conditions are not shown or judged (owner decision 2026-11-21).
  assert.doesNotMatch(clean, /resale|Terms|retention|Processing region/i);
  assert.match(clean, /LLM draft · 1 field changed by you/);
  assert.match(clean, /Expected check: passes/);
  assert.ok(applyButton(clean));
  assert.doesNotMatch(applyButton(clean), / disabled=""/);
  // The raw row is kept, read-only, under the technical details.
  assert.match(clean, /profile · draft/);

  const below = renderToStaticMarkup(
    <CodingModelDetail m={en} item={sonnet} edits={{ creditWeight: "8" }} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(below, />Below 9</);
  assert.match(applyButton(below), / disabled=""/);
  assert.match(below, /Fix the marked fields to apply\./);
  assert.doesNotMatch(below, /Expected check: passes/);
});

test("a draft whose pages state no output limit says it uses the 8,192 default, and a tiered price lists its tiers", () => {
  // Qwen3 Coder Flash (owner decisions 2026-11-22): no output limit on the pages, priced by input-size tier.
  const flash = {
    ...profile,
    name: "Qwen3 Coder Flash",
    provider: "qwen",
    apiModelId: "qwen3-coder-flash",
    capabilities: { toolCalling: "parallel", structuredOutput: "supported", imageInput: false, maxContextTokens: 1_000_000, maxOutputTokens: 8_192 },
    pricing: { ...profile.pricing, inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6, sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"] },
    basis: {
      maxOutputTokens: "default" as const,
      priceTiers: [
        { upToInputTokens: 32_000, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5 },
        { upToInputTokens: 128_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
        { upToInputTokens: 256_000, inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 },
        { upToInputTokens: null, inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6 },
      ],
    },
  };
  const [item] = codingCatalogItems({
    models: [{ modelId: "qwen3-coder-flash", enabled: null, holdReason: null, profile: null, problem: "no_profile", admission: null, draft: flash, draftReview: { floor: 9, reasons: [] } }],
  });
  const html = renderToStaticMarkup(
    <CodingModelDetail m={ko} item={item} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(html, />8,192</);
  assert.match(html, /data-testid="model-catalog-coding-max-output-default"[^>]*>문서에 없어 기본값 8,192 사용</);
  assert.match(html, />\$1\.6</);
  assert.match(html, />\$9\.6</);
  assert.match(html, /data-testid="model-catalog-coding-price-dearest"[^>]*>입력 크기별 구간 가격: 가장 비싼 구간 단가를 씁니다</);
  const tiers = html.match(/<ul[^>]*data-testid="model-catalog-coding-price-tiers"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? "";
  assert.deepEqual(
    [...tiers.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]),
    ["32,000까지 · $0.3 / $1.5", "128,000까지 · $0.5 / $2.5", "256,000까지 · $0.8 / $4", "256,000 초과 · $1.6 / $9.6"]
  );
  assert.match(html, />지원</);

  // A stated limit and one flat price: no default note, no tier list.
  const plain = renderToStaticMarkup(
    <CodingModelDetail m={ko} item={sonnet} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.doesNotMatch(plain, /model-catalog-coding-max-output-default|model-catalog-coding-price-tiers|model-catalog-coding-price-dearest/);
  // A draft stored with a finer structured output value reads as supported.
  assert.match(plain, />지원</);
  assert.doesNotMatch(plain, /도구 호출 강제|forced_tool_use<\/dd/);
});

test("a coding draft the judge refuses for its evidence offers only a new draft, in words", () => {
  const refused = { ...sonnet, draftReview: { floor: 9, reasons: ["unofficial_price_source:https://blog.example.com/x", "provider_destination_unproven"] } };
  const html = renderToStaticMarkup(
    <CodingModelDetail m={ko} item={refused} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(html, /공식 문서가 아닌 출처가 있습니다: blog\.example\.com/);
  assert.match(html, /이 공급자는 아직 확인된 데이터 전송처가 아닙니다/);
  assert.match(html, />새 초안 만들기</);
  assert.doesNotMatch(html, /data-testid="model-catalog-coding-apply"/);
});

test("a serving coding model shows its current profile read-only and can be held", () => {
  const serving = items.find((item) => item.id === "gpt-6-coder")!;
  const html = renderToStaticMarkup(
    <CodingModelDetail m={en} item={serving} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(html, /data-stage="serving"/);
  assert.match(html, />Current profile</);
  assert.match(html, /data-testid="model-catalog-coding-hold"/);
  assert.doesNotMatch(html, /<input/);
});

test("the add form asks for provider, API id and the price page only", () => {
  const html = renderToStaticMarkup(
    <CodingModelForm
      m={ko}
      value={{ modelId: null, provider: "openai", apiModelId: "gpt-6-coder", priceUrl: "" }}
      onChange={noop}
      providers={[
        { provider: "anthropic", defaultSources: [], hosts: ["www.anthropic.com"] },
        { provider: "openai", defaultSources: ["https://developers.openai.com/api/docs/pricing"], hosts: ["openai.com", "developers.openai.com"] },
      ]}
    />
  );
  assert.doesNotMatch(html, /JSON|<textarea/);
  assert.match(html, /aria-pressed="true"[^>]*>openai</);
  assert.match(html, /비워 두면 https:\/\/developers\.openai\.com\/api\/docs\/pricing을\(를\) 읽습니다/);
  assert.match(html, /data-testid="model-catalog-coding-priceUrl"/);
  assert.doesNotMatch(html, /model-catalog-coding-termsUrl|model-catalog-coding-retentionUrl/);
  assert.doesNotMatch(html, /약관|보존/);
  assert.match(html, /허용 도메인: openai\.com, developers\.openai\.com/);
  assert.doesNotMatch(html, /readOnly|readonly=""/);
});

test("a new draft for an existing model names that model's catalog id and keeps its API id fixed", () => {
  // The catalog id and the API id can differ; the draft must land on this row (review 2026-11-12).
  const html = renderToStaticMarkup(
    <CodingModelForm
      m={en}
      value={{ modelId: "gpt-draft-test", provider: "openai", apiModelId: "gpt-catalog-test", priceUrl: "" }}
      onChange={noop}
      providers={[{ provider: "openai", defaultSources: [], hosts: [] }]}
    />
  );
  assert.match(html, /data-testid="model-catalog-coding-apiModelId"[^>]*readOnly=""|readOnly=""[^>]*data-testid="model-catalog-coding-apiModelId"/);
  assert.match(html, /The new draft is for gpt-draft-test\./);
});
