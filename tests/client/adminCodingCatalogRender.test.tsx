import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodingCandidates, CodingChannelsTile, CodingLinkDetail } from "@/components/admin/modelCatalog/CodingLinkViews";
import { CodingChannelBanner, CodingModelTable, CodingSummary } from "@/components/admin/modelCatalog/CodingListViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminCodingCatalogMessages } from "@/lib/adminMessages/codingCatalog";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import {
  type CodingLinkAllResult,
  codingCatalogItems,
  codingDedicatedSettings,
  codingSettingsFrom,
  codingSettingsProblems,
  codingSettingsRequest,
  filterCodingItems,
  reasonMessage,
} from "@/lib/adminModelCatalogFlow";
import { reasonText } from "@/components/admin/modelCatalog/ImageCatalogViews";

// The coding catalogue tab (Figma "코딩 카탈로그 시안 v1"): the list, a chat
// link's detail and the candidates (one at a time, or all at once). Provider
// conditions are gone (owner decision 2026-11-21).

const c = adminMessagesFor(adminCodingCatalogMessages, "ko");
const cEn = adminMessagesFor(adminCodingCatalogMessages, "en");
const m = adminMessagesFor(adminModelCatalogMessages, "ko");
const noop = () => {};
const reason = (code: string) => reasonText(m, reasonMessage(code));

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
      problem: null,
      admission: { admitted: true },
      draft: null,
      floor: 1,
    },
  ],
};
const items = codingCatalogItems(report);
const sonnet = items[0];

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

test("a dedicated row picks where it is offered: Code and the coding API", () => {
  const devstral = items.find((item) => item.id === "devstral-2")!;
  assert.deepEqual(devstral.channels, ["code"]);
  const html = renderToStaticMarkup(<CodingChannelsTile c={c} item={devstral} busy={false} onSave={noop} />);
  assert.match(html, /data-testid="coding-dedicated-channel-code"[^>]*checked=""/);
  assert.match(html, /data-testid="coding-dedicated-channel-api"/);
  assert.doesNotMatch(html, /coding-dedicated-channel-api"[^>]*checked=""/);
  assert.doesNotMatch(html, /coding-dedicated-channel-cli/);
  assert.match(html, />코딩 API</);
  // Nothing changed yet: nothing to save.
  assert.match(html.match(/<button[^>]*data-testid="coding-dedicated-channels-save"[^>]*>/)?.[0] ?? "", / disabled=""/);
});

test("a dedicated row on the coding API shows its two credits: Code's, and the coding API's chat-rule minimum", () => {
  const devstral = items.find((item) => item.id === "devstral-2")!;
  const onApi = {
    ...devstral,
    channels: ["code", "api"],
    apiCredit: { codeCredits: 9, override: null, floorCredits: 3, credits: 3, basis: "chat_rule_floor" as const, refusal: null },
  };
  const html = renderToStaticMarkup(<CodingChannelsTile c={c} item={onApi} busy={false} onSave={noop} />);
  assert.match(html, /Tomverse Code 크레딧/);
  assert.match(html, /×9/);
  assert.match(html, /data-testid="coding-dedicated-api-credits"/);
  assert.match(html, /코딩 API 크레딧/);
  assert.match(html, /<input[^>]*placeholder="3"[^>]*data-testid="coding-dedicated-api-credit-input"/);
  assert.match(html, /기본값: 채팅 기준 최소값 ×3/);
  // Off the coding API, only Code's credits are shown.
  const offApi = renderToStaticMarkup(<CodingChannelsTile c={c} item={{ ...onApi, channels: ["code"] }} busy={false} onSave={noop} />);
  assert.doesNotMatch(offApi, /coding-dedicated-api-credits/);
  // A floor that cannot be worked out says the coding API does not offer it.
  const unbounded = renderToStaticMarkup(
    <CodingChannelsTile c={cEn} item={{ ...onApi, apiCredit: { ...onApi.apiCredit, floorCredits: null, credits: null, basis: null, refusal: "api_credit_floor_unbounded" } }} busy={false} onSave={noop} />
  );
  assert.match(unbounded, /the coding API does not offer it/);
});

test("a dedicated row's settings read the override only while the coding API is ticked", () => {
  const base = { storedChannels: ["code", "api"], storedOverride: null };
  // On the coding API: an invalid override holds the save back.
  assert.equal(codingDedicatedSettings({ ...base, channels: ["code", "api"], override: "abc" }).canSave, false);
  assert.deepEqual(codingDedicatedSettings({ ...base, channels: ["code", "api"], override: "12" }).request, { apiCreditWeight: 12 });
  // The coding API unticked: the hidden field neither blocks nor is sent.
  const off = codingDedicatedSettings({ ...base, channels: ["code"], override: "abc" });
  assert.equal(off.overrideInvalid, false);
  assert.equal(off.canSave, true);
  assert.deepEqual(off.request, { channels: ["code"] });
  // Nothing changed, or no channel left: nothing to save.
  assert.equal(codingDedicatedSettings({ ...base, channels: ["code", "api"], override: "" }).canSave, false);
  assert.equal(codingDedicatedSettings({ ...base, channels: [], override: "" }).canSave, false);
  // Clearing a stored override sends null: back to the chat rule's minimum.
  assert.deepEqual(codingDedicatedSettings({ ...base, storedOverride: 9, channels: ["code", "api"], override: "" }).request, { apiCreditWeight: null });
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
  assert.match(on, /The coding API follows this catalog/);
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
  // This link was drafted from pages (before the registry took over): its values say so.
  assert.match(html, />LLM 초안</);
  assert.doesNotMatch(html, /data-testid="coding-link-sources-registry"/);
  // Provider conditions are not on the screen: no tile, no judge line.
  assert.doesNotMatch(html, /공급자 조건/);
  assert.doesNotMatch(html, /coding-link-terms/);
  assert.doesNotMatch(html, /재판매·코딩 에이전트/);
  assert.doesNotMatch(html, /약관/);
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
    />
  );
  assert.match(html, /data-testid="coding-link-refusals"/);
  assert.match(html, /크레딧 가중치가 최소값 2보다 낮습니다/);
  assert.doesNotMatch(html, /아직 확인하지 않았습니다/);
  assert.match(html.match(/<button[^>]*data-testid="coding-link-activate"[^>]*>/)?.[0] ?? "", / disabled=""/);
});

