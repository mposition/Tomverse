import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { promotionNotices } from "../lib/providerModelDocsCore.ts";
import {
  docPriceCell,
  readModelPageFacts,
  docTokenCell,
  genericModelFromDocs,
  isNotFoundDocument,
  markdownTables,
  modelPageNoticeAppliesTo,
  readPricingRows,
} from "../lib/providerModelDocTables.ts";

// The documents are the bytes the providers served on 2026-09-21, saved as
// they arrived. A parser tested only against a document this repository wrote
// proves that the two agree with each other.
import { PROVIDER_MODEL_DOC_SOURCES } from "../lib/providerModelDocSources.ts";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures", "providerModelDocs", name),
    "utf8"
  );

const ZHIPU_PRICING = fixture("zhipu-pricing-2026-09-21.md");
const ZHIPU_GLM_53 = fixture("zhipu-model-glm-5.3-2026-09-21.md");
// The price table moved to its own page when xAI moved its docs under
// /developers/ on or before 2026-09-22; the old path answers 308 and this
// collector refuses redirects.
const XAI_PRICING = fixture("xai-pricing-2026-09-22.md");
const GROQ_MODELS = fixture("groq-models-2026-09-21.md");

// The fixtures are read the way production reads them, through each
// provider's recorded table shape. Leaving expectedHeaders out here would have
// meant the three pinned providers never exercised the contract that decides
// whether their tables are read at all.
const contractFor = (pricing: string | null | undefined) => {
  if (pricing === undefined || pricing === ZHIPU_PRICING) {
    return PROVIDER_MODEL_DOC_SOURCES.zhipu?.expectedPriceHeaders;
  }
  if (pricing === XAI_PRICING) return PROVIDER_MODEL_DOC_SOURCES.xai?.expectedPriceHeaders;
  if (pricing === GROQ_MODELS) return PROVIDER_MODEL_DOC_SOURCES.groq?.expectedPriceHeaders;
  return undefined;
};

const read = (input: {
  apiModel: string;
  pricing?: string | null;
  modelPage?: string | null;
  shape?: "columns" | "combined";
}) =>
  genericModelFromDocs({
    apiModel: input.apiModel,
    pricingMarkdown: input.pricing === undefined ? ZHIPU_PRICING : input.pricing,
    modelPageMarkdown: input.modelPage ?? null,
    shape: input.shape ?? "columns",
    expectedHeaders: contractFor(input.pricing),
  });

