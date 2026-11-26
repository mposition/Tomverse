import test from "node:test";
import assert from "node:assert/strict";
import { ImportRequestError } from "../../../lib/assistantPackageImportClient";
import { createDesktopImportRequests, pickDesktopPackage, type AssistantImportCall } from "../src/renderer/assistant-import-requests";
import type { AssistantImportInput } from "../src/assistant-import-contract";

function recorder(answer: (input: AssistantImportInput) => unknown) {
  const sent: AssistantImportInput[] = [];
  const call = (async (input: AssistantImportInput) => { sent.push(input); return answer(input); }) as unknown as AssistantImportCall;
  return { call, sent };
}
const identity = { name: "Helper", icon: null, description: null };

test("each request of the wizard becomes the typed action the main process knows", async () => {
  const { call, sent } = recorder(input => ({ ok: true, value: input.action === "upload" ? { id: "file_1" } : { id: "imp_1" } }));
  const requests = createDesktopImportRequests(call);
  const body = { mode: "create" as const, identity, stagingManifest: {}, declared: { sourceKind: null, sourceName: null, sourceUrl: null, previousProvenance: null } };
  await requests.createImport(body);
  // The type the wizard derived is not sent: the main process derives its own from the name.
  assert.deepEqual(await requests.uploadDocument("imp_1", { filename: "a.md", mime: "text/markdown", bytes: new Uint8Array([1]) }), { id: "file_1" });
  await requests.readImport("imp_1");
  await requests.cancelImport("imp_1");
  const publish = { approvedDigest: "d", digestVersion: 1, keepFileIds: [], identity,
    draft: { instructions: "", modelIds: [], toolPolicy: { webSearch: false, deepResearch: false }, memoryPolicy: { useAccountMemory: false }, starters: [] } };
  await requests.publishImport("imp_1", publish);
  assert.deepEqual(sent, [
    { action: "create", body },
    { action: "upload", importId: "imp_1", filename: "a.md", bytes: new Uint8Array([1]) },
    { action: "read", importId: "imp_1" },
    { action: "cancel", importId: "imp_1" },
    { action: "publish", importId: "imp_1", body: publish },
  ]);
});

test("a refusal becomes the error the wizard already renders, with the server's status and code", async () => {
  const requests = createDesktopImportRequests(recorder(() => ({ ok: false, status: 409, code: "ASSISTANT_PROFILE_VERSION_STALE" })).call);
  await assert.rejects(requests.readImport("imp_1"), (error: unknown) =>
    error instanceof ImportRequestError && error.status === 409 && error.code === "ASSISTANT_PROFILE_VERSION_STALE");
  await assert.rejects(requests.cancelImport("imp_1"), ImportRequestError);
});

test("the package dialog hands the wizard a file, nothing, or the refusal the main process already decided", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
  const picked = await pickDesktopPackage(recorder(() => ({ ok: true, value: { kind: "picked", name: "skill.zip", bytes } })).call);
  assert.ok(picked && "file" in picked);
  assert.equal(picked.file.name, "skill.zip");
  assert.equal(picked.file.size, 4);
  assert.deepEqual(new Uint8Array(await picked.file.arrayBuffer()), bytes);
  assert.equal(await pickDesktopPackage(recorder(() => ({ ok: true, value: { kind: "cancelled" } })).call), null);
  assert.deepEqual(await pickDesktopPackage(recorder(() => ({ ok: true, value: { kind: "refused", code: "ASSISTANT_PACKAGE_TOO_LARGE", name: "big.zip", size: 70_000_000 } })).call),
    { refused: "ASSISTANT_PACKAGE_TOO_LARGE", cause: "desktop_file_check", name: "big.zip", bytes: 70_000_000 });
  await assert.rejects(pickDesktopPackage(recorder(() => ({ ok: false, status: 0, code: "ASSISTANT_PACKAGE_IMPORT_FAILED" })).call), ImportRequestError);
});
