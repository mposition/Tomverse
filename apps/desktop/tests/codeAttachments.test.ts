import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../../tomverse-cli/src/runtime.js";
import { attachmentFileName, carryAttachmentCopies, CODE_ATTACHMENT_FOLDER, CODE_ATTACHMENT_IMAGE_MAX_BYTES, CODE_ATTACHMENT_MAX_BYTES, copyOutsideFile,
  discardAttachmentCopy, savePastedImage } from "../src/host/code-attachments";

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
    // An image is held to what view_image reads, so an attached image is one the agent can see.
    const bigImage = join(tmp, "big.png");
    await writeFile(bigImage, new Uint8Array(CODE_ATTACHMENT_IMAGE_MAX_BYTES + 1));
    await assert.rejects(copyOutsideFile(root, bigImage));
    await assert.rejects(savePastedImage(root, { name: "big.png", mediaType: "image/png", bytes: new Uint8Array(CODE_ATTACHMENT_IMAGE_MAX_BYTES + 1) }));
    const bigText = join(tmp, "big.log");
    await writeFile(bigText, new Uint8Array(CODE_ATTACHMENT_IMAGE_MAX_BYTES + 1));
    await copyOutsideFile(root, bigText, now);

    // A new worktree gets the copies at the same paths; anything outside the attachment folder is refused.
    const checkout = join(tmp, "checkout");
    await mkdir(checkout);
    await carryAttachmentCopies(workspace, checkout, [workspace.reference(pasted).path]);
    assert.deepEqual(await readFile(join(checkout, CODE_ATTACHMENT_FOLDER, "20261128-123456-image.png")), Buffer.from([1, 2, 3]));
    assert.equal(await readFile(join(checkout, CODE_ATTACHMENT_FOLDER, ".gitignore"), "utf8"), "*\n");
    await assert.rejects(carryAttachmentCopies(workspace, checkout, ["own.txt"]));

    // Taking a copy off the draft deletes it; a project file of the person's own and the .gitignore are never touched.
    await writeFile(join(root, "own.txt"), "mine");
    await discardAttachmentCopy(workspace, workspace.reference(copy).path);
    await discardAttachmentCopy(workspace, "own.txt");
    await discardAttachmentCopy(workspace, `${CODE_ATTACHMENT_FOLDER}/.gitignore`);
    assert.equal(await readFile(join(root, "own.txt"), "utf8"), "mine");
    assert.deepEqual((await readdir(join(root, CODE_ATTACHMENT_FOLDER))).sort(),
      [".gitignore", "20261128-123456-big.log", "20261128-123456-image.png", "20261128-123456-shot-2.png"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("A link to a credential file and a folder Git would not ignore are refused", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "code-attach-refuse-"));
  try {
    const root = join(tmp, "project");
    await mkdir(join(root, CODE_ATTACHMENT_FOLDER), { recursive: true });
    const outside = join(tmp, "notes.txt");
    await writeFile(outside, "notes");
    // An attachment folder whose .gitignore is not this app's own would let the copies reach a commit.
    await writeFile(join(root, CODE_ATTACHMENT_FOLDER, ".gitignore"), "");
    await assert.rejects(copyOutsideFile(root, outside, now));
    await writeFile(join(root, CODE_ATTACHMENT_FOLDER, ".gitignore"), "*\n");
    await copyOutsideFile(root, outside, now);

    const key = join(tmp, ".ssh", "id_ed25519");
    await mkdir(join(tmp, ".ssh"));
    await writeFile(key, "private");
    const link = join(tmp, "harmless.txt");
    const linked = await symlink(key, link, "file").then(() => true, () => false);
    if (linked) await assert.rejects(copyOutsideFile(root, link, now), "the file a link points to is checked too");

    // A copy that became a link is not followed when it is taken off the draft: the file it points to stays.
    const target = join(root, "target.txt");
    await writeFile(target, "keep");
    const swapped = join(root, CODE_ATTACHMENT_FOLDER, "20261128-123456-swapped.txt");
    if (await symlink(target, swapped, "file").then(() => true, () => false)) {
      await discardAttachmentCopy(new Workspace(root, [join(tmp, "app-data")]), CODE_ATTACHMENT_FOLDER + "/20261128-123456-swapped.txt");
      assert.equal(await readFile(target, "utf8"), "keep");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("A failed carry into a worktree takes out only what it wrote, never what the branch had", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "code-attach-carry-"));
  try {
    const source = join(tmp, "project");
    const checkout = join(tmp, "checkout");
    await mkdir(join(source, CODE_ATTACHMENT_FOLDER), { recursive: true });
    await mkdir(join(checkout, CODE_ATTACHMENT_FOLDER), { recursive: true });
    await writeFile(join(source, CODE_ATTACHMENT_FOLDER, ".gitignore"), "*\n");
    await writeFile(join(source, CODE_ATTACHMENT_FOLDER, "a.png"), "a");
    // The branch already tracks a file there, and one of the copies is gone: nothing of the branch's is removed.
    await writeFile(join(checkout, CODE_ATTACHMENT_FOLDER, "tracked.txt"), "tracked");
    const workspace = new Workspace(source, [join(tmp, "app-data")]);
    await assert.rejects(carryAttachmentCopies(workspace, checkout, [`${CODE_ATTACHMENT_FOLDER}/a.png`, `${CODE_ATTACHMENT_FOLDER}/missing.png`]));
    assert.deepEqual(await readdir(join(checkout, CODE_ATTACHMENT_FOLDER)), ["tracked.txt"]);
    // A check after the copies (the connection changed meanwhile) takes them out the same way.
    await assert.rejects(carryAttachmentCopies(workspace, checkout, [`${CODE_ATTACHMENT_FOLDER}/a.png`], () => { throw new Error("changed"); }), /changed/);
    assert.deepEqual(await readdir(join(checkout, CODE_ATTACHMENT_FOLDER)), ["tracked.txt"]);
    // With no folder of its own the branch is left without one.
    const fresh = join(tmp, "fresh");
    await mkdir(fresh);
    await assert.rejects(carryAttachmentCopies(workspace, fresh, [`${CODE_ATTACHMENT_FOLDER}/missing.png`]));
    assert.deepEqual(await readdir(fresh), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