test("a three-letter sibling is still named, and a selective reference is not one subject", () => {
  const split =
    "# GLM-4.5-Air/AirX\n\nAir supports a 128K-token context window, while AirX supports 1M tokens.\n";
  assert.equal(readModelPageFacts("glm-4.5-air", split).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-4.5-airx", split).contextWindowTokens, null);
  const together = "# GLM-4.5-Air/AirX\n\nAir and AirX support a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-4.5-air", together).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-4.5-airx", together).contextWindowTokens, 1_000_000);
  const latter =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are multimodal models, and the latter supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", latter).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", latter).contextWindowTokens, null);
  const faster =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are multimodal models, and the faster model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", faster).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", faster).contextWindowTokens, null);
  const firstToken =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support a 1M-token context window, and the first token arrives in under 200 ms.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", firstToken).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.3-flashx", firstToken).contextWindowTokens, 1_000_000);
  const second =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are multimodal models, and the second supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", second).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", second).contextWindowTokens, null);
  const shortSecond =
    "# GLM-5.3-Flash/FlashX\n\nFlash and FlashX are multimodal, and the second supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", shortSecond).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", shortSecond).contextWindowTokens, null);
  const noComma =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are multimodal and the second supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", noComma).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", noComma).contextWindowTokens, null);
  const attention =
    "# GLM-5.3-Flash/FlashX\n\nWith flash attention and a sparse KV cache, the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", attention).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", attention).contextWindowTokens, null);
  const images =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are generally available, and the second accepts images.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", images).imageInput, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", images).imageInput, null);
  const sameWindow =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support the same 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", sameWindow).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.3-flashx", sameWindow).contextWindowTokens, 1_000_000);
  const predecessor =
    "# GLM-5.3-Flash\n\nWhere the previous generation offered a 128K-token context window, GLM-5.3-Flash offers a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", predecessor).contextWindowTokens, null);
  const earlierWindow =
    "# GLM-5.3-Flash\n\nWhere the previous generation offered a 128K-token context window, GLM-5.3-Flash offers a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", earlierWindow).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flash", earlierWindow).maxOutputTokens, 64_000);
  const earlierModality =
    "# GLM-5.4\n\nUnlike the previous generation, which accepted text-only input, GLM-5.4 accepts image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", earlierModality).imageInput, true);
  const laterWindow =
    "# GLM-5.3-Flash\n\nGLM-5.3-Flash offers a maximum output length of 64K tokens, whereas the previous\ngeneration offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", laterWindow).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flash", laterWindow).maxOutputTokens, 64_000);
  const laterModality =
    "# GLM-5.4\n\nGLM-5.4 is a multimodal model, whereas the previous generation accepted text-only input.\n";
  assert.equal(readModelPageFacts("glm-5.4", laterModality).imageInput, null);
  const splitGeneration =
    "# GLM-5.3-Flash\n\nThe previous generation offered a 128K-token context window.\n\nGLM-5.3-Flash offers a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", splitGeneration).contextWindowTokens, 1_000_000);
  const deepHeading =
    "### GLM-5.3-Flash\n\nWhere the previous generation offered a 128K-token context window, GLM-5.3-Flash offers a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", deepHeading).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flash", deepHeading).maxOutputTokens, 64_000);
  const disagreed =
    "# GLM-5.3-Flash\n\nA footnote mentions a 128K-token context window.\n\nGLM-5.3-Flash offers a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", disagreed).contextWindowTokens, 1_000_000);
  const namedDisagreement =
    "# GLM-5.3-Flash\n\nGLM-5.3-Flash supports a 128K-token context window.\n\nGLM-5.3-Flash offers a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", namedDisagreement).contextWindowTokens, null);
  const plural =
    "# GLM-5.4\n\nGLM-5.4 offers a maximum output length of 200K tokens, whereas earlier models offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", plural).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.4", plural).maxOutputTokens, 200_000);
  const pluralModality =
    "# GLM-5.4\n\nGLM-5.4 is a multimodal model, whereas earlier models accepted text-only input.\n";
  assert.equal(readModelPageFacts("glm-5.4", pluralModality).imageInput, null);
  const whose =
    "# GLM-5.4\n\nGLM-5.4, whose predecessor supported a 128K-token context window, delivers stronger coding.\n";
  assert.equal(readModelPageFacts("glm-5.4", whose).contextWindowTokens, null);
  const thanTail =
    "# GLM-5.4\n\nGLM-5.4 offers a larger 1M-token context window than the previous generation.\n";
  assert.equal(readModelPageFacts("glm-5.4", thanTail).contextWindowTokens, 1_000_000);
  const predecessorTail =
    "# GLM-5.3-Flash\n\nGLM-5.3-Flash supports a 1M-token context window and a larger vocabulary than its predecessor.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", predecessorTail).contextWindowTokens, 1_000_000);
  const offered =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX are multimodal models, and the second offered a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-flash", offered).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.3-flashx", offered).contextWindowTokens, null);
  const older =
    "# GLM-5.4\n\nGLM-5.4 offers a maximum output length of 200K tokens, whereas older models offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", older).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.4", older).maxOutputTokens, 200_000);
  const hyphenGeneration =
    "# GLM-5.4\n\nGLM-5.4 is a multimodal model, whereas previous-generation models accepted text-only input.\n";
  assert.equal(readModelPageFacts("glm-5.4", hyphenGeneration).imageInput, null);
  const leadingWith =
    "# GLM-5.4\n\nWith the previous generation, developers were limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", leadingWith).contextWindowTokens, null);
  const leadingIn =
    "# GLM-5.4\n\nIn the previous generation, models were limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", leadingIn).contextWindowTokens, null);
  const inserted =
    "# GLM-5.4\n\nGLM-5.4 offers a 1M-token context window, whereas earlier models, released in 2025, offered a maximum output length of 128K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", inserted).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", inserted).maxOutputTokens, null);
  const colonLead =
    "# GLM-5.4\n\nGLM-5.4 lifts that ceiling: with the previous generation, developers were limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", colonLead).contextWindowTokens, null);
  const olderUnnamed =
    "# GLM-5.4\n\nWith older models, developers were limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", olderUnnamed).contextWindowTokens, null);
  const overQuantity =
    "# GLM-5.4\n\nGLM-5.4 was trained on over 20T tokens and supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", overQuantity).contextWindowTokens, 1_000_000);
  const thanQuantity =
    "# GLM-5.4\n\nGLM-5.4 accepts more than 200 tool definitions per request and supports a maximum output length of 128K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", thanQuantity).maxOutputTokens, 128_000);
  const whileOwn =
    "# GLM-5.4\n\nWhile GLM-5.4 supports a 1M-token context window, output is capped at 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", whileOwn).contextWindowTokens, 1_000_000);
  const whileOlder =
    "# GLM-5.4\n\nGLM-5.4 offers a maximum output length of 200K tokens, while older models offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", whileOlder).contextWindowTokens, null);
  assert.equal(readModelPageFacts("glm-5.4", whileOlder).maxOutputTokens, 200_000);
  const whileOlderModality =
    "# GLM-5.4\n\nGLM-5.4 is a multimodal model, while older models accepted text-only input.\n";
  assert.equal(readModelPageFacts("glm-5.4", whileOlderModality).imageInput, null);
  const overOlder =
    "# GLM-5.4\n\nGLM-5.4 doubles the context window over older models, which offered a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", overOlder).maxOutputTokens, null);
  const asideContext =
    "# GLM-5.4\n\nGLM-5.4, unlike the previous generation, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideContext).contextWindowTokens, 1_000_000);
  const asidePredecessor =
    "# GLM-5.4\n\nGLM-5.4, whose predecessor was limited to 64K, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asidePredecessor).contextWindowTokens, 1_000_000);
  const asideImage =
    "# GLM-5.4\n\nGLM-5.4, unlike the previous generation, accepts image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideImage).imageInput, true);
  const asideWhich =
    "# GLM-5.4\n\nGLM-5.4, unlike the previous generation, which offered a maximum output length of 64K tokens, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideWhich).maxOutputTokens, null);
  assert.equal(readModelPageFacts("glm-5.4", asideWhich).contextWindowTokens, 1_000_000);
  const asideWhichModality =
    "# GLM-5.4\n\nGLM-5.4, unlike the previous generation, which accepted text-only input, is multimodal.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideWhichModality).imageInput, null);
  const compatible =
    "# GLM-5.4\n\nGLM-5.4 is fully backward compatible with older models and supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", compatible).contextWindowTokens, 1_000_000);
  const replaces =
    "# GLM-5.4\n\nGLM-5.4 replaces the previous generation and supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", replaces).contextWindowTokens, 1_000_000);
  const firstTo =
    "# GLM-5.4\n\nGLM-5.4 is the first generation to support a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", firstTo).contextWindowTokens, 1_000_000);
  const generationModels =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling, while previous generation models offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", generationModels).contextWindowTokens, null);
  const hyphenModels =
    "# GLM-5.4\n\nGLM-5.4 is a multimodal model, while previous-generation models accepted text-only input.\n";
  assert.equal(readModelPageFacts("glm-5.4", hyphenModels).imageInput, null);
  const leadingOn =
    "# GLM-5.4\n\nOn the previous generation, the model was limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", leadingOn).contextWindowTokens, null);
  const noteThat =
    "# GLM-5.4\n\nNote that with the previous generation, the model was limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", noteThat).contextWindowTokens, null);
  const generationObject =
    "# GLM-5.4\n\nGLM-5.4 is fully backward compatible with previous generation models and supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", generationObject).contextWindowTokens, 1_000_000);
  const lastGeneration =
    "# GLM-5.4\n\nOn the last generation, the model was limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", lastGeneration).contextWindowTokens, null);
  const thePredecessor =
    "# GLM-5.4\n\nNote that on the predecessor, the model was limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", thePredecessor).contextWindowTokens, null);
  const flagship =
    "# GLM-5.4\n\nOn the previous flagship, the model was limited to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", flagship).contextWindowTokens, null);
  const comparedVoice =
    "# GLM-5.4\n\nCompared with the previous generation, this model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", comparedVoice).contextWindowTokens, 1_000_000);
  const comparedThe =
    "# GLM-5.4\n\nCompared with the previous generation, the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", comparedThe).contextWindowTokens, 1_000_000);
  const movingOff =
    "# GLM-5.4\n\nFor teams moving off previous generation models, this model accepts image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", movingOff).imageInput, true);
  const andNow =
    "# GLM-5.4\n\nGLM-5.4 is fully backward compatible with previous generation models and now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", andNow).contextWindowTokens, 1_000_000);
  const butSupports =
    "# GLM-5.4\n\nGLM-5.4 replaces the previous generation but supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", butSupports).contextWindowTokens, 1_000_000);
  const restricted =
    "# GLM-5.4\n\nOn the previous generation, the model is restricted to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", restricted).contextWindowTokens, null);
  const capped =
    "# GLM-5.4\n\nWith the previous generation, the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", capped).contextWindowTokens, null);
  const tightFrame =
    "# GLM-5.4\n\nWith the previous generation—the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightFrame).contextWindowTokens, null);
  const tightFrameAside =
    "# GLM-5.4\n\nWith the previous generation—now deprecated—the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightFrameAside).contextWindowTokens, null);
  const availableOnly =
    "# GLM-5.4\n\nIn the previous generation, the model is available only with a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", availableOnly).contextWindowTokens, null);
  const voiceAside =
    "# GLM-5.4\n\nThe model, unlike the previous generation, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", voiceAside).contextWindowTokens, 1_000_000);
  const voicePredecessor =
    "# GLM-5.4\n\nThe model, unlike its predecessor, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", voicePredecessor).contextWindowTokens, 1_000_000);
  const however =
    "# GLM-5.4\n\nHowever, with the previous generation, the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", however).contextWindowTokens, null);
  const howeverImage =
    "# GLM-5.4\n\nHowever, with the previous generation, the model accepts image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", howeverImage).imageInput, null);
  const olderModels =
    "# GLM-5.4\n\nWith older models, the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", olderModels).contextWindowTokens, null);
  const previousModels =
    "# GLM-5.4\n\nOn previous models, the model is restricted to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", previousModels).contextWindowTokens, null);
  const thisRelease =
    "# GLM-5.4\n\nIn this release, the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", thisRelease).contextWindowTokens, 1_000_000);
  const latestVersion =
    "# GLM-5.4\n\nIn the latest version, the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", latestVersion).contextWindowTokens, 1_000_000);
  const latestRelease =
    "# GLM-5.4\n\nWith the latest release, the model now supports image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", latestRelease).imageInput, true);
  const bareFrame =
    "# GLM-5.4\n\nOn the previous generation the model is restricted to a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", bareFrame).contextWindowTokens, null);
  const across =
    "# GLM-5.4\n\nAcross previous releases, the model has a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", across).contextWindowTokens, null);
  const previously =
    "# GLM-5.4\n\nPreviously, the model supported a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", previously).contextWindowTokens, null);
  const shipped =
    "# GLM-5.4\n\nPreviously, the model shipped with a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", shipped).contextWindowTokens, null);
  const formerly =
    "# GLM-5.4\n\nFormerly, the model delivered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", formerly).contextWindowTokens, null);
  const namedShipped =
    "# GLM-5.4\n\nPreviously, GLM-5.4 shipped with a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", namedShipped).contextWindowTokens, null);
  const namedOffered =
    "# GLM-5.4\n\nGLM-5.4 offered a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", namedOffered).contextWindowTokens, null);
  const grokOffered =
    "# Grok 4.7\n\nPreviously, Grok 4.7 offered a 256K-token context window.\n";
  assert.equal(readModelPageFacts("grok-4.7", grokOffered).contextWindowTokens, null);
  const currentThenPast =
    "# GLM-5.4\n\nThe model supports a 1M-token context window; previously, it supported 128K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", currentThenPast).contextWindowTokens, 1_000_000);
  const untilNotice =
    "# GLM-5.4\n\nUntil further notice, the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", untilNotice).contextWindowTokens, 1_000_000);
  const previouslyUnavailable =
    "# GLM-5.4\n\nPreviously unavailable in the EU, the model supports a 1M-token context window.\n";
  assert.equal(
    readModelPageFacts("glm-5.4", previouslyUnavailable).contextWindowTokens,
    1_000_000
  );
  const pastOutput =
    "# GLM-5.4\n\nGLM-5.4 was limited to a maximum output length of 64K tokens and now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", pastOutput).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", pastOutput).maxOutputTokens, null);
  const pastModality =
    "# GLM-5.4\n\nGLM-5.4 accepted text-only input and now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", pastModality).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", pastModality).imageInput, null);
  const asidePastOutput =
    "# GLM-5.4\n\nGLM-5.4, which previously had a maximum output length of 64K tokens, now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asidePastOutput).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", asidePastOutput).maxOutputTokens, null);
  const asidePastModality =
    "# GLM-5.4\n\nGLM-5.4, which previously accepted text-only input, now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asidePastModality).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", asidePastModality).imageInput, null);
  const parenOutput =
    "# GLM-5.4\n\nGLM-5.4 (previously limited to a maximum output length of 64K tokens) now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", parenOutput).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", parenOutput).maxOutputTokens, null);
  const parenModality =
    "# GLM-5.4\n\nGLM-5.4 (previously a text-only input model) supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", parenModality).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", parenModality).imageInput, null);
  const asideCurrent =
    "# GLM-5.4\n\nGLM-5.4, which is used for agentic workflows and supports a 1M-token context window, is available on the Open Platform.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideCurrent).contextWindowTokens, 1_000_000);
  const asideReleased =
    "# GLM-5.4\n\nGLM-5.4, which was released on 2026-09-01 and supports a 1M-token context window, is generally available.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideReleased).contextWindowTokens, 1_000_000);
  const dashPast =
    "# GLM-5.4\n\nGLM-5.4 — the first agentic release — offered a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", dashPast).maxOutputTokens, null);
  const dashVoice =
    "# GLM-5.4\n\nThe model — unlike the previous generation — supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", dashVoice).contextWindowTokens, 1_000_000);
  const tightPast =
    "# GLM-5.4\n\nGLM-5.4—the first agentic release—offered a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightPast).maxOutputTokens, null);
  const tightVoicePast =
    "# GLM-5.4\n\nThe model—the first agentic release—offered a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightVoicePast).maxOutputTokens, null);
  const tightVoice =
    "# GLM-5.4\n\nThe model—unlike the previous generation—supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightVoice).contextWindowTokens, 1_000_000);
  const hyphenPast =
    "# GLM-5.4\n\nGLM-5.4 - the first agentic release - offered a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", hyphenPast).maxOutputTokens, null);
  const hyphenCurrent =
    "# GLM-5.4\n\nGLM-5.4 - unlike the previous generation - supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", hyphenCurrent).contextWindowTokens, 1_000_000);
  const bulletTiers =
    "# GLM-5.4\n\n- glm-5.4 - has a 1M-token context window\n- the Air tier - has a maximum output length of 64K tokens\n";
  assert.equal(readModelPageFacts("glm-5.4", bulletTiers).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", bulletTiers).maxOutputTokens, null);
  const dottedOther =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling, while the 4.6 model supports a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", dottedOther).contextWindowTokens, null);
  const dashBullets =
    "# GLM-5.4\n\n- glm-5.4 — has a 1M-token context window\n- the Air tier — has a maximum output length of 64K tokens\n";
  assert.equal(readModelPageFacts("glm-5.4", dashBullets).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", dashBullets).maxOutputTokens, null);
  const adverbBullet =
    "# GLM-5.4\n\n- glm-5.4 - has a 1M-token context window\n- the Air tier - now has a maximum output length of 64K tokens\n";
  assert.equal(readModelPageFacts("glm-5.4", adverbBullet).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", adverbBullet).maxOutputTokens, null);
  const bareIdBullet =
    "# GLM-5.4\n\n- glm-5.4\n- the Air tier - has a maximum output length of 64K tokens\n";
  assert.equal(readModelPageFacts("glm-5.4", bareIdBullet).maxOutputTokens, null);
  const proseDash =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier — has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", proseDash).maxOutputTokens, null);
  const proseAdverb =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier - now has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", proseAdverb).maxOutputTokens, null);
  const asideNow =
    "# GLM-5.4\n\nGLM-5.4 — unlike the previous generation — now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideNow).contextWindowTokens, 1_000_000);
  const asideNowImage =
    "# GLM-5.4\n\nGLM-5.4 - unlike the previous generation - now accepts image input.\n";
  assert.equal(readModelPageFacts("glm-5.4", asideNowImage).imageInput, true);
  const commaTier =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier, however, has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", commaTier).maxOutputTokens, null);
  const nestedTier =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier — a cheaper SKU — has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", nestedTier).maxOutputTokens, null);
  const tightSku =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier—a cheaper SKU—has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", tightSku).maxOutputTokens, null);
  const parenSku =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier (a cheaper SKU) has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", parenSku).maxOutputTokens, null);
  const longComma =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier, which is priced lower and aimed at high-volume workloads, has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", longComma).maxOutputTokens, null);
  const ownHowever =
    "# GLM-5.4\n\nGLM-5.4, the flagship model, however, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", ownHowever).contextWindowTokens, 1_000_000);
  const ownHoweverNow =
    "# GLM-5.4\n\nGLM-5.4, the flagship model, however, now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", ownHoweverNow).contextWindowTokens, 1_000_000);
  const ownRegions =
    "# GLM-5.4\n\nGLM-5.4, the previous flagship's successor, in most regions, supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", ownRegions).contextWindowTokens, 1_000_000);
  const ownAndOther =
    "# GLM-5.4\n\nGLM-5.4, the flagship model, supports a 1M-token context window, while the Air tier, however, has a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", ownAndOther).contextWindowTokens, 1_000_000);
  assert.equal(readModelPageFacts("glm-5.4", ownAndOther).maxOutputTokens, null);
  const whichInside =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier, which has a maximum output length of 64K tokens, costs less.\n";
  assert.equal(readModelPageFacts("glm-5.4", whichInside).maxOutputTokens, null);
  const whichContext =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier, which has a 128K-token context window, costs less.\n";
  assert.equal(readModelPageFacts("glm-5.4", whichContext).contextWindowTokens, null);
  const whichUses =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier, which has a maximum output length of 64K tokens, uses the same tokenizer.\n";
  assert.equal(readModelPageFacts("glm-5.4", whichUses).maxOutputTokens, null);
  const whichDash =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier—which has a maximum output length of 64K tokens—costs less.\n";
  assert.equal(readModelPageFacts("glm-5.4", whichDash).maxOutputTokens, null);
  const whichParen =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier (which has a maximum output length of 64K tokens) costs less.\n";
  assert.equal(readModelPageFacts("glm-5.4", whichParen).maxOutputTokens, null);
  const isLimited =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier is limited to a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", isLimited).maxOutputTokens, null);
  const delivers =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier delivers a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", delivers).maxOutputTokens, null);
  const shipsWith =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier ships with a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", shipsWith).maxOutputTokens, null);
  const topsOut =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier tops out at a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", topsOut).maxOutputTokens, null);
  const keepsWindow =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier keeps a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", keepsWindow).contextWindowTokens, null);
  const allowsOutput =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier allows a maximum output length of 64K tokens.\n";
  assert.equal(readModelPageFacts("glm-5.4", allowsOutput).maxOutputTokens, null);
  const retainsWindow =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling while the Air tier retains a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", retainsWindow).contextWindowTokens, null);
  const namedWhich =
    "# GLM-5.4\n\nThe GLM-5.4 model, which supports a 1M-token context window, is generally available.\n";
  assert.equal(readModelPageFacts("glm-5.4", namedWhich).contextWindowTokens, 1_000_000);
  const namedWhichImage =
    "# GLM-5.4\n\nThe GLM-5.4 model, which accepts image input, is generally available.\n";
  assert.equal(readModelPageFacts("glm-5.4", namedWhichImage).imageInput, true);
  const appositiveWhich =
    "# GLM-5.4\n\nGLM-5.4, the flagship model, which supports a 1M-token context window, is generally available.\n";
  assert.equal(readModelPageFacts("glm-5.4", appositiveWhich).contextWindowTokens, 1_000_000);
  const thatIs =
    "# GLM-5.4\n\nGLM-5.4 is a flagship model that is tuned for agentic work and supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", thatIs).contextWindowTokens, 1_000_000);
  const objectDeterminer =
    "# GLM-5.4\n\nGLM-5.4 supports the largest context window of any model: a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", objectDeterminer).contextWindowTokens, 1_000_000);
  const prepositionWhich =
    "# GLM-5.3\n\nGLM-5.3, a step up from the Air tier, which supports a 128K-token context window, is now generally available.\n";
  assert.equal(readModelPageFacts("glm-5.3", prepositionWhich).contextWindowTokens, null);
  const prepositionPlain =
    "# GLM-5.3\n\nGLM-5.3 is a step up from the Air tier, which supports a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", prepositionPlain).contextWindowTokens, null);
  const airFromFlagship =
    "# GLM-5.3-Air\n\nGLM-5.3-Air, a lower-cost version of the flagship tier, which supports a 1M-token context window, is now generally available.\n";
  assert.equal(readModelPageFacts("glm-5.3-air", airFromFlagship).contextWindowTokens, null);
  const spacedSibling =
    "# GLM-5.3\n\nGLM-5.3 raises the ceiling while the GLM-5.3 Air tier keeps a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", spacedSibling).contextWindowTokens, null);
  const andKeeps =
    "# GLM-5.3\n\nGLM-5.3 raises the ceiling, and the Air tier keeps a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", andKeeps).contextWindowTokens, null);
  const itsTier =
    "# GLM-5.3\n\nGLM-5.3 raises the ceiling while its Air tier keeps a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", itsTier).contextWindowTokens, null);
  const ourFlagship =
    "# GLM-5.3-Air\n\nGLM-5.3-Air, a lower-cost version of our flagship tier, which supports a 1M-token context window, is now generally available.\n";
  assert.equal(readModelPageFacts("glm-5.3-air", ourFlagship).contextWindowTokens, null);
  const possessiveFlagship =
    "# GLM-5.3-Air\n\nGLM-5.3-Air, a lower-cost version of Zhipu's flagship tier, which supports a 1M-token context window, is now generally available.\n";
  assert.equal(readModelPageFacts("glm-5.3-air", possessiveFlagship).contextWindowTokens, null);
  const underTier =
    "# GLM-5.3-Air\n\nGLM-5.3-Air, a lower-cost model under the flagship tier, which supports a 1M-token context window, is now generally available.\n";
  assert.equal(readModelPageFacts("glm-5.3-air", underTier).contextWindowTokens, null);
  const andTheModel =
    "# GLM-5.4\n\nGLM-5.4 is now generally available, and the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", andTheModel).contextWindowTokens, 1_000_000);
  const colonTheModel =
    "# GLM-5.4\n\nGLM-5.4 raises the ceiling: the model supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", colonTheModel).contextWindowTokens, 1_000_000);
  const unnamedAir =
    "# GLM-5.3\n\nThe model is available in two tiers, and the Air tier supports a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", unnamedAir).contextWindowTokens, null);
  const modelPossessive =
    "# GLM-5.3\n\nGLM-5.3 raises the ceiling, and the model's Air variant supports a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", modelPossessive).contextWindowTokens, null);
  const modelsInLine =
    "# GLM-5.3\n\nGLM-5.3 raises the ceiling, and the models in the Air line keep a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", modelsInLine).contextWindowTokens, null);
  const possessiveOnly =
    "# GLM-5.3\n\nThe model's Air variant supports a 128K-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3", possessiveOnly).contextWindowTokens, null);
  const modelInLine =
    "# GLM-5.3-Air\n\nThe model in the Air line is the cheaper tier, and the flagship tier supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.3-air", modelInLine).contextWindowTokens, null);
  const modelNow =
    "# GLM-5.4\n\nGLM-5.4 is now generally available, and the model now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", modelNow).contextWindowTokens, 1_000_000);
  const unnamedNow =
    "# GLM-5.4\n\nThe model now supports a 1M-token context window.\n";
  assert.equal(readModelPageFacts("glm-5.4", unnamedNow).contextWindowTokens, 1_000_000);
});

