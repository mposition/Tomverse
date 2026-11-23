import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodingCandidates, CodingChannelsTile, CodingLinkDetail, CodingNotesTile } from "@/components/admin/modelCatalog/CodingLinkViews";
import { CapabilityFillBar, CodingChannelBanner, CodingModelTable, CodingSummary } from "@/components/admin/modelCatalog/CodingListViews";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminCodingCatalogMessages } from "@/lib/adminMessages/codingCatalog";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import {
  CODING_STRUCTURED_OUTPUT_VALUES,
  type CodingLinkAllResult,
  capabilityFillTargets,
  codingStructuredOutputShown,
  codingCatalogItems,
  codingDedicatedSettings,
  codingNotesProblems,
  codingNotesChanged,
  codingNotesRequest,
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
const fillReady = { configured: true, env: "MODEL_CATALOG_DRAFT_LLM_MODEL_ID", supported: true, running: false, busy: false, onFill: noop };
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
      fill={fillReady}
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
      fill={fillReady}
    />
  );
  assert.match(html, /data-testid="coding-link-refusals"/);
  assert.match(html, /크레딧 가중치가 최소값 2보다 낮습니다/);
  assert.doesNotMatch(html, /아직 확인하지 않았습니다/);
  assert.match(html.match(/<button[^>]*data-testid="coding-link-activate"[^>]*>/)?.[0] ?? "", / disabled=""/);
});

test("structured output is two choices on screen; a finer stored value reads as supported and is written only on a save", () => {
  // The fixture link was stored with "forced_tool_use", before the two choices (owner decision 2026-11-22).
  const legacy = sonnet.link!;
  assert.equal(legacy.capabilities.structuredOutput, "forced_tool_use");
  assert.deepEqual(CODING_STRUCTURED_OUTPUT_VALUES, ["supported", "none"]);
  const value = codingSettingsFrom(legacy);
  assert.equal(value.structuredOutput, "supported");
  // Opened and left alone: nothing is sent, so the row and its snapshot hash stay as they are.
  assert.deepEqual(codingSettingsRequest(legacy, value), {});
  // Saved with another change: the stored value is written as the shown choice.
  assert.deepEqual(codingSettingsRequest(legacy, { ...value, channels: ["api"] }), { channels: ["api"], structuredOutput: "supported" });
  assert.deepEqual(codingSettingsRequest(legacy, { ...value, structuredOutput: "none" }), { structuredOutput: "none" });
  // A link already on a choice sends it only when it changes.
  const current = { ...legacy, capabilities: { ...legacy.capabilities, structuredOutput: "supported" } };
  assert.deepEqual(codingSettingsRequest(current, { ...codingSettingsFrom(current), channels: ["api"] }), { channels: ["api"] });
  for (const stored of ["none", "supported", "json_mode", "strict_schema", "forced_tool_use", "response_schema"]) {
    assert.equal(codingStructuredOutputShown(stored), stored === "none" ? "none" : "supported", stored);
  }

  const html = renderToStaticMarkup(
    <CodingLinkDetail
      c={c}
      item={sonnet}
      value={value}
      busy={false}
      reasonText={reason}
      toolCallingLabel={(entry) => m.codingFlow.toolCalling[entry] ?? entry}
      structuredOutputLabel={(entry) => m.codingFlow.structuredOutput[entry] ?? entry}
      stepperLabel={m.stepperLabel}
      stepStates={m.stepStates}
      onBack={noop}
      onChange={noop}
      onReset={noop}
      onSave={noop}
      onActivate={noop}
      onHold={noop}
      onUnlink={noop}
      fill={fillReady}
    />
  );
  const select = html.match(/<select[^>]*data-testid="coding-link-structured"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((match) => [match[1], match[2]]), [
    ["supported", "지원"],
    ["none", "지원 안 함"],
  ]);
  assert.match(select, /<option value="supported" selected="">/);
  assert.doesNotMatch(select, /forced_tool_use|json_mode|strict_schema|response_schema/);
  // The stored value is still the one the LLM drafted from the pages, so its origin chip stays.
  assert.match(html, />LLM 초안</);
});

