import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodingCandidates, CodingLinkDetail } from "@/components/admin/modelCatalog/CodingLinkViews";
import { CodingChannelBanner, CodingModelTable, CodingSummary } from "@/components/admin/modelCatalog/CodingListViews";
import { CodingProviderTable, ProviderTermsDraftPanel } from "@/components/admin/modelCatalog/CodingProviderViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminCodingCatalogMessages } from "@/lib/adminMessages/codingCatalog";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import {
  type CodingProviderRow,
  codingCatalogItems,
  codingSettingsFrom,
  codingSettingsProblems,
  codingSettingsRequest,
  filterCodingItems,
  reasonMessage,
} from "@/lib/adminModelCatalogFlow";
import { reasonText } from "@/components/admin/modelCatalog/ImageCatalogViews";

// The coding catalogue tab (Figma "코딩 카탈로그 시안 v1"): the list, a chat
// link's detail, the candidates and the provider conditions.

const c = adminMessagesFor(adminCodingCatalogMessages, "ko");
const cEn = adminMessagesFor(adminCodingCatalogMessages, "en");
const m = adminMessagesFor(adminModelCatalogMessages, "ko");
const noop = () => {};
const reason = (code: string) => reasonText(m, reasonMessage(code));

const TERMS = "https://www.anthropic.com/legal/commercial-terms";
const RETENTION = "https://docs.anthropic.com/en/docs/data-retention";

const chat = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  apiModelId: "claude-sonnet-4-6",
  minimumPlan: "Pro" as const,
  usageClass: "premium",
  creditWeight: 6,
  enabled: true,
  status: "enabled",
  publiclyListed: true,
  catalogDeleted: false,
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 64_000,
  imageInput: true,
  price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, pricingVersion: "v1", effectiveDate: "2026-08-03", verified: true },
};

const resolved = (overrides: Record<string, unknown> = {}) => ({
  modelId: "claude-sonnet-4-6",
  source: "chat",
  registryModelId: "claude-sonnet-4-6",
  channels: ["code", "api"],
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  apiModelId: "claude-sonnet-4-6",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: true, maxContextTokens: 1_000_000, maxOutputTokens: 64_000 },
  pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, creditWeight: 8, verifiedAt: "2026-08-03", sources: [], pricingVersion: "v1" },
  terms: { allowsResaleAndCodingAgent: true, url: TERMS, checkedAt: "2026-11-10" },
  retention: { url: RETENTION, checkedAt: "2026-11-10" },
  processingRegion: "US",
  ...overrides,
});

const stored = {
  source: "chat",
  registryModelId: "claude-sonnet-4-6",
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use" },
  creditWeight: 8,
  channels: ["code", "api"],
  evidence: {
    sources: ["https://docs.anthropic.com/en/docs/build-with-claude/tool-use"],
    draftedAt: "2026-11-20",
    toolCalling: "parallel",
    structuredOutput: "forced_tool_use",
  },
};

const report = {
  models: [
    {
      modelId: "claude-sonnet-4-6",
      enabled: null,
      holdReason: null,
      source: "chat" as const,
      profile: resolved(),
      stored,
      chat,
      warnings: [],
      activationBlockers: [],
      termsSource: "provider" as const,
      termsCheckedAt: "2026-11-10",
      problem: null,
      admission: { admitted: true },
      draft: null,
      floor: 5,
    },
    {
      modelId: "kimi-k3",
      enabled: null,
      holdReason: null,
      source: "chat" as const,
      profile: resolved({ modelId: "kimi-k3", name: "Kimi K3", provider: "moonshot", apiModelId: "kimi-k3", pricing: { ...resolved().pricing, creditWeight: 1 } }),
      stored: { ...stored, registryModelId: "kimi-k3", creditWeight: undefined },
      chat: { ...chat, id: "kimi-k3", name: "Kimi K3", provider: "moonshot", creditWeight: 1 },
      warnings: [],
      activationBlockers: [],
      termsSource: "provider" as const,
      termsCheckedAt: "2026-10-30",
      problem: null,
      admission: { admitted: false, reasons: ["credits_below_floor:2"] },
      draft: null,
      floor: 2,
    },
    {
      modelId: "devstral-2",
      enabled: false,
      holdReason: null,
      source: "dedicated" as const,
      profile: resolved({ modelId: "devstral-2", source: "dedicated", registryModelId: undefined, channels: ["code"], name: "Devstral 2", provider: "mistral", apiModelId: "devstral-2" }),
      stored: null,
      chat: null,
      warnings: [],
      activationBlockers: [],
      termsSource: "model" as const,
      termsCheckedAt: "2026-11-02",
      problem: null,
      admission: { admitted: true },
      draft: null,
      floor: 1,
    },
  ],
};
const items = codingCatalogItems(report);
const sonnet = items[0];

