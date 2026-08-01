import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MODEL_SUMMARY_AVATARS,
  buildChatModelSummary,
} from "../lib/chatModelSummary.ts";
import { chatModelSummaryCopy } from "../components/chat/chatModelSummaryCopy.ts";

const MODELS = [
  { id: "gpt-5-4-mini", name: "GPT-5.4 mini", provider: "openai" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gemini-2-5-flash", name: "Gemini 3.5 Flash-Lite", provider: "google" },
  { id: "grok-3-mini", name: "Grok 3 Mini", provider: "xai" },
];

const summarize = (input) => buildChatModelSummary({ models: MODELS, ...input });

test("no selection produces no primary model and nothing to count", () => {
  const summary = summarize({ selectedModels: [] });

  assert.equal(summary.primary, null);
  assert.equal(summary.selectedCount, 0);
  assert.equal(summary.activeCount, 0);
  assert.equal(summary.extraActiveCount, 0);
  assert.equal(summary.isMultiModel, false);
  assert.deepEqual(summary.avatars, []);
});

test("a single model shows its full name and never a +0", () => {
  const summary = summarize({ selectedModels: ["gpt-5-4-mini"] });

  assert.equal(summary.primary?.name, "GPT-5.4 mini");
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.extraActiveCount, 0);
  assert.equal(summary.isMultiModel, false);
});

test("extra count is the additional active models, not the total", () => {
  const two = summarize({
    selectedModels: ["gpt-5-4-mini", "claude-sonnet-5"],
  });
  assert.equal(two.extraActiveCount, 1);
  assert.equal(two.activeCount, 2);

  const three = summarize({
    selectedModels: ["gpt-5-4-mini", "claude-sonnet-5", "gemini-2-5-flash"],
  });
  assert.equal(three.extraActiveCount, 2);
  assert.equal(three.activeCount, 3);
  assert.equal(three.extraActiveCount, three.activeCount - 1);
});

test("paused panels leave the active count and so the +N", () => {
  const summary = summarize({
    selectedModels: ["gpt-5-4-mini", "claude-sonnet-5", "gemini-2-5-flash"],
    disabledModelIds: ["gemini-2-5-flash"],
  });

  assert.equal(summary.selectedCount, 3);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.pausedCount, 1);
  // "GPT-5.4 mini +1" -- the third model is selected but is not being sent to.
  assert.equal(summary.extraActiveCount, 1);
});

test("viewing a paused panel still counts every active model as additional", () => {
  const summary = summarize({
    selectedModels: ["gpt-5-4-mini", "claude-sonnet-5", "gemini-2-5-flash"],
    disabledModelIds: ["gpt-5-4-mini"],
    primaryModelId: "gpt-5-4-mini",
  });

  assert.equal(summary.primary?.modelId, "gpt-5-4-mini");
  assert.equal(summary.primary?.isPaused, true);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.extraActiveCount, 2);
});

test("the primary model follows the panel on screen", () => {
  const selectedModels = ["gpt-5-4-mini", "claude-sonnet-5", "gemini-2-5-flash"];

  assert.equal(
    summarize({ selectedModels, primaryModelId: "claude-sonnet-5" }).primary?.name,
    "Claude Sonnet 5"
  );
  // Switching panels only moves the name; the +N is unchanged.
  assert.equal(
    summarize({ selectedModels, primaryModelId: "claude-sonnet-5" }).extraActiveCount,
    2
  );
});

test("an unknown or stale primary id falls back to a real selected model", () => {
  const selectedModels = ["gpt-5-4-mini", "claude-sonnet-5"];

  assert.equal(
    summarize({ selectedModels, primaryModelId: "removed-model" }).primary?.modelId,
    "gpt-5-4-mini"
  );
  // Prefers a model that is actually answering over a paused first entry.
  assert.equal(
    summarize({
      selectedModels,
      disabledModelIds: ["gpt-5-4-mini"],
      primaryModelId: null,
    }).primary?.modelId,
    "claude-sonnet-5"
  );
});

test("a model missing from the catalog falls back to its id", () => {
  const summary = summarize({ selectedModels: ["retired-model", "gpt-5-4-mini"] });

  assert.equal(summary.primary?.name, "retired-model");
  assert.equal(summary.primary?.model, undefined);
  assert.equal(summary.activeCount, 2);
});