test("a price cell is a number only when the document says what it is", () => {
  // The unit and the currency have to be stated -- by the cell, its heading,
  // or the table it sits in. A bare number that looks like a price is the
  // shape a euro column and a per-1K column both have.
  const stated = { usd: true, perMillion: true };
  assert.deepEqual(docPriceCell("$1.40", "", stated), { kind: "usd", value: 1.4 });
  assert.deepEqual(docPriceCell("1,200", "Input (USD) / 1M tokens"), {
    kind: "usd",
    value: 1200,
  });
  assert.equal(docPriceCell("$1.40").kind, "unreadable");
  assert.equal(docPriceCell("1,200", "Input", stated).kind, "usd");
  assert.equal(docPriceCell("0.15", "Input (EUR) / 1M tokens").kind, "unreadable");
  assert.equal(docPriceCell("$0.15", "Input / 1K tokens").kind, "unreadable");
  assert.equal(docPriceCell("A$2.00", "Input / 1M tokens").kind, "unreadable");
  // Free is a commercial state that ends. Read as zero it would make a model
  // look costless to every credit calculation downstream.
  assert.equal(docPriceCell("Free", "", stated).kind, "unreadable");
  assert.equal(docPriceCell("Limited-time Free", "", stated).kind, "unreadable");
  assert.equal(docPriceCell("ContactSales", "", stated).kind, "unreadable");
  assert.equal((docPriceCell("¥12", "", stated) as { reason: string }).reason, "not_usd");
});

test("a token cell reads the units a provider writes", () => {
  assert.equal(docTokenCell("131,072"), 131_072);
  assert.equal(docTokenCell("500k"), 500_000);
  assert.equal(docTokenCell("1M"), 1_000_000);
  assert.equal(docTokenCell("128K tokens"), 128_000);
  assert.equal(docTokenCell("—"), null);
});

test("a 200 response carrying a not-found page is not a document", () => {
  assert.equal(isNotFoundDocument("# 404 - Page Not Found\n\nNope."), true);
  assert.equal(isNotFoundDocument(ZHIPU_PRICING), false);
});

test("Zhipu's own pricing table answers for each model separately", () => {
  const base = read({ apiModel: "glm-5.3", modelPage: ZHIPU_GLM_53 });
  assert.equal(base.status, "parsed");
  assert.equal(base.fields?.inputUsdPerMillionTokens, 1.4);
  assert.equal(base.fields?.outputUsdPerMillionTokens, 4.4);
  // From the model page, which the pricing table does not carry.
  assert.equal(base.fields?.contextWindowTokens, 1_000_000);
  assert.equal(base.fields?.maxOutputTokens, 128_000);
  assert.equal(base.fields?.imageInput, false);
  assert.deepEqual(base.problems, []);

  const flash = read({ apiModel: "glm-5.3-flash" });
  assert.equal(flash.fields?.inputUsdPerMillionTokens, 0.15);
  assert.equal(flash.fields?.outputUsdPerMillionTokens, 0.5);

  const flashx = read({ apiModel: "glm-5.3-flashx" });
  assert.equal(flashx.fields?.inputUsdPerMillionTokens, 0.37);
  assert.equal(flashx.fields?.outputUsdPerMillionTokens, 1.25);
});

test("Zhipu's shared Flash page is the page both SKUs are named on", () => {
  const sources = PROVIDER_MODEL_DOC_SOURCES.zhipu;
  assert.equal(
    sources?.modelPageUrl?.("glm-5.3-flash"),
    "https://docs.z.ai/guides/vlm/glm-5.3-flash.md"
  );
  assert.equal(
    sources?.modelPageUrl?.("ZHIPU/GLM-5.3-FlashX"),
    "https://docs.z.ai/guides/vlm/glm-5.3-flash.md"
  );
  assert.equal(
    sources?.modelPageUrl?.("glm-5.3"),
    "https://docs.z.ai/guides/llm/glm-5.3.md"
  );
  const shared = "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash has a 1M-token context window.\n";
  const flash = read({ apiModel: "glm-5.3-flash", modelPage: shared });
  const flashx = read({ apiModel: "glm-5.3-flashx", modelPage: shared });
  assert.equal(flash.problems.includes("model_page_names_other_model"), false);
  assert.equal(flashx.problems.includes("model_page_names_other_model"), false);
  assert.equal(flash.fields?.contextWindowTokens, 1_000_000);
  // The only context sentence names Flash, so it does not answer for FlashX.
  assert.equal(flashx.fields?.contextWindowTokens, null);
  // A sentence that names neither SKU is not a fact about both of them.
  const unnamed =
    "# GLM-5.3-Flash/FlashX\n\nIt supports a 128K-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: unnamed }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: unnamed }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    readModelPageFacts(
      "vendor-a/target-1",
      "# vendor-b/target-1\n\nIt has a 128K-token context window.\n"
    ).namesModel,
    false
  );
  const both =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: both }).fields?.contextWindowTokens,
    128_000
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: both }).fields?.contextWindowTokens,
    128_000
  );
  const contrast =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash has a 128K-token context window and GLM-5.3-FlashX has a 1M-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: contrast }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: contrast }).fields?.contextWindowTokens,
    null
  );
  const uneven =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash supports a 128K-token context window, while GLM-5.3-FlashX supports 1M tokens.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: uneven }).fields?.contextWindowTokens,
    null
  );
  const crossed =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash has a 128K-token context window and GLM-5.3-FlashX has a maximum output length of 64K tokens.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: crossed }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: crossed }).fields?.maxOutputTokens,
    null
  );
  const respectively =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support 128K- and 1M-token context windows, respectively.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: respectively }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: respectively }).fields?.contextWindowTokens,
    null
  );
  const compared =
    "# GLM-5.3-Flash/FlashX\n\nCompared with GLM-5.3-Flash, GLM-5.3-FlashX supports a 1M-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: compared }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: compared }).fields?.contextWindowTokens,
    null
  );
  for (const lead of [
    "Compared to",
    "In addition to",
    "In contrast to",
    "Relative to",
    "As opposed to",
    "Similar to",
  ]) {
    const page = `# GLM-5.3-Flash/FlashX\n\n${lead} GLM-5.3-Flash, GLM-5.3-FlashX supports a 1M-token context window.\n`;
    assert.equal(
      read({ apiModel: "glm-5.3-flash", modelPage: page }).fields?.contextWindowTokens,
      null,
      lead
    );
    assert.equal(
      read({ apiModel: "glm-5.3-flashx", modelPage: page }).fields?.contextWindowTokens,
      null,
      lead
    );
  }
  const digits =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support 128,000- and 1,000,000-token context windows, respectively.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: digits }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: digits }).fields?.contextWindowTokens,
    null
  );
  const digitsAnd =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX support 128,000 and 1,000,000-token context windows.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: digitsAnd }).fields?.contextWindowTokens,
    null
  );
  const shortName =
    "# GLM-5.3-Flash/FlashX\n\nFlashX supports a 1M-token context window, unlike GLM-5.3-Flash.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: shortName }).fields?.contextWindowTokens,
    null
  );
  assert.equal(
    read({ apiModel: "glm-5.3-flashx", modelPage: shortName }).fields?.contextWindowTokens,
    null
  );
  for (const line of [
    "* GLM-5.3-Flash and GLM-5.3-FlashX support a 1M-token context window.",
    "**GLM-5.3-Flash and GLM-5.3-FlashX** support a 1M-token context window.",
    "**GLM-5.3-Flash** and **GLM-5.3-FlashX** support a 1M-token context window.",
    "`glm-5.3-flash` and `glm-5.3-flashx` support a 1M-token context window.",
    "[GLM-5.3-Flash](/vlm/flash) and [GLM-5.3-FlashX](/vlm/flashx) support a 1M-token context window.",
  ]) {
    const page = `# GLM-5.3-Flash/FlashX\n\n${line}\n`;
    assert.equal(
      read({ apiModel: "glm-5.3-flash", modelPage: page }).fields?.contextWindowTokens,
      1_000_000,
      line
    );
  }
  const bothFacts =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3-FlashX currently support text-only inputs, with a 1M-token context window and a maximum output length of 128K tokens.\n";
  for (const id of ["glm-5.3-flash", "glm-5.3-flashx"]) {
    const facts = read({ apiModel: id, modelPage: bothFacts }).fields;
    assert.equal(facts?.contextWindowTokens, 1_000_000, id);
    assert.equal(facts?.maxOutputTokens, 128_000, id);
    assert.equal(facts?.imageInput, false, id);
  }
  const withBase =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-Flash and GLM-5.3 support a 1M-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3-flash", modelPage: withBase }).fields?.contextWindowTokens,
    null
  );
  // The page docs.z.ai served on 2026-09-22. The 1M sentence also names
  // GLM-5.3, and the 1M / 128K figures in the cards are not sentences.
  const live = [
    "# GLM-5.3-Flash/FlashX",
    "",
    "**GLM-5.3-Flash/GLM-5.3-FlashX** is the first native multimodal model in the GLM-5 series.",
    "",
    "* **Model Code**：`glm-5.3-flash`/`glm-5.3-flashx`",
    "* **Parameter Settings**：Text parameters are consistent with GLM-5.3, with support for a 1M-token context window.",
    "",
  ].join("\n");
  for (const id of ["glm-5.3-flash", "glm-5.3-flashx"]) {
    const facts = readModelPageFacts(id, live);
    assert.equal(facts.namesModel, true, id);
    assert.equal(facts.contextWindowTokens, null, id);
    assert.equal(facts.maxOutputTokens, null, id);
  }
  const flashOnly = "# GLM-5.3-Flash\n\nGLM-5.3-Flash has a 1M-token context window.\n";
  assert.equal(
    read({ apiModel: "glm-5.3", modelPage: flashOnly }).problems.includes(
      "model_page_names_other_model"
    ),
    true
  );
});

test("a base model id never answers to its own derivative's row", () => {
  // The defect this pins: with a looser boundary, `glm-5.3` matches the
  // `GLM-5.3-Flash` row as well as its own, and one of the two prices wins.
  const rows = readPricingRows(ZHIPU_PRICING, "glm-5.3", "columns");
  assert.equal(rows.matches.length, 1);
  assert.match(rows.matches[0].text, /GLM-5\.3\s*\|/);
  assert.equal(
    readPricingRows(ZHIPU_PRICING, "glm-5.3-flashx", "columns").matches.length,
    1
  );
});

