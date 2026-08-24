import assert from "node:assert/strict";
import test from "node:test";

import { ENABLED_MODELS } from "../lib/models.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";
import {
  ARTIFACT_TOOL_CAPABILITIES,
  getArtifactToolSupport,
  nativeSearchBlocksArtifactTool,
  planGeneratedArtifactTool,
} from "../lib/generatedArtifactToolPolicy.ts";

// docs/policy/generated-artifacts.md sections 2, 7 and 10.

const plan = (overrides = {}) =>
  planGeneratedArtifactTool({
    modelId: "gpt-5-6-luna",
    provider: "openai",
    isAuthenticated: true,
    canPersist: true,
    nativeSearchEnabled: false,
    nativeSearchForced: false,
    conversationKind: "chat",
    ...overrides,
  });

/* -------------------------------------------------------------------------- */
/* The decision                                                                 */
/* -------------------------------------------------------------------------- */

test("a signed-in account on a verified model gets the tool", () => {
  const result = plan();
  assert.equal(result.mode, "generate");
  assert.equal(result.registerTool, true);
});

test("a guest gets the tool, and it refuses", () => {
  // Registered rather than omitted: the refusal is what draws the sign-in
  // card. Omitting it would leave the model free to answer with a table.
  const result = plan({ isAuthenticated: false });
  assert.equal(result.mode, "sign_in_required");
  assert.equal(result.registerTool, true);
});

test("an unverified model refuses out loud rather than silently", () => {
  const result = plan({ modelId: "grok-4-5", provider: "xai" });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "model_unverified");
  assert.equal(result.registerTool, false);
});

test("a turn with nowhere to attach a file says so, and does not say 'sign in'", () => {
  const result = plan({ canPersist: false });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "no_conversation");
  // A signed-in account being told to sign in is a dead end.
  assert.ok(!/sign(ed)? in/i.test(result.systemPrompt));
});

test("an image conversation is out of scope before anything else is considered", () => {
  const result = plan({ conversationKind: "image", isAuthenticated: false });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "not_a_chat_conversation");
});

