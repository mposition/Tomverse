import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV,
  resolveAmuxV19ClaimCheckoutPath } from
  "../lib/amux/ideaLocalSessionCheckoutPath.mjs";

test("only a claim repository under the configured root selects checkout bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amux-v19-claim-repo-"));
  const previous = process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV];
  try {
    const root = join(directory, "mirrors");
    const selected = join(root, "owner", "repo");
    await mkdir(selected, { recursive: true });
    const outside = join(directory, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(root, "owner", "escape"),
        process.platform === "win32" ? "junction" : "dir");
      await symlink(selected, join(root, "owner", "alias"),
        process.platform === "win32" ? "junction" : "dir");
      process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = root;
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/escape"), null);
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/alias"), null);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    }
    process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = root;
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"),
      await realpath(selected));
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("OWNER/REPO"),
      await realpath(selected));
    for (const slug of ["owner/..", "../repo", "owner/missing",
      "owner/repo/extra", "owner\\repo"]) {
      assert.equal(await resolveAmuxV19ClaimCheckoutPath(slug), null);
    }
    process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = "relative/path";
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"), null);
  } finally {
    if (previous === undefined) delete process.env[
      AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV];
    else process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