test("a vendor prefix and the provider's own capitalisation are the same model", () => {
  const prefixed = read({ apiModel: "ZHIPU/GLM-5.3-Flash" });
  assert.equal(prefixed.fields?.inputUsdPerMillionTokens, 0.15);
});

test("a promotional cell withholds that number and nothing else", () => {
  // Every row of this table says "Limited-time Free" in its cached-storage
  // column. Blocking the page for it would have left Zhipu unreadable for as
  // long as the promotion runs; reading it as zero would invent a rate.
  const flash = read({ apiModel: "glm-5.3-flash" });
  assert.equal(flash.status, "parsed");
  assert.equal(flash.fields?.inputUsdPerMillionTokens, 0.15);
  assert.equal(flash.fields?.cacheWriteUsdPerMillionTokens, null);
});

test("xAI's two rows for one model are a long-context tier, not a duplicate", () => {
  const grok = read({ apiModel: "grok-4.6", pricing: XAI_PRICING });
  assert.equal(grok.status, "parsed");
  assert.equal(grok.fields?.inputUsdPerMillionTokens, 2);
  assert.equal(grok.fields?.outputUsdPerMillionTokens, 6);
  assert.equal(grok.fields?.contextWindowTokens, 500_000);
  // 199,999 rather than 200,000: the cheap row is < 200k and the profile
  // reads the threshold inclusively, so a 200,000-token prompt belongs to the
  // expensive side the provider actually charges for it.
  // The cached column scales by the same factor as input, which the table
  // states rather than this reader assuming it.
  assert.deepEqual(grok.fields?.longContext, {
    kind: "tiered",
    thresholdTokens: 199_999,
    inputMultiplier: 2,
    outputMultiplier: 2,
    cacheTakesInputMultiplier: true,
  });
});

test("Groq states the id inside a link and both prices inside one cell", () => {
  const oss = read({
    apiModel: "openai/gpt-oss-120b",
    pricing: GROQ_MODELS,
    shape: "combined",
  });
  assert.equal(oss.status, "parsed");
  assert.equal(oss.fields?.inputUsdPerMillionTokens, 0.15);
  assert.equal(oss.fields?.outputUsdPerMillionTokens, 0.6);
  assert.equal(oss.fields?.contextWindowTokens, 131_072);
  assert.equal(oss.fields?.maxOutputTokens, 65_536);

  // A model Groq does not price publicly keeps its size and says why the
  // price is missing, rather than reporting a parser fault.
  const enterprise = read({
    apiModel: "llama-3.1-8b-instant",
    pricing: GROQ_MODELS,
    shape: "combined",
  });
  assert.equal(enterprise.status, "parsed");
  assert.equal(enterprise.fields?.inputUsdPerMillionTokens, null);
  assert.equal(enterprise.fields?.contextWindowTokens, 131_072);
  assert.ok(enterprise.problems.includes("input_price:not_published"));
});

test("an id nothing prices is not found, and a page that is not a table fails", () => {
  const unknown = read({ apiModel: "glm-9.9-imaginary" });
  assert.equal(unknown.status, "not_found");
  assert.ok(unknown.problems.includes("model_row_not_found"));

  const prose = read({
    apiModel: "glm-5.3",
    pricing: "# Pricing\n\nContact us for pricing.\n",
  });
  assert.equal(prose.status, "not_found");
  assert.ok(prose.problems.includes("pricing_table_not_found"));
});

test("two untiered rows for one id are refused rather than picked between", () => {
  const duplicated = [
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $1.40 | $4.40 |",
    "| glm-5.3 | $9.90 | $9.90 |",
    "",
  ].join("\n");
  const parse = read({ apiModel: "glm-5.3", pricing: duplicated });
  assert.equal(parse.status, "parse_failed");
  assert.ok(parse.problems.includes("model_row_duplicated"));
});

test("a model page alone still establishes what it states", () => {
  const pageOnly = read({
    apiModel: "glm-5.3",
    pricing: null,
    modelPage: ZHIPU_GLM_53,
  });
  assert.equal(pageOnly.status, "parsed");
  assert.equal(pageOnly.fields?.contextWindowTokens, 1_000_000);
  assert.equal(pageOnly.fields?.inputUsdPerMillionTokens, null);
  assert.ok(pageOnly.problems.includes("pricing_document_missing"));
});

test("every table on a page is found, header first", () => {
  const tables = markdownTables(ZHIPU_PRICING);
  assert.ok(tables.length >= 2, String(tables.length));
  assert.ok(tables[0].headers.some((header) => /model/i.test(header)));
  assert.ok(tables[0].rows.length > 0);
});

test("a promotional marker inside a table is a refused cell, not a page notice", () => {
  // Zhipu writes "Limited-time Free" in the cached-storage column of every
  // row. Read as prose it asked an operator to acknowledge three table rows on
  // every collection, for a column no field is read from.
  assert.equal(promotionNotices("zhipu", ZHIPU_PRICING).unacknowledged.length, 0);
  // The prose rule is untouched: OpenAI states a promotion in a sentence and
  // that sentence still binds to the model it names.
  const openai = promotionNotices(
    "openai",
    fixture("openai-pricing-2026-09-13.md")
  );
  assert.equal(openai.unacknowledged.length, 0);
  assert.ok(openai.promoted.size >= 1);

  // A promotion announced inside a table is still announced: only the cells
  // that are values are dropped, not the row.
  const notice = [
    "| Notice | Detail |",
    "| --- | --- |",
    "| Pricing | Limited-time promotional pricing for GLM-5.3 |",
    "",
  ].join("\n");
  assert.equal(promotionNotices("zhipu", notice).unacknowledged.length, 1);
});

test("two rows that do not describe one boundary are not a tier", () => {
  const mismatched = [
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| grok-9 (< 100k prompt tokens) | $1.00 | $2.00 |",
    "| grok-9 (< 200k prompt tokens) | $3.00 | $6.00 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "grok-9",
    pricingMarkdown: mismatched,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.status, "parse_failed");
  assert.ok(parse.problems.includes("model_row_duplicated"));
});

test("a combined cell is judged before it is split", () => {
  const euro = [
    "| MODEL ID | PRICE PER 1M TOKENS | CONTEXT WINDOW (TOKENS) |",
    "| --- | --- | --- |",
    "| euro-1 | €0.15 input€0.60 output | 131,072 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "euro-1",
    pricingMarkdown: euro,
    modelPageMarkdown: null,
    shape: "combined",
  });
  assert.equal(parse.fields?.inputUsdPerMillionTokens, null);
  assert.ok(parse.problems.includes("input_price:not_usd"));

  const promoted = euro.replace("€0.15 input€0.60 output", "Limited-time $0.15 input$0.60 output");
  const promotedParse = genericModelFromDocs({
    apiModel: "euro-1",
    pricingMarkdown: promoted,
    modelPageMarkdown: null,
    shape: "combined",
  });
  assert.equal(promotedParse.fields?.inputUsdPerMillionTokens, null);
  assert.ok(promotedParse.problems.includes("input_price:promotional_or_free"));
});

test("a promotion nobody acknowledged withholds the price it applies to", () => {
  // The page says the price will end. Reported only in a run summary it would
  // reach a report an operator may not read, while the prefill offered the
  // promotional rate as if it were the list price.
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: ZHIPU_PRICING,
    modelPageMarkdown: null,
    shape: "columns",
    promotionalNotices: ["Limited-time promotional pricing for GLM-5.3."],
  });
  assert.equal(parse.status, "parsed");
  assert.equal(parse.fields?.promotional?.note, "Limited-time promotional pricing for GLM-5.3.");
  assert.ok(parse.problems.includes("page_promotional_notice"));
});

test("a cache column that says nothing is recorded as saying nothing", () => {
  const table = [
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Cached Input | Output |",
    "| --- | --- | --- | --- |",
    "| grok-9 (< 200k prompt tokens) | $2.00 | $0.20 | $6.00 |",
    "| grok-9 (>= 200k prompt tokens) | $4.00 | - | $12.00 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "grok-9",
    pricingMarkdown: table,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.status, "parsed");
  assert.ok(parse.problems.includes("long_context_cache_unstated"));
});

test("a discounted section is not the standard rate", () => {
  // A batch table prices the same model on different terms and nothing in
  // the row says so. Read as the standard rate it halves every comparison.
  const batch = [
    "## Batch pricing",
    "",
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $0.70 | $2.20 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: batch,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.status, "not_found");
  assert.ok(parse.problems.includes("pricing_table_not_standard_rate"));
});

test("a row that does not fit its header is not read", () => {
  const ragged = [
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $1.40 | $4.40 | $9.99 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: ragged,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.status, "not_found");
  assert.ok(parse.problems.includes("row_width_mismatch"));
});

test("a model page speaks only for the model it names", () => {
  // A page that opens by comparing itself with its predecessor states the
  // predecessor's numbers first.
  const comparison = [
    "# Demo 1",
    "",
    "Other-9 has a 32K-token context window and a maximum output length of 4K tokens.",
    "",
    "demo-1 has a 200K-token context window and a maximum output length of 64K tokens.",
    "",
  ].join("\n");
  const facts = readModelPageFacts("demo-1", comparison);
  assert.equal(facts.contextWindowTokens, 200_000);
  assert.equal(facts.maxOutputTokens, 64_000);

  // And a page that never names it establishes nothing for it.
  const elsewhere = [
    "# Other 9",
    "",
    "Other-9 has a 32K-token context window and a maximum output length of 4K tokens.",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "demo-1",
    pricingMarkdown: null,
    modelPageMarkdown: elsewhere,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("model_page_names_other_model"));
  assert.equal(parse.status, "not_found");
});

test("a section this reader does not recognise is not the standard rate", () => {
  // Listing only the sections to reject left every tier name a provider
  // invents -- "Priority processing", "Flex processing" -- reading as the
  // standard rate, and the next one would have been found in production.
  const priority = [
    "## Priority processing",
    "",
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $0.70 | $2.20 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: priority,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("pricing_table_not_standard_rate"));
});

test("a heading on the line after a table still belongs to the next one", () => {
  const glued = [
    "## Model pricing",
    "",
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| other-1 | $1.00 | $2.00 |",
    "## Batch pricing",
    "",
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $0.70 | $2.20 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: glued,
    modelPageMarkdown: null,
    shape: "columns",
  });
  // The batch table keeps its own heading, so the model is simply not in a
  // standard-rate table -- rather than inheriting the section above it and
  // handing over a discounted price.
  assert.equal(parse.status, "not_found");
  assert.ok(parse.problems.includes("model_row_not_found"));
});

