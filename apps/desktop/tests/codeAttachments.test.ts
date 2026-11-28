import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../../tomverse-cli/src/runtime.js";
import { attachmentFileName, CODE_ATTACHMENT_FOLDER, CODE_ATTACHMENT_MAX_BYTES, copyOutsideFile, discardAttachmentCopy, savePastedImage } from "../src/host/code-attachments";

const now = new Date("2026-11-28T12:34:56.000Z");

test("Attachment names keep letters and the extension, never a path or a leading dot", () => {
  assert.equal(attachmentFileName("스크린샷 2026.png", now), "20261128-123456-스크린샷-2026.png");
  assert.equal(attachmentFileName("../../.env", now), "20261128-123456-env");
  assert.equal(attachmentFileName("", now, ".png"), "20261128-123456-attachment.png");
});

test("A file from outside the project and a pasted image land in the self-ignoring attachment folder", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "code-attach-"));
  try {
    const root = join(tmp, "project");
    await mkdir(root);
    const outside = join(tmp, "shot.png");
    await writeFile(outside, "png bytes");
    const copy = await copyOutsideFile(root, outside, now);
    const again = await copyOutsideFile(root, outside, now);
    assert.notEqual(copy, again, "an existing copy is never replaced");
    assert.equal(await readFile(copy, "utf8"), "png bytes");
    assert.equal(await readFile(join(root, CODE_ATTACHMENT_FOLDER, ".gitignore"), "utf8"), "*\n");
    const workspace = new Workspace(root, [join(tmp, "app-data")]);
    assert.deepEqual(workspace.reference(copy), { path: `${CODE_ATTACHMENT_FOLDER}/20261128-123456-shot.png`, kind: "file" });

    const pasted = await savePastedImage(root, { name: "image.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, now);
    assert.match(pasted, /20261128-123456-image\.png$/);
    await assert.rejects(savePastedImage(root, { name: "x.svg", mediaType: "image/svg+xml", bytes: new Uint8Array([1]) }));

    for (const refused of [join(tmp, ".env"), join(tmp, "id_rsa")]) {
      await writeFile(refused, "secret");
      await assert.rejects(copyOutsideFile(root, refused), refused);
    }
    const large = join(tmp, "large.bin");
    await writeFile(large, new Uint8Array(CODE_ATTACHMENT_MAX_BYTES + 1));
    await assert.rejects(copyOutsideFile(root, large));

    // Taking a copy off the draft deletes it; a project file of the person's own and the .gitignore are never touched.
    await writeFile(join(root, "own.txt"), "mine");
    await discardAttachmentCopy(workspace, workspace.reference(copy).path);
    await discardAttachmentCopy(workspace, "own.txt");
    await discardAttachmentCopy(workspace, `${CODE_ATTACHMENT_FOLDER}/.gitignore`);
    assert.equal(await readFile(join(root, "own.txt"), "utf8"), "mine");
    assert.deepEqual((await readdir(join(root, CODE_ATTACHMENT_FOLDER))).sort(),
      [".gitignore", "20261128-123456-image.png", "20261128-123456-shot-2.png"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
