import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { IMAGE_MAX_BYTES, isSecretPath, type Workspace } from "../../../tomverse-cli/src/runtime.js";

/**
 * Files the person attaches to a Code request from outside the project (a screenshot, a pasted image, a log from
 * Downloads) are copied into this project folder, so the agent reads them with its own project tools: Tomverse's
 * read_file and view_image, or the provider CLI's. The folder ignores itself in Git (its `.gitignore` is `*`), so the
 * copies never show up as changes to commit.
 */
export const CODE_ATTACHMENT_FOLDER = ".tomverse-attachments";
/** One copied file at most. */
export const CODE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** One image at most: what view_image reads, so an attached image is one the agent can see. */
export const CODE_ATTACHMENT_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
/** What a pasted clipboard image may be: the types the agents' image tools read. */
export const CODE_PASTE_IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" } as const;

export class CodeAttachmentRefused extends Error {}

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** A name made only of letters, digits, `.`, `-` and `_`, without a leading dot, kept short; the extension stays. */
export function attachmentFileName(name: string, now = new Date(), fallbackExtension = "") {
  const extension = (extname(name) || fallbackExtension).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const stem = basename(name, extname(name)).normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "attachment";
  return `${stamp(now)}-${stem}${extension}`;
}

async function attachmentFolder(root: string) {
  const folder = join(root, CODE_ATTACHMENT_FOLDER);
  await mkdir(folder, { recursive: true });
  // A link could point the copies anywhere; only a real folder is written to.
  if (!(await lstat(folder)).isDirectory()) throw new CodeAttachmentRefused("The attachment folder is not a folder.");
  const ignore = join(folder, ".gitignore");
  await writeFile(ignore, "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  // A folder that would not keep the copies out of Git is not used: an existing .gitignore must be this app's own.
  if (!(await lstat(ignore)).isFile() || (await readFile(ignore, "utf8")) !== "*\n") throw new CodeAttachmentRefused("The attachment folder is not ignored by Git.");
  return folder;
}

/** Writes the bytes as a new file of the attachment folder and returns its path; an existing file is never replaced. */
async function writeAttachment(root: string, name: string, bytes: Uint8Array) {
  const folder = await attachmentFolder(root);
  const extension = extname(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = join(folder, attempt ? `${basename(name, extension)}-${attempt + 1}${extension}` : name);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new CodeAttachmentRefused("No free attachment name.");
}

/** Copies a file the person chose outside the project; a credential file by name, an empty or too large file is refused. */
export async function copyOutsideFile(root: string, source: string, now = new Date()) {
  // The name the person chose and the file it really is are both checked: a link cannot bring a credential file in.
  const real = await realpath(source);
  if (isSecretPath(source) || isSecretPath(real)) throw new CodeAttachmentRefused("The file can hold credentials.");
  const limit = imageExtensions.has(extname(real).toLowerCase()) || imageExtensions.has(extname(source).toLowerCase())
    ? CODE_ATTACHMENT_IMAGE_MAX_BYTES : CODE_ATTACHMENT_MAX_BYTES;
  // Read from the one open file, at most one byte past the limit, so a file that grows meanwhile is refused, not copied whole.
  const handle = await open(real, "r");
  let bytes: Uint8Array;
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > limit) throw new CodeAttachmentRefused("The file cannot be attached.");
    const buffer = new Uint8Array(limit + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new CodeAttachmentRefused("The file cannot be attached.");
    }
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  if (!bytes.byteLength) throw new CodeAttachmentRefused("The file cannot be attached.");
  return writeAttachment(root, attachmentFileName(basename(source), now), bytes);
}

/** Saves an image pasted into the Code composer. */
export async function savePastedImage(root: string, input: { name: string; mediaType: string; bytes: Uint8Array }, now = new Date()) {
  const extension = CODE_PASTE_IMAGE_TYPES[input.mediaType as keyof typeof CODE_PASTE_IMAGE_TYPES];
  if (!extension || !input.bytes.byteLength || input.bytes.byteLength > CODE_ATTACHMENT_IMAGE_MAX_BYTES) throw new CodeAttachmentRefused("The image cannot be attached.");
  const stem = basename(input.name || "pasted-image", extname(input.name || ""));
  return writeAttachment(root, attachmentFileName(stem + extension, now), input.bytes);
}

const isCopyPath = (path: string) => {
  const parts = path.split("/");
  return parts.length === 2 && parts[0] === CODE_ATTACHMENT_FOLDER && parts[1] !== ".gitignore";
};

/**
 * Deletes a copy this app made, when the person takes it off the draft. The caller passes only references it copied
 * itself (main.ts keeps them); a path outside the attachment folder is left alone as well.
 */
export async function discardAttachmentCopy(workspace: Workspace, path: string) {
  if (!isCopyPath(path)) return;
  // The copy's own path is removed, never what it might point to now: a folder or file that became a link is left alone.
  const folder = join(workspace.root, CODE_ATTACHMENT_FOLDER);
  const file = join(folder, path.split("/")[1]!);
  const [folderInfo, fileInfo] = await Promise.all([lstat(folder).catch(() => null), lstat(file).catch(() => null)]);
  if (!folderInfo?.isDirectory() || !fileInfo?.isFile()) return;
  await rm(file);
}

/** Takes carried copies back out of a worktree that did not start, so it can be discarded as unchanged. */
export async function removeCarriedCopies(targetRoot: string) {
  await rm(join(targetRoot, CODE_ATTACHMENT_FOLDER), { recursive: true, force: true });
}

/** Puts the copies a task names into a new worktree of the project, at the same paths: Git does not carry them. */
export async function carryAttachmentCopies(source: Workspace, targetRoot: string, paths: readonly string[]) {
  const folder = paths.length ? await attachmentFolder(targetRoot) : "";
  for (const path of paths) {
    if (!isCopyPath(path)) throw new CodeAttachmentRefused("Only attachment copies are carried.");
    const bytes = await readFile(source.resolve(path, "read").absolute);
    await writeFile(join(folder, path.split("/")[1]!), bytes, { flag: "wx" });
  }
}