test("a currency named above the table outranks the page", () => {
  const canada = [
    "# Pricing",
    "",
    "All prices are in USD.",
    "",
    "## Canada pricing in CAD",
    "",
    "Prices per 1M tokens.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | $1.40 | $4.40 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: canada,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.fields?.inputUsdPerMillionTokens ?? null, null);
});

test("two numbers in one cell are not a price", () => {
  const stated = { usd: true, perMillion: true };
  assert.equal(docPriceCell("$4.40 before, $1.40 now", "", stated).kind, "unreadable");
  assert.equal(docPriceCell("~~$4.40~~ $1.40", "", stated).kind, "unreadable");
  assert.equal(
    (docPriceCell("$1.40-$4.40 depending on region", "", stated) as { reason: string })
      .reason,
    "ambiguous_value"
  );
});

test("a sentence naming two models speaks for neither", () => {
  const compared = [
    "# GLM-5.3",
    "",
    "GLM-4.7 has a 128K-token context window.",
    "",
    "This model has a 1M-token context window.",
    "",
  ].join("\n");
  const facts = readModelPageFacts("glm-5.3", compared);
  assert.equal(facts.contextWindowTokens, 1_000_000);
});

test("a rate tier nobody has invented yet is still a rate tier", () => {
  // The allowlist alone could not see these: the preamble under any price
  // table says "Prices per 1M tokens", which satisfies it on its own. The
  // shape of the heading -- a word in front of "processing" -- is what says
  // this is a tier, and only "standard" is the rate a request pays.
  const tier = (heading: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        heading,
        "",
        "Prices per 1M tokens in USD.",
        "",
        "| Model | Input | Output |",
        "| --- | --- | --- |",
        "| glm-5.3 | $0.70 | $2.20 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const heading of ["## Turbo processing", "## Accelerated processing", "## Fast lane"]) {
    assert.ok(
      tier(heading).problems.includes("pricing_table_not_standard_rate"),
      heading
    );
  }
  // And the one that is the standard rate still reads.
  const standard = tier("## Standard processing");
  assert.equal(standard.fields?.inputUsdPerMillionTokens ?? null, 0.7);
});

test("a currency spelled out is still a currency", () => {
  const canada = [
    "All prices are in USD.",
    "",
    "## Model pricing",
    "Prices per 1M tokens in euros.",
    "",
    "| Model | Input | Output |",
    "| --- | --- | --- |",
    "| glm-5.3 | 1.40 | 4.40 |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: canada,
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.equal(parse.fields?.inputUsdPerMillionTokens ?? null, null);
  assert.ok(parse.problems.some((problem) => problem.endsWith("not_usd")));
});

test("a combined cell holding the old price too is not read", () => {
  const struck = [
    "Prices per 1M tokens in USD.",
    "",
    "| Model | Price per 1M tokens |",
    "| --- | --- |",
    "| combo-1 | ~~$0.15 input~~ $0.10 input $0.60 output |",
    "",
  ].join("\n");
  const parse = genericModelFromDocs({
    apiModel: "combo-1",
    pricingMarkdown: struck,
    modelPageMarkdown: null,
    shape: "combined",
  });
  assert.equal(parse.fields?.inputUsdPerMillionTokens ?? null, null);
  assert.ok(parse.problems.includes("input_price:ambiguous_value"));
});

test("a derivative is a different model on its base model page", () => {
  const page = [
    "# GLM-5.3",
    "",
    "GLM-5.3-Flash has a 128K-token context window.",
    "",
  ].join("\n");
  const facts = readModelPageFacts("glm-5.3", page);
  assert.equal(facts.contextWindowTokens, null);
});

test("xAI's moved price page reads every grok row", () => {
  // Not only the one this reader was built against: the page lists six
  // families and a wrong URL made all of them unreadable at once.
  const latest = read({ apiModel: "grok-4.7", pricing: XAI_PRICING });
  assert.equal(latest.fields?.inputUsdPerMillionTokens, 2);
  assert.equal(latest.fields?.outputUsdPerMillionTokens, 6);
  assert.equal(latest.fields?.contextWindowTokens, 500_000);
  const wide = read({ apiModel: "grok-4.3", pricing: XAI_PRICING });
  assert.equal(wide.fields?.inputUsdPerMillionTokens, 1.25);
  assert.equal(wide.fields?.contextWindowTokens, 1_000_000);
});

test("a qualifier the tier list never heard of is still not the standard rate", () => {
  // "Fast mode pricing" is a real heading at twice the standard rate, and
  // naming the tiers to reject could never have contained it. What is
  // checked is the qualifier: it must describe what is priced, not how it
  // is served.
  const priced = (heading: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        heading,
        "",
        "Prices per 1M tokens in USD.",
        "",
        "| Model | Input | Output |",
        "| --- | --- | --- |",
        "| glm-5.3 | $0.70 | $2.20 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const heading of [
    "## Fast mode pricing",
    "## Priority Processing Pricing",
    "## Grok 4.7 Fast pricing",
    "### Flex pricing data",
  ]) {
    assert.ok(priced(heading).problems.includes("pricing_table_not_standard_rate"), heading);
  }
  // And the qualifiers real providers put on the standard table still read.
  for (const heading of ["### Text API Pricing", "### Standard pricing data", "## Model pricing"]) {
    assert.equal(priced(heading).fields?.inputUsdPerMillionTokens ?? null, 0.7, heading);
  }
});

test("a currency this reader has never heard of is not US dollars", () => {
  // A list of currencies to reject cannot close. A sentence that names the
  // currency at all has to name this one.
  const inCurrency = (phrase: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "All prices are in USD.",
        "",
        "## Model pricing",
        `Prices per 1M tokens in ${phrase}.`,
        "",
        "| Model | Input | Output |",
        "| --- | --- | --- |",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const phrase of ["New Taiwan dollars", "UAE dirhams", "Saudi riyals", "euros"]) {
    assert.ok(inCurrency(phrase).problems.includes("input_price:not_usd"), phrase);
  }
  // The ways a page spells this currency still read, and a sentence about
  // something other than money is not a currency statement at all.
  for (const phrase of ["USD", "US dollars", "U.S. dollars", "United States dollars"]) {
    assert.equal(inCurrency(phrase).fields?.inputUsdPerMillionTokens ?? null, 1.4, phrase);
  }
});

test("a model identifier with a letter after its version is one identifier", () => {
  // "GPT-4o" was not model-shaped at all, so a sentence about it counted as
  // naming no other model; "glm-4.6v" matched as "glm-4" and was a
  // different model from itself.
  assert.equal(
    readModelPageFacts("glm-5.3", "# GLM-5.3\n\nGPT-4o has a 128K-token context window.")
      .contextWindowTokens,
    null
  );
  assert.equal(
    readModelPageFacts("glm-4.6v", "# GLM-4.6V\n\nGLM-4.6V has a 128K-token context window.")
      .contextWindowTokens,
    128_000
  );
});

test("a currency code in a column or a cell is a currency claim", () => {
  // The heading rule only reads sentences, and a table that names its
  // currency in the column header -- "Input (AED)" -- said nothing this
  // reader could hear. A list of codes to reject let every unlisted one
  // through as US dollars.
  const withCode = (header: string, cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "All prices are in USD.",
        "",
        "## Model pricing",
        "Prices per 1M tokens.",
        "",
        `| Model | Input${header} | Output${header} |`,
        "| --- | --- | --- |",
        `| glm-5.3 | ${cell}1.40 | ${cell}4.40 |`,
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  assert.ok(withCode(" (AED)", "").problems.includes("input_price:not_usd"));
  assert.ok(withCode("", "AED ").problems.includes("input_price:not_usd"));
  // And the capitals a real table already uses are not currencies.
  assert.equal(withCode(" (USD)", "").fields?.inputUsdPerMillionTokens, 1.4);
});

test("a heading of one word is its own qualifier", () => {
  // A provider that separates its tiers as "Standard", "Batch", "Flex" and
  // "Turbo" gives the noun rule nothing to read, and all four passed.
  const under = (heading: string, unitInHeader: boolean) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        heading,
        "",
        unitInHeader ? "" : "Prices per 1M tokens in USD.",
        "",
        unitInHeader
          ? "| Model | Input (USD per 1M tokens) | Output (USD per 1M tokens) |"
          : "| Model | Input | Output |",
        "| --- | --- | --- |",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const heading of ["### Turbo", "### Flex", "### Priority"]) {
    assert.ok(under(heading, false).problems.includes("pricing_table_not_standard_rate"), heading);
  }
  assert.equal(under("### Standard", true).fields?.inputUsdPerMillionTokens, 1.4);
  assert.equal(under("### Pricing", false).fields?.inputUsdPerMillionTokens, 1.4);
});

test("a currency sentence states the currency and then the unit", () => {
  const withSentence = (sentence: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "All prices are in USD.",
        "",
        "## Model pricing",
        sentence,
        "",
        "| Model | Input | Output |",
        "| --- | --- | --- |",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  // The currency comes first and the unit after it, which reading the whole
  // clause as the currency refused.
  assert.equal(
    withSentence("Prices are in USD per 1M tokens.").fields?.inputUsdPerMillionTokens,
    1.4
  );
  // And a sentence whose first "in" says nothing still says something at
  // its second.
  assert.ok(
    withSentence(
      "Prices shown in the table below are in UAE dirhams. Per 1M tokens."
    ).problems.includes("input_price:not_usd")
  );
});

test("a standard is not another model", () => {
  // "RFC-9110" is model-shaped, and counting it as another model threw away
  // the sentence that carried the context window.
  assert.equal(
    readModelPageFacts(
      "glm-5.3",
      "# GLM-5.3\n\nGLM-5.3 complies with RFC-9110 and has a 128K-token context window."
    ).contextWindowTokens,
    128_000
  );
});

test("a note in brackets does not make a one-word heading two words", () => {
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: [
      "### Turbo (preview)",
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input | Output |",
      "|---|---|---|",
      "| glm-5.3 | 0.70 | 2.20 |",
      "",
    ].join("\n"),
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("pricing_table_not_standard_rate"));
});

test("a currency code in the table's own heading is a currency claim", () => {
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: [
      "All prices are in USD.",
      "",
      "## Model pricing (AED)",
      "Prices per 1M tokens.",
      "",
      "| Model | Input | Output |",
      "|---|---|---|",
      "| glm-5.3 | 1.40 | 4.40 |",
      "",
    ].join("\n"),
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("input_price:not_usd"));
});

test("a column with its own currency is not a table this reader can read", () => {
  const withSentence = (sentence: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "## Model pricing",
        sentence,
        "",
        "| Model | Input | Output |",
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  // The second currency is not introduced by an "in" of its own, so
  // reading every "in" does not find it. A table whose columns are in
  // different currencies is refused whole.
  assert.ok(
    withSentence(
      "Prices are in USD for input and UAE dirhams for output, per 1M tokens."
    ).problems.includes("input_price:not_usd")
  );
  // Naming both sides at one currency is not that.
  assert.equal(
    withSentence("Prices are in USD for input and output, per 1M tokens.")
      .fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a combined cell keeps its currency and its unit", () => {
  const combined = (cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
    pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| Model | PRICE PER 1M TOKENS |",
        "|---|---|",
        `| glm-5.3 | ${cell} |`,
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "combined",
    });
  assert.ok(
    combined("$0.15 input$0.60 output (AED)").problems.includes("input_price:not_usd")
  );
  assert.ok(
    combined("$0.15 input per 1K tokens$0.60 output per 1K tokens").problems.includes(
      "input_price:unit_other"
    )
  );
  // And the shape Groq actually publishes still reads.
  assert.equal(
    combined("$0.15 input$0.60 output").fields?.inputUsdPerMillionTokens,
    0.15
  );
});

test("a thousand tokens is not a million, however a page writes it", () => {
  const perUnit = (header: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        `| Model | Input ${header} | Output ${header} |`,
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const header of ["per 1,000 tokens", "per 1000 tokens", "per thousand tokens"]) {
    assert.ok(
      perUnit(header).problems.includes("input_price:unit_not_per_million"),
      header
    );
  }
  assert.equal(perUnit("per 1M tokens").fields?.inputUsdPerMillionTokens, 1.4);
});

test("a provider's display name names a model", () => {
  // "Claude Sonnet 4.5" is a model as surely as "glm-5.3" is, and a page
  // that opens by comparing itself with one stated its number first.
  assert.equal(
    readModelPageFacts(
      "glm-5.3",
      "# GLM-5.3\n\nClaude Sonnet 4.5 has a 200K-token context window.\n\nGLM-5.3 has a 1M-token context window."
    ).contextWindowTokens,
    1_000_000
  );
  // A date is not a model.
  assert.equal(
    readModelPageFacts(
      "glm-5.3",
      "# GLM-5.3\n\nUpdated September 2026. GLM-5.3 has a 1M-token context window."
    ).contextWindowTokens,
    1_000_000
  );
});

test("the quantity a price is per has to be this one", () => {
  // Listing the wrong quantities let "per 10,000 tokens" through and
  // refused "per 1,000,000 tokens", which is what Perplexity writes.
  const perUnit = (header: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        `| Model | Input ${header} | Output ${header} |`,
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const header of [
    "per 10,000 tokens",
    "per 1 billion tokens",
    "per 100,000 tokens",
  ]) {
    assert.ok(perUnit(header).problems.includes("input_price:unit_not_per_million"), header);
  }
  for (const header of ["per 1M tokens", "per 1,000,000 tokens", "per million tokens"]) {
    assert.equal(perUnit(header).fields?.inputUsdPerMillionTokens, 1.4, header);
  }
});

test("a currency named in a price column, in words or in a bare code", () => {
  const withHeader = (header: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        `| Model | Input ${header} | Output ${header} |`,
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  for (const header of ["AED per 1M tokens", "(UAE dirhams) per 1M tokens"]) {
    assert.ok(withHeader(header).problems.includes("input_price:not_usd"), header);
  }
  assert.equal(withHeader("per 1M tokens").fields?.inputUsdPerMillionTokens, 1.4);
});

test("a combined cell keeps a currency written in words", () => {
  const combined = (cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| Model | PRICE PER 1M TOKENS |",
        "|---|---|",
        `| glm-5.3 | ${cell} |`,
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "combined",
    });
  assert.ok(
    combined("$0.15 input$0.60 output (UAE dirhams)").problems.includes(
      "input_price:not_usd"
    )
  );
  assert.ok(
    combined("$0.15 input per token$0.60 output per token").problems.includes(
      "input_price:unit_other"
    )
  );
  assert.equal(combined("$0.15 input$0.60 output").fields?.inputUsdPerMillionTokens, 0.15);
});

test("each column's own currency is read, not the sentence's shape", () => {
  const sentence = (text: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "## Model pricing",
        text,
        "",
        "| Model | Input | Output |",
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  // Two currencies, the second with no "in" of its own.
  assert.ok(
    sentence("Prices: USD for input and AED for output, per 1M tokens.").problems.includes(
      "input_price:not_usd"
    )
  );
  // One currency, and a shape that looks like two.
  assert.equal(
    sentence(
      "Prices are shown in USD for input and separately for output, per 1M tokens."
    ).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a link in a heading does not hide what the heading claims", () => {
  // plainCell() flattens `[preview](url)` to `preview` before the bracket
  // rule ever sees it, so the heading has to be judged on its own rather
  // than rescued by the sentence under it.
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: [
      "### Turbo [preview](https://example.com/preview)",
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input | Output |",
      "|---|---|---|",
      "| glm-5.3 | 0.70 | 2.20 |",
      "",
    ].join("\n"),
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("pricing_table_not_standard_rate"));
});

test("more of the shapes a model name takes", () => {
  for (const other of ["GPT 4o", "o4-mini", "DeepSeek V3.2", "Claude Sonnet 4.5"]) {
    assert.equal(
      readModelPageFacts(
        "glm-5.3",
        `# GLM-5.3\n\n${other} has a 128K-token context window.\n\nGLM-5.3 has a 1M-token context window.`
      ).contextWindowTokens,
      1_000_000,
      other
    );
  }
});

test("a billion is not a million because it starts with one", () => {
  const parse = genericModelFromDocs({
    apiModel: "glm-5.3",
    pricingMarkdown: [
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input per 1,000,000,000 tokens | Output per 1,000,000,000 tokens |",
      "|---|---|---|",
      "| glm-5.3 | 1.40 | 4.40 |",
      "",
    ].join("\n"),
    modelPageMarkdown: null,
    shape: "columns",
  });
  assert.ok(parse.problems.includes("input_price:unit_not_per_million"));
});

test("a word this reader does not know beside a price refuses the price", () => {
  const withText = (header: string, cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "All prices are in USD.",
        "",
        "## Model pricing",
        "Prices per 1M tokens.",
        "",
        `| Model | Input${header} | Output${header} |`,
        "|---|---|---|",
        `| glm-5.3 | 1.40${cell} | 4.40${cell} |`,
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
    });
  assert.ok(withText("", " Saudi riyals").problems.includes("input_price:not_usd"));
  assert.ok(
    withText(" in Saudi riyals per 1M tokens", "").problems.includes("input_price:not_usd")
  );
  assert.equal(withText("", "").fields?.inputUsdPerMillionTokens, 1.4);
});

test("a page names this model in the spelling its own marketing uses", () => {
  const facts = readModelPageFacts(
    "deepseek-v3.2",
    "# DeepSeek V3.2\n\nDeepSeek V3.2 has a 128K-token context window."
  );
  assert.equal(facts.namesModel, true);
  assert.equal(facts.contextWindowTokens, 128_000);
});

test("a provider's recorded table shape is what gets read", () => {
  // Every other rule asks whether something is wrong with a table. This one
  // asks whether it is the table at all, which is the only one of the two
  // questions with a finite answer.
  const headers = ["model | input | output"];
  const withHeader = (header: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        `| Model | ${header} | Output |`,
        "|---|---|---|",
        "| glm-5.3 | 1.40 | 4.40 |",
        "",
      ].join("\n"),
      modelPageMarkdown: null,
      shape: "columns",
      expectedHeaders: headers,
    });
  assert.equal(withHeader("Input").fields?.inputUsdPerMillionTokens, 1.4);
  // One renamed column and this is no longer the table a person read.
  assert.ok(
    withHeader("Input (AED)").problems.includes("pricing_table_shape_unrecognised")
  );
});

