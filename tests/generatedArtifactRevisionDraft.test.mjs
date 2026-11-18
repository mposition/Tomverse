import assert from "node:assert/strict";
import test from "node:test";
import { appendArtifactRevisionDraft, artifactRevisionDraftConflict } from "../lib/generatedArtifactRevisionDraft.ts";
import { draftKeyFor, readDraftEntry, writeDraftEntry } from "../lib/conversationDraftStore.ts";
import { CHAT_MAX_ATTACHMENTS_PER_MESSAGE } from "../lib/chatAttachmentLimits.ts";

const file = (name, uploadId = name) => ({ id: uploadId, uploadId, name, mediaType: "text/plain", size: 12, kind: "text" });

test("the visible request is prepended to the latest text and keeps unrelated files", () => {
  const before = { text: "Typed while preparing", attachments: [file("notes.txt")] };
  const result = appendArtifactRevisionDraft(before, file("report.md", "copied-exact-artifact"), "Create a new report.md file.");
  assert.equal(result.conflict, null);
  assert.equal(result.draft.text, "Create a new report.md file.\n\nTyped while preparing");
  assert.equal(result.draft.attachments[0], before.attachments[0]);
  assert.equal(result.draft.attachments[1].uploadId, "copied-exact-artifact");
  assert.deepEqual(before, { text: "Typed while preparing", attachments: [file("notes.txt")] });
});

test("the same opaque upload cannot append a second request or chip", () => {
  const first = appendArtifactRevisionDraft({ text: "", attachments: [] }, file("same.md", "upload-1"), "Visible request").draft;
  const again = appendArtifactRevisionDraft(first, file("same.md", "upload-1"), "Visible request");
  assert.equal(again.draft, first);
  assert.equal(again.conflict, null);
});

test("same-name inputs and the attachment limit preserve the entire draft", () => {
  const nameCollision = { text: "Keep", attachments: [file("Report.MD", "other-upload")] };
  assert.equal(artifactRevisionDraftConflict(nameCollision, "report.md"), "name");
  assert.equal(appendArtifactRevisionDraft(nameCollision, file("report.md"), "New").draft, nameCollision);
  const full = { text: "Keep", attachments: Array.from({ length: CHAT_MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => file(`${i}.txt`)) };
  // Room below the limit is room: nine files still take the revision.
  const roomy = { text: "Keep", attachments: Array.from({ length: CHAT_MAX_ATTACHMENTS_PER_MESSAGE - 1 }, (_, i) => file(`${i}.txt`)) };
  assert.equal(artifactRevisionDraftConflict(roomy, "report.md"), null);
  assert.equal(appendArtifactRevisionDraft(full, file("report.md"), "New").conflict, "count");
  assert.equal(appendArtifactRevisionDraft(full, file("report.md"), "New").draft, full);
});

test("late completion updates only the original identity and conversation key", () => {
  const origin = draftKeyFor("origin-chat", "account:A");
  const otherChat = draftKeyFor("other-chat", "account:A");
  const otherAccount = draftKeyFor("origin-chat", "account:B");
  let store = { [origin]: { text: "Origin latest", attachments: [] },
    [otherChat]: { text: "Other conversation", attachments: [] },
    [otherAccount]: { text: "Other person", attachments: [] } };
  store = writeDraftEntry(store, origin, current => appendArtifactRevisionDraft(current, file("source.txt"), "Create new file").draft);
  assert.equal(readDraftEntry(store, origin).text, "Create new file\n\nOrigin latest");
  assert.equal(readDraftEntry(store, otherChat).text, "Other conversation");
  assert.equal(readDraftEntry(store, otherAccount).text, "Other person");
});