test("the settings request sends only what changed, and null puts an override back to chat", () => {
  const link = sonnet.link!;
  const value = codingSettingsFrom(link);
  assert.deepEqual(codingSettingsRequest(link, value), {});
  assert.deepEqual(codingSettingsRequest(link, { ...value, creditWeight: "", channels: ["api"] }), {
    creditWeight: null,
    channels: ["api"],
  });
  // Two channels on screen: Code and the coding API. A link saved with the
  // CLI's older channel reads as the coding API and is sent unchanged.
  const older = { ...link, channels: ["code", "cli"] };
  assert.deepEqual(codingSettingsFrom(older).channels, ["code", "api"]);
  assert.deepEqual(codingSettingsRequest(older, codingSettingsFrom(older)), {});
  assert.deepEqual(codingSettingsRequest(older, { ...codingSettingsFrom(older), channels: ["code"] }), { channels: ["code"] });
  assert.deepEqual(codingSettingsRequest(link, { ...value, minimumPlan: "Max", toolCalling: "basic" }), { toolCalling: "basic", minimumPlan: "Max" });
  assert.deepEqual(codingSettingsProblems({ ...value, channels: [] }, { floor: 5, chatWeight: 6 }), { channels: "none_selected" });
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "4" }, { floor: 5, chatWeight: 6 }), { creditWeight: "below_floor" });
  // Empty follows chat's weight, which is checked against the floor too.
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "" }, { floor: 7, chatWeight: 6 }), { creditWeight: "below_floor" });
  assert.deepEqual(codingSettingsProblems({ ...value, creditWeight: "1.5" }, { floor: 1, chatWeight: 6 }), { creditWeight: "not_a_number" });
});

const registryStored = {
  ...stored,
  capabilities: { toolCalling: "basic", structuredOutput: "none" },
  creditWeight: undefined,
  evidence: { sources: [], draftedAt: "2026-11-21", toolCalling: "basic", structuredOutput: "none" },
};

test("a link made from the registry says its capabilities came from there, and shows no provider conditions", () => {
  const item = codingCatalogItems({
    models: [
      {
        modelId: "claude-sonnet-4-6",
        enabled: null,
        holdReason: null,
        source: "chat" as const,
        profile: resolved({ capabilities: { toolCalling: "basic", structuredOutput: "none", imageInput: true, maxContextTokens: 1_000_000, maxOutputTokens: 64_000 } }),
        stored: registryStored,
        chat,
        problem: null,
        admission: { admitted: true },
        draft: null,
        floor: 5,
      },
    ],
  })[0];
  const html = renderToStaticMarkup(
    <CodingLinkDetail
      c={c}
      item={item}
      value={codingSettingsFrom(item.link!)}
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
    />
  );
  assert.match(html, />채팅 레지스트리</);
  assert.doesNotMatch(html, />LLM 초안</);
  assert.match(html, /data-testid="coding-link-sources-registry"/);
  assert.match(html, /채팅 레지스트리에서 가져왔습니다/);
  assert.doesNotMatch(html, /공급자 조건/);
  assert.doesNotMatch(html, /약관/);
  // Tool calling passes the judge; structured output stays at the conservative none until the operator sets it.
  assert.match(html, /data-admitted="true"/);
});

