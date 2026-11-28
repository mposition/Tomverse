import assert from "node:assert/strict";
import test from "node:test";

import {
  BRANCH_TITLE_MAX_CHARACTERS,
  branchTitle,
  isBranchableAnswer,
  messagesToCopy,
  omittedFilesNote,
  orderedCreatedAt,
  validBranchTemplate,
} from "../lib/chatBranchCore.ts";
import { chatAnswerSurfaceCopy } from "../locales/chatAnswerSurface.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

const at = (ms) => new Date(1_700_000_000_000 + ms);
const message = (id, role, extra = {}) => ({
  id,
  role,
  content: `${id} text`,
  status: "normal",
  modelId: null,
  supersededAt: null,
  researchRunId: null,
  createdAt: at(Number(id.slice(1)) * 1000),
  ...extra,
});

test("only a finished, standing, plain answer can start a branch", () => {
  assert.equal(isBranchableAnswer(message("a1", "assistant")), true);
  assert.equal(isBranchableAnswer(message("q1", "user")), false);
  assert.equal(isBranchableAnswer(message("a1", "assistant", { status: "error" })), false);
  assert.equal(isBranchableAnswer(message("a1", "assistant", { status: "incomplete" })), false);
  assert.equal(isBranchableAnswer(message("a1", "assistant", { supersededAt: at(5) })), false);
  assert.equal(isBranchableAnswer(message("a1", "assistant", { researchRunId: "run" })), false);
  assert.equal(isBranchableAnswer(message("a1", "assistant", { content: "  " })), false);
});

test("a branch copies standing finished turns up to the answer and nothing after it", () => {
  const all = [
    message("q1", "user"),
    message("a1", "assistant", { supersededAt: at(9) }),
    message("q2", "user"),
    message("a2", "assistant", { status: "error" }),
    message("q3", "user"),
    message("a3", "assistant"),
    message("q4", "user"),
    message("a4", "assistant"),
  ];
  assert.deepEqual(messagesToCopy(all, "a3")?.map((m) => m.id), ["q1", "q2", "q3", "a3"]);
  assert.equal(messagesToCopy(all, "missing"), null);
});

test("copied creation times keep the order even when the source times tie", () => {
  const times = orderedCreatedAt([at(0), at(0), at(0), at(1), at(1000)]);
  assert.deepEqual(times.map((time) => time.getTime() - at(0).getTime()), [0, 1, 2, 3, 1000]);
});

test("a client template is used only when short, plain and holding its placeholder", () => {
  assert.equal(validBranchTemplate("Branch: {title}", "{title}"), "Branch: {title}");
  assert.equal(validBranchTemplate("Branch", "{title}"), null);
  assert.equal(validBranchTemplate("x {names}", "{title}"), null);
  assert.equal(validBranchTemplate("a\n{names}", "{names}"), null);
  assert.equal(validBranchTemplate("{names}".padEnd(500, "x"), "{names}"), null);
  assert.equal(validBranchTemplate(5, "{names}"), null);
});

test("the new title is built from the original and stays within the title limit", () => {
  assert.equal(branchTitle("Quarterly numbers", null), "Branch: Quarterly numbers");
  assert.equal(branchTitle("  ", "分支：{title}"), "分支：New chat");
  const long = branchTitle("x".repeat(500), "Branch: {title}");
  assert.ok(long.length <= BRANCH_TITLE_MAX_CHARACTERS);
  assert.ok(long.startsWith("Branch: xxx") && long.endsWith("…"));
  // The file name may hold the replacement markers String.replace would expand.
  assert.equal(branchTitle("$& and $1", "{title}"), "$& and $1");
});

test("the note lists a few file names and counts the rest", () => {
  assert.equal(omittedFilesNote(["a.pdf", "b.csv"], null), "[Files not copied to this conversation: a.pdf, b.csv]");
  assert.equal(omittedFilesNote(["1", "2", "3", "4", "5", "6", "7"], "<{names}>"), "<1, 2, 3, 4, 5, +2>");
});

test("branch words exist in every language, with their placeholders", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const copy = chatAnswerSurfaceCopy[lang];
    assert.ok(copy.branchHere.length > 0 && copy.branchWorking.length > 0, lang);
    assert.ok(validBranchTemplate(copy.branchTitleTemplate, "{title}"), `${lang} title template`);
    assert.ok(validBranchTemplate(copy.branchFilesTemplate, "{names}"), `${lang} files template`);
  }
});