test("duplicate ids are counted once", () => {
  const summary = summarize({
    selectedModels: ["gpt-5-4-mini", "gpt-5-4-mini", "claude-sonnet-5"],
  });

  assert.equal(summary.selectedCount, 2);
  assert.equal(summary.extraActiveCount, 1);
});

test("avatars lead with the model on screen and cap at three", () => {
  const summary = summarize({
    selectedModels: ["gpt-5-4-mini", "claude-sonnet-5", "gemini-2-5-flash"],
    primaryModelId: "gemini-2-5-flash",
  });

  assert.equal(summary.avatars.length, MAX_MODEL_SUMMARY_AVATARS);
  assert.equal(summary.avatars[0].modelId, "gemini-2-5-flash");
  assert.equal(summary.avatarOverflowCount, 0);
});

test("a fourth model becomes an overflow badge instead of a fourth avatar", () => {
  const summary = summarize({
    selectedModels: [
      "gpt-5-4-mini",
      "claude-sonnet-5",
      "gemini-2-5-flash",
      "grok-3-mini",
    ],
  });

  assert.equal(summary.avatars.length, MAX_MODEL_SUMMARY_AVATARS - 1);
  assert.equal(summary.avatarOverflowCount, 2);
  assert.equal(
    summary.avatars.length + summary.avatarOverflowCount,
    summary.selectedCount
  );
});

test("long model names are passed through untouched for the UI to truncate", () => {
  const longName = "Perplexity Sonar Reasoning Pro (extended research preview)";
  const summary = buildChatModelSummary({
    selectedModels: ["long-model", "gpt-5-4-mini"],
    models: [{ id: "long-model", name: longName }, ...MODELS],
  });

  assert.equal(summary.primary?.name, longName);
  assert.equal(summary.extraActiveCount, 1);
});

test("every language names the model on screen and the total active count", () => {
  const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];
  assert.deepEqual(Object.keys(chatModelSummaryCopy).sort(), [...languages].sort());

  for (const language of languages) {
    const label = chatModelSummaryCopy[language].accessibleName({
      primaryModelName: "GPT-5.4 mini",
      extraActiveCount: 2,
      activeCount: 3,
      pausedCount: 0,
    });

    assert.ok(label.includes("GPT-5.4 mini"), `${language} omits the model name`);
    assert.ok(label.includes("3"), `${language} omits the active model count`);
    assert.ok(
      chatModelSummaryCopy[language].openPicker.trim().length > 3,
      `${language} needs an open-picker label`
    );
  }

  assert.equal(
    chatModelSummaryCopy.en.accessibleName({
      primaryModelName: "GPT-5.4 mini",
      extraActiveCount: 2,
      activeCount: 3,
      pausedCount: 0,
    }),
    "GPT-5.4 mini and 2 more models selected. 3 active models total. Open model picker."
  );
  assert.equal(
    chatModelSummaryCopy.ko.accessibleName({
      primaryModelName: "GPT-5.4 mini",
      extraActiveCount: 2,
      activeCount: 3,
      pausedCount: 0,
    }),
    "GPT-5.4 mini 외 2개 모델 선택됨. 활성 모델 총 3개. 모델 선택기 열기."
  );
});

test("a single selection reads as one model, not as a bare name", () => {
  assert.equal(
    chatModelSummaryCopy.en.accessibleName({
      primaryModelName: "GPT-5.4 mini",
      extraActiveCount: 0,
      activeCount: 1,
      pausedCount: 0,
    }),
    "GPT-5.4 mini selected. 1 active model total. Open model picker."
  );
});

test("paused panels are announced separately from the active total", () => {
  const en = chatModelSummaryCopy.en.accessibleName({
    primaryModelName: "GPT-5.4 mini",
    extraActiveCount: 1,
    activeCount: 2,
    pausedCount: 1,
  });
  assert.ok(en.includes("2 active models total"));
  assert.ok(en.includes("1 model paused"));

  const ko = chatModelSummaryCopy.ko.accessibleName({
    primaryModelName: "GPT-5.4 mini",
    extraActiveCount: 1,
    activeCount: 2,
    pausedCount: 1,
  });
  assert.ok(ko.includes("활성 모델 총 2개"));
  assert.ok(ko.includes("일시정지 1개"));
});