const providerRow = (overrides: Partial<CodingProviderRow> = {}): CodingProviderRow => ({
  provider: "anthropic",
  terms: { allowsResaleAndCodingAgent: true, termsUrl: TERMS, retentionUrl: RETENTION, processingRegion: "US", checkedAt: "2026-11-10", sources: [TERMS] },
  state: "confirmed",
  checkedAt: "2026-11-10",
  dueOn: "2027-02-08",
  draft: null,
  draftCreatedAt: null,
  updatedByEmail: null,
  modelCount: 1,
  candidateCount: 0,
  legacyTermsCount: 0,
  draftable: true,
  hosts: ["www.anthropic.com", "docs.anthropic.com"],
  ...overrides,
});

test("the list shows both kinds of row with their source, inherited limits, floor and channels", () => {
  const html = renderToStaticMarkup(<CodingModelTable c={c} items={items} pendingIds={new Set()} reasonText={reason} onOpen={noop} />);
  assert.match(html, /data-source="chat"[^>]*>채팅 모델 연결</);
  assert.match(html, /data-source="dedicated"[^>]*>코딩 전용</);
  assert.match(html, />1M \/ 64K</);
  assert.match(html, />채팅에서 상속</);
  assert.match(html, />하한 ×5</);
  // Kimi waits on its weight, in words.
  assert.match(html, /data-state="attention"/);
  assert.match(html, />하한 ×2 미만</);
  assert.match(html, /크레딧 가중치가 최소값 2보다 낮습니다/);
  // Devstral is off: its channels are not offered.
  assert.match(html, /data-state="inactive"/);
  assert.match(html, />노출 안 됨</);
  assert.doesNotMatch(html, /credits_below_floor/);
});

test("the list filters by source, provider, status and text", () => {
  const base = { query: "", provider: "all", source: "all" as const, state: "all" as const };
  assert.deepEqual(filterCodingItems(items, { ...base, source: "dedicated" }).map((item) => item.id), ["devstral-2"]);
  assert.deepEqual(filterCodingItems(items, { ...base, provider: "moonshot" }).map((item) => item.id), ["kimi-k3"]);
  assert.deepEqual(filterCodingItems(items, { ...base, state: "inactive" }).map((item) => item.id), ["devstral-2"]);
  assert.deepEqual(filterCodingItems(items, { ...base, query: "SONNET" }).map((item) => item.id), ["claude-sonnet-4-6"]);
});

test("the banner says who reads the catalogue, from the switch", () => {
  const off = renderToStaticMarkup(<CodingChannelBanner c={c} external={{ enabled: false, env: "CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED" }} />);
  assert.match(off, /data-external="off"/);
  assert.match(off, /지금은 Code 관리형 경로만 이 카탈로그를 읽습니다/);
  const on = renderToStaticMarkup(<CodingChannelBanner c={cEn} external={{ enabled: true, env: "CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED" }} />);
  assert.match(on, /data-external="on"/);
  assert.match(on, /External channels follow this catalog/);
});