const ZHIPU_SHAPE = [
  "model | input | cached input | cached input storage | output",
];

const zhipuShaped = (row: string, heading = "", preamble = "Prices per 1M tokens in USD.") =>
  genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      heading,
      preamble,
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      row,
      "",
    ].join("\n"),
  });

test("a currency symbol this reader has never seen is not a dollar sign", () => {
  for (const cell of ["R$ 1.40", "\u20bd1.40", "1.40 SR"]) {
    assert.ok(
      zhipuShaped(`| glm-5.3 | ${cell} | - | - | 4.40 |`).problems.includes(
        "input_price:not_usd"
      ),
      cell
    );
  }
  for (const cell of ["1.40", "$1.40"]) {
    assert.equal(
      zhipuShaped(`| glm-5.3 | ${cell} | - | - | 4.40 |`).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      cell
    );
  }
});

test("a combined cell is judged on the words the page wrote", () => {
  const groqShaped = (cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      shape: "combined",
      expectedHeaders: [
        "model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size",
      ],
      modelPageMarkdown: null,
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| MODEL ID | SPEED (T/SEC) | PRICE PER 1M TOKENS | RATE LIMITS (DEVELOPER PLAN) | CONTEXT WINDOW (TOKENS) | MAX COMPLETION TOKENS | MAX FILE SIZE |",
        "|---|---|---|---|---|---|---|",
        `| glm-5.3 | 500 | ${cell} | 250K TPM | 131,072 | 65,536 | - |`,
        "",
      ].join("\n"),
    });
  assert.ok(
    groqShaped("$0.15 input Saudi riyals$0.60 output Saudi riyals").problems.includes(
      "input_price:not_usd"
    )
  );
  assert.equal(
    groqShaped("$0.15 input$0.60 output").fields?.inputUsdPerMillionTokens,
    0.15
  );
});

test("ordinary pricing prose is not a rate tier", () => {
  for (const preamble of [
    "This page provides pricing information for Z.AI's models and tools. All prices are in USD. Prices per 1M tokens.",
    "Below are our current prices. All prices are in USD. Prices per 1M tokens.",
    "The following prices apply to the API. All prices are in USD. Prices per 1M tokens.",
    "All inference prices are per 1M tokens. All prices are in USD.",
    "See updated prices below. All prices are in USD. Prices per 1M tokens.",
    "Requests above 200K tokens use long context pricing. All prices are in USD. Prices per 1M tokens.",
    "Pricing scales with usage. Prices per 1M tokens. All prices are in USD.",
    "Models in research preview are priced as follows. All prices are in USD. Prices per 1M tokens.",
    "Flexible pricing is available for high-volume accounts. All prices are in USD. Prices per 1M tokens.",
    "Image and video prices are listed separately. All prices are in USD. Prices per 1M tokens.",
    "Image prices are listed separately. All prices are in USD. Prices per 1M tokens.",
    "Video prices are listed separately. All prices are in USD. Prices per 1M tokens.",
    "Search prices are listed separately. All prices are in USD. Prices per 1M tokens.",
    "Tool prices are on the tools page. All prices are in USD. Prices per 1M tokens.",
    "Transparent pricing for every model. Prices per 1M tokens. All prices are in USD.",
    "Current prices are per 1M tokens. All prices are in USD.",
    "New prices take effect on November 1, 2026. All prices are in USD. Prices per 1M tokens.",
    "Updated pricing is effective October 1. All prices are in USD. Prices per 1M tokens.",
    "Full pricing for every model is below. All prices are in USD. Prices per 1M tokens.",
    "built in browser search and code execution. All prices are in USD. Prices per 1M tokens.",
    "Cached input prices are listed below. All prices are in USD. Prices per 1M tokens.",
    "Prices per 1M tokens. Cache hits are billed at 10% of the input rate. All prices are in USD.",
    "Prices below include cache write rates, per 1M tokens. All prices are in USD.",
    "Prices include cache storage rates. All prices are in USD. Prices per 1M tokens.",
  ]) {
    assert.equal(
      zhipuShaped("| glm-5.3 | 1.40 | - | - | 4.40 |", "## Pricing", preamble).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      preamble
    );
  }
});

test("a rate word before the price noun is another rate, wherever it sits", () => {
  for (const preamble of [
    "Batch API prices per 1M tokens. All prices are in USD.",
    "Flex API prices per 1M tokens. All prices are in USD.",
    "Turbo API rates per 1M tokens. All prices are in USD.",
    "Discounted rates apply to committed-use customers. All prices are in USD. Prices per 1M tokens.",
    "Prices shown apply to batch requests. All prices are in USD. Prices per 1M tokens.",
    "The prices below are discounted rates for committed-use customers. All prices are in USD. Prices per 1M tokens.",
    "Caching prices per 1M tokens. All prices are in USD.",
    "Prices for cache writes per 1M tokens. All prices are in USD.",
  ]) {
    assert.ok(
      zhipuShaped("| glm-5.3 | 0.70 | 0.13 | - | 2.20 |", "## Pricing", preamble).problems.includes(
        "pricing_table_not_standard_rate"
      ),
      preamble
    );
  }
});

test("a colon on a one-word price heading is still that heading", () => {
  assert.equal(
    zhipuShaped(
      "| glm-5.3 | 1.40 | - | - | 4.40 |",
      "## Pricing:",
      "Prices per 1M tokens in USD."
    ).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a later tier label in the preamble is still another rate", () => {
  assert.ok(
    zhipuShaped(
      "| glm-5.3 | 1.40 | - | - | 4.40 |",
      "## Pricing",
      "Standard prices are listed on the main pricing page. Turbo pricing per 1M tokens in USD."
    ).problems.includes("pricing_table_not_standard_rate")
  );
});

test("a shared page does not lend one SKU's promotion to the other", () => {
  const page =
    "# GLM-5.3-Flash/FlashX\n\nGLM-5.3-FlashX promotional pricing ends October 1, 2026.\n";
  const sentence = "GLM-5.3-FlashX promotional pricing ends October 1, 2026.";
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flash", page, sentence), false);
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flashx", page, sentence), true);
  assert.equal(
    modelPageNoticeAppliesTo(
      "glm-5.3-flash",
      page,
      "FlashX promotional pricing ends October 1, 2026."
    ),
    false
  );
  const series = "Limited-time promotional pricing applies to all Flash-series models.";
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flash", page, series), true);
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flashx", page, series), true);
  const line = "Limited-time promotional pricing applies to all Flash models.";
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flash", page, line), true);
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flashx", page, line), true);
  const family = "Limited-time promotional pricing applies to all GLM-5.3 models.";
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flash", page, family), true);
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flashx", page, family), true);
  const unnamed = "Promotional pricing is available through October 1, 2026.";
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flash", page, unnamed), true);
  assert.equal(modelPageNoticeAppliesTo("glm-5.3-flashx", page, unnamed), true);
  assert.equal(
    modelPageNoticeAppliesTo("glm-5.3", "# GLM-5.3\n\n" + unnamed, unnamed),
    true
  );
});

test("the right columns are not enough to make a table the standard rate", () => {
  // A tier claimed in the preamble, and one claimed by a heading the table
  // is nested under, both survive an exact column match.
  assert.ok(
    zhipuShaped(
      "| glm-5.3 | 1.40 | - | - | 4.40 |",
      "## Pricing",
      "Fast mode pricing per 1M tokens in USD."
    ).problems.includes("pricing_table_not_standard_rate")
  );
  const nested = genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      "## Batch API Pricing",
      "",
      "### Text Models",
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      "| glm-5.3 | 1.40 | - | - | 4.40 |",
      "",
    ].join("\n"),
  });
  assert.ok(nested.problems.includes("pricing_table_not_standard_rate"));
});

test("an id in some other column does not claim the row", () => {
  const parse = genericModelFromDocs({
    apiModel: "target-1",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      "| other-1 | 9.99 | target-1 | - | 19.99 |",
      "",
    ].join("\n"),
  });
  // Not found rather than found at another model's price: the row that
  // mentioned this id in its cached-input cell belongs to other-1.
  assert.equal(parse.status, "not_found");
  assert.equal(parse.fields, null);
});

test("a derivative's page is not the base model's page", () => {
  assert.equal(
    readModelPageFacts("glm-5.3", "# GLM-5.3-Flash\n\nIt has a 128K-token context window.")
      .namesModel,
    false
  );
  assert.equal(
    readModelPageFacts(
      "deepseek-v3.2",
      "# DeepSeek V3.2\n\nDeepSeek V3.2 has a 128K-token context window."
    ).namesModel,
    true
  );
});

test("a currency the page declares covers every table on it", () => {
  const declared = (sentence: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      shape: "columns",
      expectedHeaders: ZHIPU_SHAPE,
      modelPageMarkdown: null,
      pricingMarkdown: [
        sentence,
        "",
        "## Text Models",
        "Prices per 1M tokens.",
        "",
        "| Model | Input | Cached Input | Cached Input Storage | Output |",
        "|---|---|---|---|---|",
        "| glm-5.3 | $1.40 | - | - | $4.40 |",
        "",
      ].join("\n"),
    });
  // The cell's "$" is ambiguous; the page is not.
  assert.ok(
    declared("All prices are in Canadian dollars.").problems.includes(
      "input_price:not_usd"
    )
  );
  assert.equal(
    declared("All prices are in USD.").fields?.inputUsdPerMillionTokens,
    1.4
  );
  // A fee mentioned in passing is not a declaration about the page.
  assert.equal(
    declared(
      "All prices are in USD. For violations we will charge a $0.05 usage fee."
    ).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a link destination is not what the row says the model is", () => {
  const groqRow = (cell: string) =>
    genericModelFromDocs({
      apiModel: "target-1",
      shape: "combined",
      expectedHeaders: [
        "model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size",
      ],
      modelPageMarkdown: null,
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| MODEL ID | SPEED (T/SEC) | PRICE PER 1M TOKENS | RATE LIMITS (DEVELOPER PLAN) | CONTEXT WINDOW (TOKENS) | MAX COMPLETION TOKENS | MAX FILE SIZE |",
        "|---|---|---|---|---|---|---|",
        `| ${cell} | 500 | $9.99 input$19.99 output | 250K TPM | 131,072 | 65,536 | - |`,
        "",
      ].join("\n"),
    });
  // The row is other-1's; only its link points at target-1.
  assert.equal(groqRow("[Other](/docs/model/target-1)other-1").status, "not_found");
  // And the shape Groq actually writes still finds its own model.
  assert.equal(
    groqRow("[![X](https://x/y.png)Target 1](/docs/model/target-1)target-1").fields
      ?.inputUsdPerMillionTokens,
    9.99
  );
});

