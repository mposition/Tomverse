import assert from "node:assert/strict";
import test from "node:test";
import { HELP_GUIDES } from "../lib/helpCentre/catalog.ts";
import { HELP_COPY } from "../lib/helpCentre/copy/index.ts";
import {
  helpAssistantCorpus,
  helpAssistantOutputSchema,
  helpAssistantPrompt,
  helpAssistantSystem,
  parseHelpAssistantOutput,
} from "../lib/helpAssistantCore.ts";
import {
  helpAssistantAvailable,
  helpAssistantEnabledFromValue,
  helpAssistantKillSwitchEngaged,
} from "../lib/helpAssistantAccess.ts";

const NOT_FOUND = "not found";
const realGuide = HELP_GUIDES.find((guide) => guide.steps.length >= 3);

test("an answer citing a real guide and step is kept", () => {
  const answer = parseHelpAssistantOutput(
    {
      status: "answered",
      summary: "Do this.",
      steps: [{ text: "Open it.", guideId: realGuide.id, step: 2 }],
      note: null,
      guideIds: [realGuide.id],
    },
    NOT_FOUND
  );
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.guideIds, [realGuide.id]);
  assert.deepEqual(answer.steps, [{ text: "Open it.", guideId: realGuide.id, step: 2 }]);
});

test("citations to guides or steps that do not exist are dropped", () => {
  const answer = parseHelpAssistantOutput(
    {
      status: "answered",
      summary: "Do this.",
      steps: [
        { text: "A", guideId: "made-up-guide", step: 1 },
        { text: "B", guideId: realGuide.id, step: 99 },
      ],
      note: "",
      guideIds: ["made-up-guide", realGuide.id],
    },
    NOT_FOUND
  );
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.guideIds, [realGuide.id]);
  assert.deepEqual(answer.steps[0], { text: "A", guideId: null, step: null });
  assert.deepEqual(answer.steps[1], { text: "B", guideId: realGuide.id, step: null });
  assert.equal(answer.note, null);
});

test("a citation copied from the corpus label still counts as the real guide", () => {
  // The corpus shows guides as [guide:<id>]; models often copy the label whole.
  const answer = parseHelpAssistantOutput(
    {
      status: "answered",
      summary: "Attach the photo and say what to change.",
      steps: [
        { text: "Attach the photo.", guideId: "guide:edit-photo", step: 1 },
        { text: "Write the change.", guideId: "[guide:edit-photo]", step: 2 },
        { text: "Send it.", guideId: " Guide: edit-photo ", step: 3 },
      ],
      note: null,
      guideIds: ["[guide:edit-photo]"],
    },
    NOT_FOUND
  );
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.guideIds, ["edit-photo"]);
  assert.deepEqual(
    answer.steps.map((step) => [step.guideId, step.step]),
    [
      ["edit-photo", 1],
      ["edit-photo", 2],
      ["edit-photo", 3],
    ]
  );
});

test("a wrapped id that is not a real guide is still dropped", () => {
  const answer = parseHelpAssistantOutput(
    { status: "answered", summary: "Trust me.", steps: [], note: null, guideIds: ["[guide:made-up]", "guide:"] },
    NOT_FOUND
  );
  assert.deepEqual(answer, { status: "not_found", summary: NOT_FOUND });
});

test("an answer that cites nothing real is shown as not found", () => {
  const answer = parseHelpAssistantOutput(
    { status: "answered", summary: "Trust me.", steps: [{ text: "x", guideId: "nope", step: 1 }], note: null, guideIds: ["nope"] },
    NOT_FOUND
  );
  assert.deepEqual(answer, { status: "not_found", summary: NOT_FOUND });
});

test("malformed output never throws", () => {
  for (const output of [undefined, null, "text", 42, [], { status: "answered" }, { status: "maybe" }]) {
    const answer = parseHelpAssistantOutput(output, NOT_FOUND);
    assert.equal(answer.status, "not_found");
  }
  assert.deepEqual(parseHelpAssistantOutput({ status: "not_found", summary: "Not in the guides." }, NOT_FOUND), {
    status: "not_found",
    summary: "Not in the guides.",
  });
});

test("the corpus carries every guide id and the system prompt pins the language and the rules", () => {
  const corpus = helpAssistantCorpus(HELP_COPY.ko);
  for (const guide of HELP_GUIDES) assert.ok(corpus.includes(`[guide:${guide.id}]`), guide.id);
  const system = helpAssistantSystem("de", HELP_COPY.de, realGuide.id);
  assert.match(system, /Write every string in German\./);
  assert.match(system, /ONLY from the help guides/);
  assert.match(system, new RegExp(`currently looking at \\[guide:${realGuide.id}\\]`));
  assert.doesNotMatch(helpAssistantSystem("en", HELP_COPY.en, "not-a-guide"), /currently looking at/);
});

test("the prompt keeps only the recent history", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `turn ${index}` }));
  const prompt = helpAssistantPrompt("why?", history);
  assert.doesNotMatch(prompt, /turn 3\n/);
  assert.match(prompt, /turn 9/);
  assert.match(prompt, /Reader's question:\nwhy\?$/);
  assert.equal(helpAssistantOutputSchema().required.includes("guideIds"), true);
});

test("the switch is default-off and the kill switch wins", () => {
  assert.equal(helpAssistantEnabledFromValue(undefined), false);
  assert.equal(helpAssistantEnabledFromValue("TRUE"), false);
  assert.equal(helpAssistantEnabledFromValue("true"), true);
  assert.equal(helpAssistantKillSwitchEngaged({ HELP_ASSISTANT_KILL_SWITCH: " " }), false);
  assert.equal(helpAssistantAvailable({ storedFlagValue: "true", env: { HELP_ASSISTANT_KILL_SWITCH: "1" } }), false);
  assert.equal(helpAssistantAvailable({ storedFlagValue: "true", env: {} }), true);
});