test("every plan carries a system block, including every refusal", () => {
  for (const overrides of [
    {},
    { isAuthenticated: false },
    { modelId: "grok-4-5", provider: "xai" },
    { canPersist: false },
    { conversationKind: "image" },
    { nativeSearchEnabled: true, nativeSearchForced: true },
  ]) {
    const result = plan(overrides);
    assert.ok(
      result.systemPrompt.trim().length > 0,
      JSON.stringify(overrides)
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Web search coexistence                                                       */
/* -------------------------------------------------------------------------- */

test("a forced native search keeps the turn, and the file request is refused", () => {
  // `toolChoice: "required"` means "call *a* tool". A second tool would let
  // the model satisfy it without searching, so "always search" would quietly
  // stop meaning always.
  const result = plan({ nativeSearchEnabled: true, nativeSearchForced: true });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "native_search_conflict");
  assert.match(result.systemPrompt, /web search/i);
});

test("Google grounding and function declarations are never sent together", () => {
  const result = plan({
    modelId: "gemini-3-6-flash",
    provider: "google",
    nativeSearchEnabled: true,
    nativeSearchForced: false,
  });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "native_search_conflict");
});

test("Anthropic's web search coexists with the artifact tool", () => {
  const result = plan({
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    nativeSearchEnabled: true,
    nativeSearchForced: false,
  });
  assert.equal(result.mode, "generate");
  assert.equal(result.registerTool, true);
});

test("search that is not running blocks nothing", () => {
  assert.equal(
    nativeSearchBlocksArtifactTool({
      provider: "google",
      nativeSearchEnabled: false,
      nativeSearchForced: true,
    }),
    false
  );
});

test("the forced-search rule reads the capability, not the provider name", () => {
  // OpenAI is the only provider whose native tool can be forced, and
  // lib/webSearchCapability.ts is where that is recorded. The two must not
  // drift into separate opinions.
  assert.equal(getWebSearchCapability("gpt-5-6-luna").canForceExecution, true);
  assert.equal(getWebSearchCapability("claude-sonnet-5").canForceExecution, false);
  assert.equal(getWebSearchCapability("gemini-3-6-flash").canForceExecution, false);
});

/* -------------------------------------------------------------------------- */
/* The instructions                                                             */
/* -------------------------------------------------------------------------- */

test("the generate prompt forbids every shape of a faked result", () => {
  const prompt = plan().systemPrompt;
  for (const forbidden of ["base64", "data URL", "file path", "download link"]) {
    assert.ok(prompt.includes(forbidden), forbidden);
  }
  assert.match(prompt, /Never substitute CSV/);
  assert.match(prompt, /not supported/);
});

test("the generate prompt names every tool and every format group", () => {
  const prompt = plan().systemPrompt;
  for (const name of [
    "create_spreadsheet",
    "create_document",
    "create_presentation",
    "create_text_file",
    "create_archive",
  ]) {
    assert.ok(prompt.includes(name), name);
  }
  for (const format of ["xlsx", "docx", "pptx", "pdf", "json", "yaml", "sql", "py", "zip"]) {
    assert.ok(prompt.includes(format), format);
  }
});

test("the generate prompt forbids announcing a file before the tool has made one", () => {
  // The failure this closes: a model wrote "이제 웹페이지를 만들겠습니다:",
  // began a `create_text_file` call, and was cut off by the output ceiling
  // before it ran. The server now records that as a `turn_incomplete` card
  // (lib/generatedArtifactTurnTracker.ts) -- this is the half that stops the
  // promise being made in the first place.
  const prompt = plan().systemPrompt;
  assert.match(prompt, /Call the tool first/);
  assert.match(prompt, /`created`/);
  assert.match(prompt, /progress promise/);
});

test("the generate prompt asks for a lean file and a narrower scope over a doomed call", () => {
  const prompt = plan().systemPrompt;
  // Padding is what puts a call over the ceiling, and a call over the ceiling
  // produces no file at all.
  assert.match(prompt, /no repeated blocks/);
  assert.match(prompt, /restating what the next line does/);
  // And when it plainly will not fit, asking is the answer -- not starting a
  // call that cannot finish.
  assert.match(prompt, /ask the user to narrow it/);
  assert.match(prompt, /Do not begin a call you cannot finish/);
});

test("the generate prompt says which extensions are refused outright", () => {
  const prompt = plan().systemPrompt;
  // A refusal the model can state is what keeps it from inventing a link
  // instead (policy section 4).
  for (const refused of ["exe", "dll", "msi", "bat"]) {
    assert.ok(prompt.includes(refused), refused);
  }
});

test("the guest prompt refuses the same four substitutes", () => {
  const prompt = plan({ isAuthenticated: false }).systemPrompt;
  assert.match(prompt, /table/);
  assert.match(prompt, /CSV text/);
  assert.match(prompt, /base64/);
  assert.match(prompt, /link/);
});

test("an off prompt tells the user what would actually help", () => {
  assert.match(
    plan({ modelId: "grok-4-5", provider: "xai" }).systemPrompt,
    /different model/
  );
  assert.match(
    plan({ nativeSearchEnabled: true, nativeSearchForced: true }).systemPrompt,
    /web search off/
  );
});

/* -------------------------------------------------------------------------- */
/* The capability registry                                                      */
/* -------------------------------------------------------------------------- */

test("an unknown model is unverified rather than assumed to work", () => {
  assert.equal(getArtifactToolSupport("a-model-nobody-added"), "unverified");
});

test("every registered model is a real catalogue id", () => {
  // A typo here is silent: the model simply never gets the tool, and nothing
  // says so. Guarding it against the catalogue is what makes the registry a
  // claim rather than a wish.
  const catalogue = new Set(ENABLED_MODELS.map((model) => model.id));
  for (const modelId of Object.keys(ARTIFACT_TOOL_CAPABILITIES)) {
    assert.ok(catalogue.has(modelId), `${modelId} is not an enabled model`);
  }
});

test("Perplexity's models stay out of the registry", () => {
  // Their search models answer from a retrieval loop this app does not drive,
  // and the deep research model never reaches the streaming path at all.
  for (const modelId of Object.keys(ARTIFACT_TOOL_CAPABILITIES)) {
    assert.ok(!modelId.startsWith("perplexity/"), modelId);
  }
});

/* -------------------------------------------------------------------------- */
/* Turn attachments and the document batch                                      */
/* -------------------------------------------------------------------------- */

// docs/policy/generated-artifacts.md section 13.

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const attached = (...types) =>
  types.map((mediaType, index) => ({
    handle: `att_${index + 1}`,
    name: `file-${index + 1}`,
    mediaType,
    byteSize: 1024,
  }));

test("a turn with no attachments does not register the batch tool", () => {
  const result = plan();
  assert.equal(result.registerDocumentBatch, false);
  assert.equal(result.systemPrompt.includes("create_document_batch"), false);
});

test("a Word template on the turn registers the batch tool", () => {
  const result = plan({ turnAttachments: attached(DOCX, XLSX) });
  assert.equal(result.registerDocumentBatch, true);
  assert.match(result.systemPrompt, /create_document_batch/);
  assert.match(result.systemPrompt, /templateAttachment: "att_1"/);
  assert.match(result.systemPrompt, /dataAttachment: "att_2"/);
});

// A spreadsheet on its own has nothing to fill. Registering the tool would be
// offering a capability with no input, and a model offered one eventually
// reaches for it with an invented handle.
test("a spreadsheet with no template does not register the batch tool", () => {
  const result = plan({ turnAttachments: attached(XLSX) });
  assert.equal(result.registerDocumentBatch, false);
});

test("a template with no data still registers, and the prompt asks for the data", () => {
  const result = plan({ turnAttachments: attached(DOCX) });
  assert.equal(result.registerDocumentBatch, true);
  assert.match(result.systemPrompt, /has not attached/);
});

// The rule the whole handle scheme exists for: a model's handle can end up
// quoted in an answer, so it must not be a storage key or a row id.
test("the attachment section names handles and forbids everything else", () => {
  const result = plan({ turnAttachments: attached(DOCX, XLSX) });
  assert.match(result.systemPrompt, /`att_1` -- "file-1"/);
  assert.match(result.systemPrompt, /storage key/);
  assert.match(result.systemPrompt, /Refer to these files ONLY by the handle/);
});

test("a guest turn never registers the batch tool, whatever is attached", () => {
  const result = plan({
    isAuthenticated: false,
    turnAttachments: attached(DOCX, XLSX),
  });
  assert.equal(result.registerDocumentBatch, false);
});

/* -------------------------------------------------------------------------- */
/* What "three files" means                                                     */
/* -------------------------------------------------------------------------- */

// The refusal this wording exists to remove: a model told "3 files per answer"
// concluded it could not produce ten documents. Three is the ceiling on
// top-level attachments; an archive is one of them and holds a hundred.
test("the prompt says three is a top-level limit and an archive holds a hundred", () => {
  const prompt = plan().systemPrompt;
  assert.match(prompt, /top-level/);
  assert.match(prompt, /an archive counts as one attachment/);
  assert.match(prompt, /100 files/);
  assert.match(prompt, /refusing it as over the three-file limit would/);
});

test("the prompt never states a bare per-answer file limit", () => {
  const prompt = plan().systemPrompt;
  // The old wording was "3 files per answer", which is the sentence a model
  // read as "you cannot make ten documents".
  assert.equal(/\d+ files per answer/.test(prompt), false);
});