test("a page that says which model it is about is not talked out of it", () => {
  // Mentioning the base model in a comparison paragraph does not make a
  // derivative's page the base model's page.
  assert.equal(
    readModelPageFacts(
      "glm-5.3",
      "# GLM-5.3-Flash\n\nCompared with GLM-5.3, this model is faster.\n\nIt has a 128K-token context window."
    ).namesModel,
    false
  );
});

test("what the page declares is read the same way in both directions", () => {
  const declared = (sentence: string, cell: string) =>
    genericModelFromDocs({
      apiModel: "glm-5.3",
      shape: "columns",
      expectedHeaders: ZHIPU_SHAPE,
      modelPageMarkdown: null,
      pricingMarkdown: [
        sentence,
        "",
        "## Text Models",
        "Prices per 1M tokens.",
        "",
        "| Model | Input | Cached Input | Cached Input Storage | Output |",
        "|---|---|---|---|---|",
        `| glm-5.3 | ${cell} | - | - | ${cell} |`,
        "",
      ].join("\n"),
    });
  // The declaration's first "in" says nothing; its second says everything.
  assert.ok(
    declared(
      "All prices in the table below are in Canadian dollars.",
      "$1.40"
    ).problems.includes("input_price:not_usd")
  );
  // A charge mentioned in passing is not a declaration, in either
  // direction: this page has not said what its table is in.
  assert.ok(
    declared("A separate usage fee is charged in USD.", "1.40").problems.includes(
      "input_price:currency_unstated"
    )
  );
  // And the spellings of this currency all reach the check that accepts
  // them.
  for (const sentence of ["All prices are in USD.", "All prices are in U.S. dollars."]) {
    assert.equal(
      declared(sentence, "$1.40").fields?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
});

test("an id that ends the cell is the cell's id, not a suffix of one", () => {
  const groqRow = (cell: string) =>
    genericModelFromDocs({
      apiModel: "target-1",
      shape: "combined",
      expectedHeaders: [
        "model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size",
      ],
      modelPageMarkdown: null,
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| MODEL ID | SPEED (T/SEC) | PRICE PER 1M TOKENS | RATE LIMITS (DEVELOPER PLAN) | CONTEXT WINDOW (TOKENS) | MAX COMPLETION TOKENS | MAX FILE SIZE |",
        "|---|---|---|---|---|---|---|",
        `| ${cell} | 500 | $9.99 input$19.99 output | 250K TPM | 131,072 | 65,536 | - |`,
        "",
      ].join("\n"),
    });
  // "not-target-1" ends with "target-1" and is another model.
  assert.equal(
    groqRow("[![Other](https://example.com/logo.svg)Other](/docs/model/not-target-1)Enterprisenot-target-1")
      .status,
    "not_found"
  );
  // Groq glues the id to the display name, so a letter before it is fine.
  assert.equal(
    groqRow("[![X](https://x/y.svg)Target 1](/docs/model/target-1)Enterprisetarget-1").fields
      ?.inputUsdPerMillionTokens,
    9.99
  );
});

const zhipuUnder = (before: string[], cell = "1.40") =>
  genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      ...before,
      "",
      "## Text Models",
      "Prices per 1M tokens.",
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      `| glm-5.3 | ${cell} | - | - | 4.40 |`,
      "",
    ].join("\n"),
  });