test("the summary counts active, waiting and candidates, and the snapshot names its pending changes", () => {
  const html = renderToStaticMarkup(
    <CodingSummary
      c={c}
      items={items}
      candidateCount={5}
      snapshot={{
        version: 14,
        contentHash: "a".repeat(64),
        coverageUntil: "2026-12-18T00:00:00.000Z",
        publishedAt: "2026-11-18T04:05:00.000Z",
        modelCount: 4,
        current: true,
        pendingChanges: [{ modelId: "gemini-3-8-pro", kind: "changed" }],
        contentHashMatches: false,
      }}
      onCandidates={noop}
      candidatesOpen={false}
      onPublish={noop}
      busy={false}
    />
  );
  assert.match(html, /크레딧 하한 미만 1/);
  assert.match(html, />5</);
  assert.match(html, /v14/);
  assert.match(html, /발행 후 변경 1건/);
  assert.match(html, /gemini-3-8-pro \(변경\)/);
  assert.match(html, /data-testid="coding-publish-snapshot"/);
});

test("a chat link's detail shows chat's values read-only and its own settings editable", () => {
  const html = renderToStaticMarkup(
    <CodingLinkDetail
      c={c}
      item={sonnet}
      provider={providerRow()}
      value={codingSettingsFrom(sonnet.link!)}
      busy={false}
      reasonText={reason}
      toolCallingLabel={(value) => m.codingFlow.toolCalling[value] ?? value}
      structuredOutputLabel={(value) => m.codingFlow.structuredOutput[value] ?? value}
      stepperLabel={m.stepperLabel}
      stepStates={m.stepStates}
      onBack={noop}
      onChange={noop}
      onReset={noop}
      onSave={noop}
      onActivate={noop}
      onHold={noop}
      onUnlink={noop}
      onProviders={noop}
    />
  );
  assert.match(html, /data-testid="coding-link-inherited"/);
  assert.match(html, />1,000,000</);
  assert.match(html, />64,000</);
  assert.match(html, />3\.00</);
  // The inherited fields are text, not inputs; the settings are inputs.
  assert.doesNotMatch(html.slice(html.indexOf("coding-link-inherited"), html.indexOf("coding-link-settings")), /<input/);
  assert.match(html, /data-testid="coding-link-weight"[^>]*value="8"/);
  assert.match(html, /data-testid="coding-link-channel-api"[^>]*checked=""/);
  assert.match(html, />LLM 초안</);
  assert.match(html, /anthropic 공급자 조건/);
  assert.match(html, /재판매·코딩 에이전트 허용/);
  assert.match(html, /data-admitted="true"/);
  assert.match(html, /data-testid="coding-link-activate"/);
  assert.doesNotMatch(html.match(/<button[^>]*data-testid="coding-link-activate"[^>]*>/)?.[0] ?? "", / disabled=""/);
  // Not on yet: it can be taken out of the catalogue.
  assert.match(html, /data-testid="coding-link-unlink"/);
});

test("a link that cannot be activated says why, and an unsaved change blocks activation", () => {
  const kimi = items[1];
  const html = renderToStaticMarkup(
    <CodingLinkDetail
      c={c}
      item={kimi}
      provider={providerRow({ provider: "moonshot", terms: null, state: "missing", checkedAt: null, dueOn: null })}
      value={{ ...codingSettingsFrom(kimi.link!), creditWeight: "3" }}
      busy={false}
      reasonText={reason}
      toolCallingLabel={(value) => value}
      structuredOutputLabel={(value) => value}
      stepperLabel={m.stepperLabel}
      stepStates={m.stepStates}
      onBack={noop}
      onChange={noop}
      onReset={noop}
      onSave={noop}
      onActivate={noop}
      onHold={noop}
      onUnlink={noop}
      onProviders={noop}
    />
  );
  assert.match(html, /data-testid="coding-link-refusals"/);
  assert.match(html, /크레딧 가중치가 최소값 2보다 낮습니다/);
  assert.match(html, /아직 확인하지 않았습니다/);
  assert.match(html.match(/<button[^>]*data-testid="coding-link-activate"[^>]*>/)?.[0] ?? "", / disabled=""/);
});

