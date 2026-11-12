import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodingCatalogList, CodingModelDetail, CodingModelForm } from "@/components/admin/modelCatalog/CodingCatalogViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { codingCatalogItems } from "@/lib/adminModelCatalogFlow";

const en = adminMessagesFor(adminModelCatalogMessages, "en");
const ko = adminMessagesFor(adminModelCatalogMessages, "ko");
const noop = () => {};

const PRICING = "https://www.anthropic.com/pricing";
const TERMS = "https://www.anthropic.com/legal/commercial-terms";
const RETENTION = "https://docs.anthropic.com/en/docs/data-retention";

const profile = {
  name: "Claude Sonnet 5.5",
  provider: "anthropic",
  apiModelId: "claude-sonnet-5-5",
  minimumPlan: "Pro" as const,
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, creditWeight: 12, verifiedAt: "2026-11-12", sources: [PRICING, TERMS, RETENTION] },
  terms: { allowsResaleAndCodingAgent: true, url: TERMS, checkedAt: "2026-11-12" },
  retention: { url: RETENTION, checkedAt: "2026-11-12" },
  processingRegion: "us",
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

test("the coding list puts waiting models first with one next step each, in words, and no JSON", () => {
  const html = renderToStaticMarkup(<CodingCatalogList m={en} items={items} onOpen={noop} onAction={noop} onHold={noop} />);
  assert.equal(html.match(/data-testid="model-catalog-pending-coding"/g)?.length, 2);
  assert.match(html, /data-stage="profile_invalid"/);
  assert.match(html, /data-stage="draft_ready"/);
  assert.match(html, />Check profile</);
  assert.match(html, />Make a new draft</);
  assert.match(html, /The saved profile is not valid/);
  assert.match(html, />Profile draft</);
  assert.doesNotMatch(html, /invalid_profile<|no_profile|JSON|<textarea/);
  assert.match(html, /GPT 6 Coder/);
  assert.match(html, />1 serving</);
});

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
  assert.match(clean, /anthropic\.com\/legal\/commercial-terms/);
  assert.match(clean, /docs\.anthropic\.com\/en\/docs\/data-retention/);
  assert.match(clean, />Allows resale and coding agents</);
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

test("a coding draft the judge refuses for its evidence offers only a new draft, in words", () => {
  const refused = { ...sonnet, draftReview: { floor: 9, reasons: ["terms_do_not_allow", "retention_source_unofficial"] } };
  const html = renderToStaticMarkup(
    <CodingModelDetail m={ko} item={refused} edits={{}} drafting={null} onBack={noop} onEdit={noop} onResetEdits={noop} onApply={noop} onAction={noop} onHold={noop} />
  );
  assert.match(html, /약관에 재판매·코딩 에이전트 사용 허용이 확인되지 않습니다/);
  assert.match(html, /데이터 보존 문서가 공급자 공식 문서가 아닙니다/);
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

test("the add form asks for provider, API id and the price, terms and retention pages", () => {
  const html = renderToStaticMarkup(
    <CodingModelForm
      m={ko}
      value={{ modelId: null, provider: "openai", apiModelId: "gpt-6-coder", priceUrl: "", termsUrl: "", retentionUrl: "" }}
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
  assert.match(html, /data-testid="model-catalog-coding-termsUrl"/);
  assert.match(html, /data-testid="model-catalog-coding-retentionUrl"/);
  assert.match(html, /허용 도메인: openai\.com, developers\.openai\.com/);
  assert.doesNotMatch(html, /readOnly|readonly=""/);
});

test("a new draft for an existing model names that model's catalog id and keeps its API id fixed", () => {
  // The catalog id and the API id can differ; the draft must land on this row (review 2026-11-12).
  const html = renderToStaticMarkup(
    <CodingModelForm
      m={en}
      value={{ modelId: "gpt-draft-test", provider: "openai", apiModelId: "gpt-catalog-test", priceUrl: "", termsUrl: "", retentionUrl: "" }}
      onChange={noop}
      providers={[{ provider: "openai", defaultSources: [], hosts: [] }]}
    />
  );
  assert.match(html, /data-testid="model-catalog-coding-apiModelId"[^>]*readOnly=""|readOnly=""[^>]*data-testid="model-catalog-coding-apiModelId"/);
  assert.match(html, /The new draft is for gpt-draft-test\./);
});