const candidateProps = {
  c,
  candidates: [
    { ...chat, id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai" },
    { ...chat, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek" },
  ],
  excluded: [{ id: "gpt-6-luna-mini", name: "GPT 6 Luna Mini", provider: "openai", reason: "usage_class:research" }],
  adding: null,
  addingAll: false,
  result: null,
  resultPublish: null,
  reasonText: reason,
  onAdd: noop,
  onAddAll: noop,
  onCloseResult: noop,
  onBack: noop,
};

test("a candidate shows what it inherits from chat, with one add button and one add-all button, and no provider conditions", () => {
  const html = renderToStaticMarkup(<CodingCandidates {...candidateProps} adding="gpt-6-luna" />);
  assert.equal(html.match(/data-testid="coding-candidate"/g)?.length, 2);
  assert.match(html, />1M \/ 64K</);
  assert.match(html, />3\.00 \/ 15\.00</);
  assert.match(html, /후보에서 제외된 채팅 모델/);
  // No provider conditions line, and no documentation prompt: an add reads the registry only.
  assert.doesNotMatch(html, /coding-candidate-terms/);
  assert.doesNotMatch(html, /공급자 조건/);
  assert.doesNotMatch(html, /공급자 문서를 읽는 중/);
  assert.match(html, /LLM은 호출하지 않습니다/);
  // One request is in flight: the add buttons wait, and the one being added says so.
  assert.match(html, /추가 중…/);
  const buttons = html.match(/<button[^>]*data-testid="coding-candidate-add"[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, / disabled=""/);
  assert.match(html, /data-testid="coding-candidates-add-all"[^>]*disabled=""/);
  // Idle: both are available, and the add-all button names what it does.
  const idle = renderToStaticMarkup(<CodingCandidates {...candidateProps} />);
  assert.doesNotMatch(idle.match(/<button[^>]*data-testid="coding-candidates-add-all"[^>]*>/)?.[0] ?? "", / disabled=""/);
  assert.match(idle, />채팅 모델 한 번에 추가</);
  // With nothing to add there is no add-all button.
  assert.doesNotMatch(renderToStaticMarkup(<CodingCandidates {...candidateProps} candidates={[]} />), /coding-candidates-add-all/);
});

test("the add-all result says how many were added, the reasons for the rest by count, and what to do about the snapshot", () => {
  const result: CodingLinkAllResult = {
    attempted: 5,
    added: ["a", "b"],
    refused: [
      { modelId: "c", reasons: ["credits_below_floor:7"] },
      { modelId: "d", reasons: ["credits_below_floor:9", "unknown_provider"] },
      { modelId: "e", reasons: ["provider_destination_unproven"] },
    ],
    reasonCounts: { credits_below_floor: 2, unknown_provider: 1, provider_destination_unproven: 1 },
  };
  const html = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish={null} />);
  assert.match(html, /data-testid="coding-link-all-result"[^>]*data-added="2"/);
  assert.match(html, /채팅 모델 5개 중 2개를 추가하고 활성화했습니다/);
  assert.match(html, /3개는 추가하지 않았습니다/);
  assert.match(html, /data-reason="credits_below_floor"[^>]*>[^<]*크레딧 가중치가 최소값 7보다 낮습니다[^<]*· 2</);
  assert.match(html, /data-reason="unknown_provider"[^>]*>[^<]*· 1</);
  assert.match(html, /data-reason="provider_destination_unproven"[^>]*>[^<]*· 1</);
  // The snapshot is not published unless asked: the screen says to publish it.
  assert.match(html, /스냅샷을 발행해 주세요/);
  const published = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish={21} />);
  assert.match(published, /스냅샷 v21을 발행했습니다/);
  const failed = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish="failed" />);
  assert.match(failed, /스냅샷은 발행되지 않았습니다/);
  // Nothing added: nothing to publish.
  const none = renderToStaticMarkup(
    <CodingCandidates {...candidateProps} result={{ attempted: 1, added: [], refused: [{ modelId: "c", reasons: ["unknown_provider"] }], reasonCounts: { unknown_provider: 1 } }} />
  );
  assert.doesNotMatch(none, /coding-link-all-publish/);
});