test("the settings request sends only what changed, and null puts an override back to chat", () => {
  const link = sonnet.link!;
  const value = codingSettingsFrom(link);
  assert.deepEqual(codingSettingsRequest(link, value), {});
  assert.deepEqual(codingSettingsRequest(link, { ...value, creditWeight: "", channels: ["cli", "code"] }), {
    creditWeight: null,
    channels: ["code", "cli"],
  });
  assert.deepEqual(codingSettingsRequest(link, { ...value, minimumPlan: "Max", toolCalling: "basic" }), { toolCalling: "basic", minimumPlan: "Max" });
  assert.deepEqual(codingSettingsProblems({ ...value, channels: [] }, { floor: 5, chatWeight: 6 }), { channels: "none_selected" });
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "4" }, { floor: 5, chatWeight: 6 }), { creditWeight: "below_floor" });
  // Empty follows chat's weight, which is checked against the floor too.
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "" }, { floor: 7, chatWeight: 6 }), { creditWeight: "below_floor" });
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "1.5" }, { floor: 1, chatWeight: 6 }), { creditWeight: "not_a_number" });
});

test("a candidate shows what it inherits from chat and its provider's conditions, with one add button", () => {
  const html = renderToStaticMarkup(
    <CodingCandidates
      c={c}
      candidates={[
        { ...chat, id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", terms: { state: "confirmed", checkedAt: "2026-11-08", dueOn: "2027-02-06" } },
        { ...chat, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", terms: { state: "missing", checkedAt: null, dueOn: null } },
      ]}
      excluded={[{ id: "gpt-6-luna-mini", name: "GPT 6 Luna Mini", provider: "openai", reason: "usage_class:research" }]}
      adding={{ id: "gpt-6-luna", elapsed: "0:12" }}
      draftConfigured
      onAdd={noop}
      onBack={noop}
    />
  );
  assert.equal(html.match(/data-testid="coding-candidate"/g)?.length, 2);
  assert.match(html, />1M \/ 64K</);
  assert.match(html, />3\.00 \/ 15\.00</);
  assert.match(html, /openai 공급자 조건 확인됨 · 2026-11-08/);
  assert.match(html, /deepseek 공급자 조건 미확인/);
  assert.match(html, /공급자 문서를 읽는 중 · 0:12/);
  assert.match(html, /후보에서 제외된 채팅 모델/);
});

test("provider conditions list each provider's state, and a draft is compared field by field", () => {
  const rows = [
    providerRow(),
    providerRow({
      provider: "qwen",
      state: "expired",
      checkedAt: "2026-08-12",
      dueOn: "2026-11-10",
      terms: { allowsResaleAndCodingAgent: true, termsUrl: "https://www.alibabacloud.com/help/en/terms", retentionUrl: "https://www.alibabacloud.com/help/en/privacy", processingRegion: "Singapore", checkedAt: "2026-08-12", sources: ["https://www.alibabacloud.com/help/en/terms"] },
      draft: { allowsResaleAndCodingAgent: true, termsUrl: "https://www.alibabacloud.com/help/en/terms", retentionUrl: "https://www.alibabacloud.com/help/en/privacy", processingRegion: "Singapore, US", checkedAt: "2026-11-20", sources: ["https://www.alibabacloud.com/help/en/terms"], evidence: "Section 4." },
      draftCreatedAt: "2026-11-20T04:22:00.000Z",
      hosts: ["www.alibabacloud.com"],
    }),
    providerRow({ provider: "xai", terms: null, state: "missing", checkedAt: null, dueOn: null, modelCount: 1 }),
  ];
  const table = renderToStaticMarkup(
    <CodingProviderTable c={c} providers={rows} drafting={null} openDraft="qwen" draftConfigured onCheck={noop} onOpenDraft={noop} />
  );
  assert.match(table, /data-state="confirmed"/);
  assert.match(table, /data-state="expired"/);
  assert.match(table, />다시 확인 필요</);
  assert.match(table, /2026-11-10 기한 경과/);
  assert.match(table, />확인 시작</);
  assert.match(table, />다시 확인</);
  const draft = renderToStaticMarkup(<ProviderTermsDraftPanel c={c} row={rows[1]} busy={false} onDiscard={noop} onApply={noop} />);
  assert.equal(draft.match(/data-changed="true"/g)?.length, 1);
  assert.match(draft, /Singapore, US/);
  assert.match(draft, />바뀜</);
  assert.match(draft, /근거 문장 — Section 4\./);
  assert.match(draft, /data-testid="coding-provider-apply"/);
});