test("a sentence that denies a currency states another one", () => {
  // "Prices are not in USD" is not silence about the currency: it says the
  // prices are in some other one, so the table is refused rather than read.
  for (const sentence of ["Prices are not in USD.", "Prices are no longer in USD."]) {
    assert.ok(
      zhipuUnder([sentence]).problems.includes("input_price:not_usd"),
      sentence
    );
  }
  // And a negation that is not about the currency leaves the declaration
  // standing.
  assert.equal(
    zhipuUnder(["All prices are in USD and do not include taxes."]).fields
      ?.inputUsdPerMillionTokens,
    1.4
  );
  assert.equal(
    zhipuUnder(["All prices are in USD, including image and tool prices."]).fields
      ?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a declaration about one table does not speak for the page", () => {
  // It may still refuse -- a refusal is safe wherever it lands -- but it
  // cannot establish this currency for a table it never claimed.
  assert.ok(
    zhipuUnder([
      "## Tool pricing",
      "All prices in the table below are in USD.",
      "",
      "| Tool | Per call |",
      "|---|---|",
      "| search | $0.01 |",
    ]).problems.includes("input_price:currency_unstated")
  );
  assert.ok(
    zhipuUnder(
      ["All prices in the table below are in Canadian dollars."],
      "$1.40"
    ).problems.includes("input_price:not_usd")
  );
});

test("emphasis around a declaration is decoration, not content", () => {
  assert.equal(
    zhipuUnder(["**All prices are in USD.**"]).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("only a badge this reader knows may sit against an id", () => {
  const groqRow = (cell: string) =>
    genericModelFromDocs({
      apiModel: "target-1",
      shape: "combined",
      expectedHeaders: [
        "model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size",
      ],
      modelPageMarkdown: null,
      pricingMarkdown: [
        "Prices per 1M tokens in USD.",
        "",
        "| MODEL ID | SPEED (T/SEC) | PRICE PER 1M TOKENS | RATE LIMITS (DEVELOPER PLAN) | CONTEXT WINDOW (TOKENS) | MAX COMPLETION TOKENS | MAX FILE SIZE |",
        "|---|---|---|---|---|---|---|",
        `| ${cell} | 500 | $9.99 input$19.99 output | 250K TPM | 131,072 | 65,536 | - |`,
        "",
      ].join("\n"),
    });
  // "pretendtarget-1" ends with "target-1" and is another model.
  assert.equal(
    groqRow("[Other](/docs/model/pretendtarget-1)Enterprisepretendtarget-1").status,
    "not_found"
  );
  // The two shapes Groq actually writes still find their own model.
  for (const cell of ["[T](/docs/model/target-1)Enterprisetarget-1", "[T](/docs/model/target-1)Target 1Btarget-1"]) {
    assert.equal(groqRow(cell).fields?.inputUsdPerMillionTokens, 9.99, cell);
  }
});

test("a denial in the table's own preamble is read as a denial", () => {
  // pageDeclaredCurrency() skipped the sentence and tableUnits() then read
  // the bare word "USD" out of the same preamble as a declaration.
  for (const cell of ["1.40", "$1.40"]) {
    assert.ok(
      zhipuUnder(
        ["## Standard pricing", "Prices are not in USD, per 1M tokens."],
        cell
      ).problems.includes("input_price:not_usd"),
      cell
    );
  }
});

test("a declaration survives the words that come after the currency", () => {
  for (const sentence of [
    "All prices are in US dollars (USD).",
    "All prices are in [USD](https://example.com/currency).",
    "All prices are denominated\nin USD.",
  ]) {
    assert.equal(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
});

test("another vendor's namespace is another model", () => {
  const parse = genericModelFromDocs({
    apiModel: "vendor-a/target-1",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      "Prices per 1M tokens in USD.",
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      "| vendor-b/target-1 | 9.99 | - | - | 19.99 |",
      "",
    ].join("\n"),
  });
  assert.equal(parse.status, "not_found");
  // A query that carries a prefix the document omits is still the same
  // model, which is the other direction and stays allowed.
  assert.equal(read({ apiModel: "ZHIPU/GLM-5.3-Flash" }).fields?.inputUsdPerMillionTokens, 0.15);
});

test("only the forms a price page writes are read as a declaration", () => {
  // Working out which table a loose sentence was about produced defects in
  // both directions round after round. These are the sentences a price
  // page actually writes; anything else is silence.
  const reads = [
    "All prices are in USD.",
    "All prices are in US dollars (USD).",
    "All prices are in [USD](https://example.com/currency).",
    "All prices are in USD and do not include taxes.",
    "All prices are in USD, including image and tool prices.",
    "All prices, including image and tool prices, are in USD.",
    "All prices are denominated\nin USD.",
    "Prices are in USD per 1M tokens.",
    "Prices are not shown in the table below. All prices are in USD.",
  ];
  for (const sentence of reads) {
    assert.equal(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
  // A sentence that qualifies the currency is not one of them, and silence
  // refuses.
  assert.ok(
    zhipuUnder([
      "All prices are in USD for the table below.",
      "",
      "## Text Models",
      "Prices per 1M tokens.",
    ]).problems.includes("input_price:currency_unstated")
  );
  // A denial is a statement of another currency, whatever its subject.
  assert.ok(
    zhipuUnder([
      "## Standard pricing",
      "Token charges below are not in USD, per 1M tokens.",
    ]).problems.includes("input_price:not_usd")
  );
  // And a currency word anywhere on the page hands it to a person.
  assert.ok(
    zhipuUnder(
      ["All prices are in Canadian dollars.", "", "## Text Models", "Prices per 1M tokens."],
      "$1.40"
    ).problems.includes("input_price:not_usd")
  );
});

test("a namespace that merely contains this id is another model", () => {
  const parse = genericModelFromDocs({
    apiModel: "vendor-a/target-1",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      "All prices are in USD.",
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      "| xvendor-a/target-1 | 9.99 | - | - | 19.99 |",
      "",
    ].join("\n"),
  });
  assert.equal(parse.status, "not_found");
  // Groq's own namespaced id still finds its row.
  assert.equal(
    read({ apiModel: "openai/gpt-oss-120b", pricing: GROQ_MODELS, shape: "combined" })
      .fields?.inputUsdPerMillionTokens,
    0.15
  );
});

test("the declaration forms real provider pages write", () => {
  const reads = [
    "* All payments are in USD",
    "Unless otherwise noted, all prices are in USD.",
    "All listed prices are in USD.",
    "All prices are in USD:",
    "All prices do not include taxes and are in USD.",
  ];
  for (const sentence of reads) {
    assert.equal(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
  // A clause may stand between the subject and the currency, but not one
  // that scopes the declaration to part of the page.
  for (const sentence of [
    "All prices in the table below are in USD.",
    "All prices are in USD for the table below.",
    "Tool prices below are in USD.",
  ]) {
    assert.ok(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).problems.includes(
        "input_price:currency_unstated"
      ),
      sentence
    );
  }
});

test("a contraction is not a currency", () => {
  // "won't" is not the Korean won, and the xAI page already writes the
  // same sentence unabbreviated.
  for (const line of ["You won't be charged for failed requests.", "You won\u2019t be charged."]) {
    assert.equal(
      zhipuUnder([
        "All prices are in USD.",
        line,
        "",
        "## Text Models",
        "Prices per 1M tokens.",
      ]).fields?.inputUsdPerMillionTokens,
      1.4,
      line
    );
  }
});

test("a negation has to deny the currency, and a code in an \"in\" is one", () => {
  // The negation denies the currency here.
  assert.ok(
    zhipuUnder([
      "## Standard pricing",
      "Usage fees below are not in USD, per 1M tokens.",
    ]).problems.includes("input_price:not_usd")
  );
  // And a currency code written where a currency goes is one, even when
  // this reader has never heard of it.
  assert.ok(
    zhipuUnder([
      "All prices are in USD. Local prices below are in AED.",
      "",
      "## Text Models",
      "Prices per 1M tokens.",
    ]).problems.includes("input_price:not_usd")
  );
});

test("a namespaced id has to end where the cell says it does", () => {
  const namespaced = (cell: string) =>
    genericModelFromDocs({
      apiModel: "vendor-a/target-1",
      shape: "columns",
      expectedHeaders: ZHIPU_SHAPE,
      modelPageMarkdown: null,
      pricingMarkdown: [
        "All prices are in USD.",
        "Prices per 1M tokens.",
        "",
        "| Model | Input | Cached Input | Cached Input Storage | Output |",
        "|---|---|---|---|---|",
        `| ${cell} | 9.99 | - | - | 19.99 |`,
        "",
      ].join("\n"),
    });
  for (const cell of ["vendor-a/target-1-pro", "vendor-a/target-10", "xvendor-a/target-1"]) {
    assert.equal(namespaced(cell).status, "not_found", cell);
  }
  assert.equal(namespaced("vendor-a/target-1").fields?.inputUsdPerMillionTokens, 9.99);
});

/**
 * The sentence directly above the table, under its heading.
 *
 * zhipuUnder() inserts its own heading after whatever it is given, so a
 * sentence passed to it lands in the section before the table rather than in
 * the table's preamble -- which is a different code path, and the one the
 * preamble tests meant to exercise.
 */
const zhipuPreamble = (sentence: string, cell = "1.40") =>
  genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      "## Text Models",
      sentence,
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      `| glm-5.3 | ${cell} | - | - | 4.40 |`,
      "",
    ].join("\n"),
  });

test("a denial in the preamble is a denial, contracted or not", () => {
  for (const sentence of ["Prices are not in USD, per 1M tokens.", "Prices aren't in USD, per 1M tokens."]) {
    assert.ok(
      zhipuPreamble(sentence).problems.includes("input_price:not_usd"),
      sentence
    );
  }
  // The sentence this reader will not guess at stays silence here too,
  // rather than being read as a declaration because it contains the word.
  assert.ok(
    zhipuPreamble("Prices are not tax-inclusive in USD, per 1M tokens.").problems.includes(
      "input_price:currency_unstated"
    )
  );
  // And a plain preamble still states both.
  assert.equal(
    zhipuPreamble("Prices per 1M tokens in USD.").fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a declaration about one kind of price is not about the page", () => {
  for (const sentence of [
    "Image prices are in USD.",
    "Batch prices are in USD.",
    "Tool prices are in USD.",
    "For the table below, all prices are in USD.",
  ]) {
    assert.ok(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).problems.includes(
        "input_price:currency_unstated"
      ),
      sentence
    );
  }
  // An inclusion widens the declaration rather than narrowing it.
  assert.equal(
    zhipuUnder([
      "All prices, including image and tool prices, are in USD.",
      "",
      "## Text Models",
      "Prices per 1M tokens.",
    ]).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("a three-letter word is a currency only where prices are the subject", () => {
  for (const line of ["Models are available in UAE.", "Also available in AWS."]) {
    assert.equal(
      zhipuUnder([
        "All prices are in USD.",
        line,
        "",
        "## Text Models",
        "Prices per 1M tokens.",
      ]).fields?.inputUsdPerMillionTokens,
      1.4,
      line
    );
  }
  assert.ok(
    zhipuUnder([
      "All prices are in USD. Local prices below are in AED.",
      "",
      "## Text Models",
      "Prices per 1M tokens.",
    ]).problems.includes("input_price:not_usd")
  );
});

test("a qualifier on the subject scopes the declaration too", () => {
  // "Input prices are in USD." declares one column, not the page, and the
  // subject rule allowed any word at all in front of the noun.
  for (const sentence of [
    "Input prices are in USD.",
    "Regional prices are in USD.",
    "Priority prices are in USD.",
    "Enterprise prices are in USD.",
  ]) {
    assert.ok(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).problems.includes(
        "input_price:currency_unstated"
      ),
      sentence
    );
  }
  for (const sentence of [
    "All prices are in USD.",
    "All listed prices are in USD.",
    "Published prices are in USD.",
    "Our prices are in USD.",
  ]) {
    assert.equal(
      zhipuUnder([sentence, "", "## Text Models", "Prices per 1M tokens."]).fields
        ?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
});

test("the table's own preamble is read the way the page is", () => {
  // These three all sit in the table preamble, which is a different code
  // path from the page prose and was not covered by the page tests.
  //
  // A denial of something other than the currency leaves the declaration
  // standing.
  for (const sentence of [
    "All prices are in USD and do not include taxes. Prices per 1M tokens.",
    "All prices are in USD, excluding taxes. Prices per 1M tokens.",
  ]) {
    assert.equal(
      zhipuPreamble(sentence).fields?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
  // A cloud or a region is not a currency.
  for (const sentence of [
    "Prices per 1M tokens in USD. Also available on OCI.",
    "Prices per 1M tokens in USD. Also available on IBM.",
    "Prices per 1M tokens in USD. Available in the EEA.",
  ]) {
    assert.equal(
      zhipuPreamble(sentence).fields?.inputUsdPerMillionTokens,
      1.4,
      sentence
    );
  }
});

/**
 * The same sentence, read at each position that can carry it.
 *
 * The page, the table's heading and the table's preamble were each asking
 * the currency question with a different combination of detectors, so a fix
 * in one place left the same defect in the others. One corpus, three
 * positions, one expected answer.
 */
/**
 * `reads` is the answer away from any table; `atTable` overrides it for a
 * sentence sitting against one. A declaration that scopes itself to "the
 * table below" establishes nothing for the page and everything for the table
 * it is written above.
 */
const CURRENCY_CORPUS: ReadonlyArray<{
  sentence: string;
  reads: boolean;
  atTable?: boolean;
}> = [
  // Declarations a price page writes.
  { sentence: "All prices are in USD.", reads: true },
  { sentence: "All prices are in US dollars (USD).", reads: true },
  { sentence: "All prices are in [USD](https://example.com/c).", reads: true },
  { sentence: "All prices are in USD and do not include taxes.", reads: true },
  { sentence: "All prices, excluding taxes, are in USD.", reads: true },
  { sentence: "All prices, including image and tool prices, are in USD.", reads: true },
  { sentence: "Unless otherwise noted, all prices are in USD.", reads: true },
  { sentence: "All listed prices are in USD.", reads: true },
  { sentence: "All prices are in USD:", reads: true },
  { sentence: "Prices are in USD per 1M tokens.", reads: true },
  { sentence: "Prices are in USD for input and output, per 1M tokens.", reads: true },
  // A declaration about one kind of price, one table, or one audience.
  { sentence: "Input prices are in USD.", reads: false },
  { sentence: "Image prices are in USD.", reads: false },
  { sentence: "Regional prices are in USD.", reads: false },
  { sentence: "For regional customers, all prices are in USD.", reads: false },
  { sentence: "For Enterprise customers, all prices are in USD.", reads: false },
  { sentence: "All prices are in USD for the table below.", reads: false, atTable: true },
  { sentence: "All prices in the table below are in USD.", reads: false, atTable: true },
  // A clause that takes a kind of price out of the subject.
  { sentence: "All prices, except cached input prices, are in USD.", reads: false },
  // A denial of the currency, and one this reader will not attribute.
  { sentence: "Prices are not in USD.", reads: false },
  { sentence: "Prices aren't in USD.", reads: false },
  { sentence: "Prices are not tax-inclusive in USD.", reads: false },
  // Another currency, however it is written.
  { sentence: "All prices are in Canadian dollars.", reads: false },
  { sentence: "All prices are in New Taiwan dollars.", reads: false },
  { sentence: "Local prices below are in AED.", reads: false },
  // A restriction after the currency narrows the declaration too.
  { sentence: "All prices are in USD, but cached input prices are not.", reads: false },
  { sentence: "Prices are in USD for input.", reads: false },
  { sentence: "All prices are in USD for cache reads.", reads: false },
  { sentence: "All prices are in USD for pay-as-you-go usage.", reads: false },
  { sentence: "All prices are in USD, except cached input.", reads: false },
  { sentence: "All prices are in USD, including input but not output prices.", reads: false },
  { sentence: "All prices are in USD excluding cached input prices.", reads: false },
  { sentence: "All prices are in USD excluding taxes.", reads: true },
  { sentence: "All prices are in dollars.", reads: false },
  { sentence: "Model pricing in AED.", reads: false },
  { sentence: "Pricing per 1M tokens in AED.", reads: false },
  { sentence: "Pricing shown in Saudi riyals.", reads: false },
  { sentence: "All prices are in USD for regional customers.", reads: false },
  { sentence: "All prices in the table above are in USD.", reads: false },
  // An inclusion clause ends where its sentence does.
  { sentence: "All prices, including text, image, and tool prices, are in USD.", reads: true },
  // A sentence this reader cannot attribute is not cancelled by a plain one.
  {
    sentence:
      "All prices are in USD. All prices, except cached input prices, are in USD.",
    reads: false,
  },
  // Not a currency at all.
  { sentence: "All prices are in USD. Models are shown in OCI.", reads: true },
  { sentence: "All prices are in USD. Models are available in UAE.", reads: true },
  { sentence: "All prices are in USD. You won't be charged for failures.", reads: true },
];

const atPosition = (position: "page" | "heading" | "preamble", sentence: string) => {
  const table = [
    "| Model | Input | Cached Input | Cached Input Storage | Output |",
    "|---|---|---|---|---|",
    "| glm-5.3 | 1.40 | - | - | 4.40 |",
    "",
  ];
  const lines =
    position === "page"
      ? [sentence, "", "## Text Models", "Prices per 1M tokens.", "", ...table]
      : position === "preamble"
        ? ["## Text Models", `${sentence} Prices per 1M tokens.`, "", ...table]
        : [`## ${sentence}`, "Prices per 1M tokens.", "", ...table];
  return genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: lines.join("\n"),
  });
};

test("one currency corpus, read the same way at every position", () => {
  for (const position of ["page", "preamble", "heading"] as const) {
    for (const { sentence, reads, atTable } of CURRENCY_CORPUS) {
      const parse = atPosition(position, sentence);
      const price = parse.fields?.inputUsdPerMillionTokens ?? null;
      const expected = position === "page" ? reads : (atTable ?? reads);
      assert.equal(
        price,
        expected ? 1.4 : null,
        `${position}: ${sentence}`
      );
    }
  }
});

const zhipuRows = (lines: string[], row: string) =>
  genericModelFromDocs({
    apiModel: "glm-5.3",
    shape: "columns",
    expectedHeaders: ZHIPU_SHAPE,
    modelPageMarkdown: null,
    pricingMarkdown: [
      ...lines,
      "",
      "| Model | Input | Cached Input | Cached Input Storage | Output |",
      "|---|---|---|---|---|",
      row,
      "",
    ].join("\n"),
  });

const ROW = "| glm-5.3 | 1.40 | 0.20 | - | 4.40 |";

test("a nearer sentence this reader cannot attribute blocks the page's", () => {
  // Not silence: the exception was qualifying the very declaration it
  // would otherwise have fallen back to.
  const parse = zhipuRows(
    [
      "All prices are in USD.",
      "",
      "## Text Models",
      "All prices, except cached input prices, are in USD. Prices per 1M tokens.",
    ],
    ROW
  );
  assert.ok(parse.problems.includes("input_price:currency_unstated"));
  const withoutComma = zhipuRows(
    [
      "All prices are in USD.",
      "",
      "## Text Models",
      "All prices are in USD excluding cached input prices. Prices per 1M tokens.",
    ],
    ROW
  );
  assert.ok(withoutComma.problems.includes("input_price:currency_unstated"));
});

test("what follows the currency qualifies it as much as what precedes it", () => {
  for (const sentence of [
    "All prices are in USD, except cached input prices.",
    "All prices are in USD, for the table below.",
  ]) {
    assert.ok(
      zhipuRows(
        [sentence, "", "## Text Models", "Prices per 1M tokens."],
        ROW
      ).problems.includes("input_price:currency_unstated"),
      sentence
    );
  }
});

test("a declaration scoped to the table above it speaks for that table", () => {
  assert.equal(
    zhipuRows(
      ["## Text Models", "All prices in the table below are in USD. Prices per 1M tokens."],
      ROW
    ).fields?.inputUsdPerMillionTokens,
    1.4
  );
});

test("prose about a cloud or a discount is not a currency claim", () => {
  for (const line of [
    "Prices are listed below, and models are available in OCI.",
    "Discounts are available for input and output.",
  ]) {
    assert.equal(
      zhipuRows(
        ["All prices are in USD.", line, "", "## Text Models", "Prices per 1M tokens."],
        ROW
      ).fields?.inputUsdPerMillionTokens,
      1.4,
      line
    );
  }
});

test("a cell may state its own unit", () => {
  for (const unit of ["per million tokens", "per 1M tokens"]) {
    assert.equal(
      zhipuRows(
        ["## Text Models"],
        `| glm-5.3 | USD 1.40 ${unit} | USD 0.20 ${unit} | - | USD 4.40 ${unit} |`
      ).fields?.inputUsdPerMillionTokens,
      1.4,
      unit
    );
  }
});

test("an inclusion clause does not reach past its own sentence", () => {
  // "…in USD, including taxes. Batch prices per 1M tokens." had the second
  // sentence removed with the first one's clause, and the batch table then
  // read as the standard rate.
  const parse = zhipuRows(
    [
      "## Pricing",
      "All prices are in USD, including taxes. Batch prices per 1M tokens.",
    ],
    "| glm-5.3 | 0.70 | - | - | 2.20 |"
  );
  assert.equal(parse.status, "not_found");
});

test("a cell may spell the currency out", () => {
  for (const currency of [
    "US dollars",
    "U.S. dollars",
    "United States dollars",
    "American dollars",
  ]) {
    assert.equal(
      zhipuRows(
        ["## Text Models"],
        `| glm-5.3 | ${currency} 1.40 per million tokens | ${currency} 0.20 per million tokens | - | ${currency} 4.40 per million tokens |`
      ).fields?.inputUsdPerMillionTokens,
      1.4,
      currency
    );
  }
});