test("the settings request sends only what changed, and null puts an override back to chat", () => {
  const link = { ...sonnet.link!, capabilities: { ...sonnet.link!.capabilities, structuredOutput: "supported" } };
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
      fill={fillReady}
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
    attempted: 6,
    added: ["a", "b", "f"],
    withCode: ["a"],
    refused: [
      { modelId: "c", reasons: ["provider_destination_unproven"] },
      { modelId: "d", reasons: ["unknown_provider"] },
      { modelId: "e", reasons: ["unknown_provider"] },
    ],
    reasonCounts: { unknown_provider: 2, provider_destination_unproven: 1 },
    // b and f are on the coding API but not on Code.
    codeReasonCounts: { credits_below_floor: 2, no_structured_output: 2 },
    codeRefused: [
      { modelId: "b", reasons: ["credits_below_floor:7", "no_structured_output"] },
      { modelId: "f", reasons: ["credits_below_floor:9", "no_structured_output"] },
    ],
  };
  const html = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish={null} />);
  assert.match(html, /data-testid="coding-link-all-result"[^>]*data-added="3"/);
  assert.match(html, /채팅 모델 6개 중 3개를 코딩 API로 추가했고, 그중 1개는 Code까지 연결했습니다/);
  assert.match(html, /3개는 추가하지 않았습니다/);
  assert.match(html, /data-reason="unknown_provider"[^>]*>[^<]*· 2</);
  assert.match(html, /data-reason="provider_destination_unproven"[^>]*>[^<]*· 1</);
  // The two added without Code say why Code does not have them.
  assert.match(html, /2개는 Code 없이 추가했습니다/);
  assert.match(html, /data-testid="coding-link-all-code-reasons"/);
  assert.match(html, /data-reason="credits_below_floor"[^>]*>[^<]*크레딧 가중치가 최소값 7보다 낮습니다[^<]*· 2</);
  assert.match(html, /data-reason="no_structured_output"[^>]*>[^<]*구조화 출력이 없음[^<]*· 2</);
  // The snapshot is not published unless asked: the screen says to publish it.
  assert.match(html, /스냅샷을 발행해 주세요/);
  const published = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish={21} />);
  assert.match(published, /스냅샷 v21을 발행했습니다/);
  const failed = renderToStaticMarkup(<CodingCandidates {...candidateProps} result={result} resultPublish="failed" />);
  assert.match(failed, /스냅샷은 발행되지 않았습니다/);
  // Nothing added: nothing to publish.
  const none = renderToStaticMarkup(
    <CodingCandidates
      {...candidateProps}
      result={{ attempted: 1, added: [], withCode: [], refused: [{ modelId: "c", reasons: ["unknown_provider"] }], reasonCounts: { unknown_provider: 1 }, codeReasonCounts: {}, codeRefused: [] }}
    />
  );
  assert.doesNotMatch(none, /coding-link-all-publish/);
});

const apiOnlyItem = codingCatalogItems({
  models: [
    {
      modelId: "gpt-6-luna",
      enabled: true,
      holdReason: null,
      source: "chat" as const,
      profile: resolved({ modelId: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", channels: ["api"] }),
      stored: { ...stored, registryModelId: "gpt-6-luna", channels: ["api"], capabilities: { toolCalling: "basic", structuredOutput: "none" }, evidence: { sources: [], draftedAt: "2026-11-21", toolCalling: "basic", structuredOutput: "none" } },
      chat: { ...chat, id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai" },
      problem: null,
      admission: { admitted: true },
      channelAdmission: { api: { admitted: true }, code: { admitted: false, reasons: ["credits_below_floor:7", "no_structured_output"] } },
      effectiveChannels: ["api"],
      draft: null,
      floor: 7,
    },
  ],
})[0];

test("the list and a link's detail say per channel what can be offered, and why Code is refused", () => {
  const list = renderToStaticMarkup(<CodingModelTable c={c} items={[apiOnlyItem]} pendingIds={new Set()} reasonText={reason} onOpen={noop} />);
  assert.match(list, /data-testid="coding-channel-verdicts"/);
  assert.match(list, /data-channel="api" data-admitted="true"[^>]*>코딩 API: 노출 가능</);
  assert.match(list, /data-channel="code" data-admitted="false"[^>]*>Code: 거절 · 크레딧 가중치가 최소값 7보다 낮습니다/);
  // It serves on the coding API only: Code is not among the channel chips.
  assert.match(list.match(/data-testid="coding-channels">.*?<\/span><\/span>/)?.[0] ?? "", /코딩 API/);
  assert.doesNotMatch(list.match(/data-testid="coding-channels">.*?<\/span><\/span>/)?.[0] ?? "", />Code</);
  const detail = renderToStaticMarkup(
    <CodingLinkDetail
      c={c}
      item={apiOnlyItem}
      value={codingSettingsFrom(apiOnlyItem.link!)}
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
      fill={fillReady}
    />
  );
  assert.match(detail, /data-channel="api" data-admitted="true"/);
  assert.match(detail, /data-channel="code" data-admitted="false"/);
});

test("a link's detail has one fill button, off with the reason while the draft model is not set or the provider has no pages", () => {
  const render = (fill: typeof fillReady) =>
    renderToStaticMarkup(
      <CodingLinkDetail
        c={c}
        item={apiOnlyItem}
        value={codingSettingsFrom(apiOnlyItem.link!)}
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
        fill={fill}
      />
    );
  const button = (html: string) => html.match(/<button[^>]*data-testid="coding-link-fill-button"[^>]*>/)?.[0] ?? "";
  const ready = render(fillReady);
  assert.match(ready, />LLM으로 기능 정보 채우기</);
  assert.doesNotMatch(button(ready), / disabled=""/);
  assert.match(ready, /LLM 호출 1회/);
  assert.match(button(render({ ...fillReady, running: true, busy: true })), / disabled=""/);
  assert.match(render({ ...fillReady, running: true, busy: true }), />공식 문서를 읽는 중…</);
  const off = render({ ...fillReady, configured: false });
  assert.match(button(off), / disabled=""/);
  assert.match(off, /꺼져 있습니다\. MODEL_CATALOG_DRAFT_LLM_MODEL_ID에 활성 모델을 지정하면 켜집니다/);
  const noSource = render({ ...fillReady, supported: false });
  assert.match(button(noSource), / disabled=""/);
  assert.match(noSource, /이 공급자는 공식 문서 주소가 없습니다/);
});

test("the fill bar counts the rows to fill, shows N/M while it runs, and lists what failed and why", () => {
  const { targets, unsupported } = capabilityFillTargets(
    [apiOnlyItem, ...items],
    ["openai"]
  );
  // The registry-made link of a provider with pages is a target. The drafted
  // links (pages read) and the dedicated row have no coding notes yet, so they
  // are fill targets too (owner decision 2026-11-22), here of providers without pages.
  assert.deepEqual(targets.map((item) => item.id), ["gpt-6-luna"]);
  assert.deepEqual(capabilityFillTargets([apiOnlyItem], []).unsupported.map((item) => item.id), ["gpt-6-luna"]);
  assert.deepEqual(unsupported.map((item) => item.id), ["claude-sonnet-4-6", "kimi-k3", "devstral-2"]);
  assert.deepEqual(
    capabilityFillTargets(items, ["anthropic", "moonshot", "mistral"]).targets.map((item) => item.id),
    ["claude-sonnet-4-6", "kimi-k3", "devstral-2"]
  );
  // With notes, a row whose capabilities came from the pages is no longer a target; a dedicated row neither.
  const noted = codingCatalogItems({
    models: report.models.map((row) => ({
      ...row,
      stored: { ...(row.stored ?? {}), codingNotes: { strengths: ["Parallel tool calls"], weaknesses: [], sources: [], draftedAt: "2026-11-22" } },
    })),
  });
  assert.deepEqual(capabilityFillTargets(noted, ["anthropic", "moonshot", "mistral"]).targets, []);

  const barProps = { c, count: 3, skipped: 1, configured: true, env: "MODEL_CATALOG_DRAFT_LLM_MODEL_ID", progress: null, result: null, reasonText: reason, onFillAll: noop, onClose: noop };
  const idle = renderToStaticMarkup(<CapabilityFillBar {...barProps} />);
  assert.match(idle, />기능 정보나 장단점이 없는 행 3개 모두 채우기</);
  assert.doesNotMatch(idle.match(/<button[^>]*data-testid="coding-fill-all"[^>]*>/)?.[0] ?? "", / disabled=""/);
  const running = renderToStaticMarkup(<CapabilityFillBar {...barProps} progress={{ done: 1, total: 3 }} />);
  assert.match(running, /data-testid="coding-fill-progress" data-done="1" data-total="3"/);
  assert.match(running, /채우는 중 1\/3/);
  assert.match(running.match(/<button[^>]*data-testid="coding-fill-all"[^>]*>/)?.[0] ?? "", / disabled=""/);
  const off = renderToStaticMarkup(<CapabilityFillBar {...barProps} configured={false} />);
  assert.match(off, /data-testid="coding-fill-off"/);
  assert.match(off.match(/<button[^>]*data-testid="coding-fill-all"[^>]*>/)?.[0] ?? "", / disabled=""/);
  const done = renderToStaticMarkup(
    <CapabilityFillBar
      {...barProps}
      result={{ total: 3, ok: 1, failed: [{ modelId: "a", code: "fetch_failed" }, { modelId: "b", code: "timeout_outcome_unknown" }], stopped: true }}
    />
  );
  assert.match(done, /행 3개 중 1개를 채웠습니다/);
  assert.match(done, /2개는 값을 그대로 두었습니다/);
  assert.match(done, /data-model="a"[^>]*>.*문서를 읽지 못했습니다|data-model="a"/);
  assert.match(done, /data-model="b"/);
  assert.match(done, /시간 초과 뒤 멈췄습니다/);
  // Nothing to fill and nothing running: the bar is not drawn.
  assert.equal(renderToStaticMarkup(<CapabilityFillBar {...barProps} count={0} />), "");
});

test("the coding notes tile shows the notes and the pages they stand on, takes one note per line, and holds the limits", () => {
  // Owner decision 2026-11-22: what the coding API's router reads instead of chat's bestFor.
  const notesOn = (codingNotes: unknown) =>
    codingCatalogItems({ models: [{ ...report.models[0], stored: { ...stored, codingNotes } }] })[0];
  const drafted = notesOn({
    strengths: ["Parallel tool calls in one response", "Strict tool schemas"],
    weaknesses: ["No JSON schema on the batch API"],
    sources: ["https://docs.anthropic.com/en/docs/build-with-claude/tool-use"],
    draftedAt: "2026-11-22",
  });
  const html = renderToStaticMarkup(<CodingNotesTile c={c} item={drafted} busy={false} onSave={noop} />);
  assert.match(html, /data-testid="coding-notes"/);
  assert.match(html, /<ul[^>]*data-testid="coding-notes-strengths"[^>]*><li>Parallel tool calls in one response<\/li><li>Strict tool schemas<\/li><\/ul>/);
  assert.match(html, /<ul[^>]*data-testid="coding-notes-weaknesses"[^>]*><li>No JSON schema on the batch API<\/li><\/ul>/);
  assert.match(html, /docs\.anthropic\.com\/en\/docs\/build-with-claude\/tool-use/);
  assert.match(html, /2026-11-22 작성/);
  // The edit fields start at the stored notes, one per line; nothing changed, so nothing to save.
  assert.match(html, /<textarea[^>]*data-testid="coding-notes-strengths-input"[^>]*>Parallel tool calls in one response\nStrict tool schemas<\/textarea>/);
  assert.match(html.match(/<button[^>]*data-testid="coding-notes-save"[^>]*>/)?.[0] ?? "", / disabled=""/);
  // Written by the operator: no page, and the edit date.
  const own = renderToStaticMarkup(
    <CodingNotesTile c={c} item={notesOn({ strengths: ["Fast on short edits"], weaknesses: [], sources: [], draftedAt: "2026-11-20", editedAt: "2026-11-22" })} busy={false} onSave={noop} />
  );
  assert.match(own, /운영자 입력/);
  assert.match(own, /2026-11-20 작성 · 2026-11-22 수정/);
  // None yet.
  const empty = renderToStaticMarkup(<CodingNotesTile c={c} item={items[0]} busy={false} onSave={noop} />);
  assert.match(empty, /data-testid="coding-notes-empty"/);

  // The typed lines, the limits the server holds them to, and an empty pair removing them.
  assert.deepEqual(codingNotesRequest({ strengths: " Parallel tool calls \n\n Strict schemas ", weaknesses: "" }), {
    strengths: ["Parallel tool calls", "Strict schemas"],
    weaknesses: [],
  });
  assert.equal(codingNotesRequest({ strengths: "\n ", weaknesses: "" }), null);
  assert.deepEqual(codingNotesProblems({ strengths: "a\nb\nc\nd", weaknesses: "x".repeat(121) }), { strengths: "too_many", weaknesses: "too_long" });
  assert.deepEqual(codingNotesProblems({ strengths: "a\nb\nc", weaknesses: "x".repeat(120) }), {});

  // A change is what would be saved: spaces and blank lines alone are not an edit.
  const storedNotes = { strengths: ["Parallel tool calls", "Strict schemas"], weaknesses: [] };
  assert.equal(codingNotesChanged({ strengths: "Parallel tool calls\nStrict schemas", weaknesses: "" }, storedNotes), false);
  assert.equal(codingNotesChanged({ strengths: " Parallel  tool calls \n\nStrict schemas\n", weaknesses: " " }, storedNotes), false);
  assert.equal(codingNotesChanged({ strengths: "Strict schemas\nParallel tool calls", weaknesses: "" }, storedNotes), true);
  assert.equal(codingNotesChanged({ strengths: "Parallel tool calls\nStrict schemas", weaknesses: "Slow" }, storedNotes), true);
  assert.equal(codingNotesChanged({ strengths: "", weaknesses: "" }, storedNotes), true, "emptying both removes them");
  assert.equal(codingNotesChanged({ strengths: "\n", weaknesses: "" }, null), false);
  assert.equal(codingNotesChanged({ strengths: "", weaknesses: "" }, { strengths: [], weaknesses: [] }), false);
  assert.equal(codingNotesChanged({ strengths: "New", weaknesses: "" }, null), true);

  // The same note or page twice renders twice (each item is keyed by its position too).
  const twice = renderToStaticMarkup(
    <CodingNotesTile
      c={c}
      item={notesOn({ strengths: ["Same", "Same"], weaknesses: [], sources: ["https://docs.anthropic.com/a", "https://docs.anthropic.com/a"], draftedAt: "2026-11-22" })}
      busy={false}
      onSave={noop}
    />
  );
  assert.match(twice, /<li>Same<\/li><li>Same<\/li>/);
  assert.equal(twice.match(/docs\.anthropic\.com\/a<\/a>/g)?.length, 2);
});
