import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    execFileSync("git", ["init", "--quiet", selected]);
    execFileSync("git", ["-C", selected, "remote", "add", "origin",
      "https://github.com/owner/repo.git"]);
    await writeFile(join(root, "owner", "notdir"), "synthetic");
    const outside = join(directory, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(root, "owner", "escape"),
        process.platform === "win32" ? "junction" : "dir");
      await symlink(selected, join(root, "owner", "alias"),
        process.platform === "win32" ? "junction" : "dir");
      await symlink(join(root, "owner"), join(root, "aliasowner"),
        process.platform === "win32" ? "junction" : "dir");
      process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = root;
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/escape"), null);
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/alias"), null);
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("aliasowner/repo"), null);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    }
    process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV] = root;
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"),
      await realpath(selected));
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("OWNER/REPO"),
      await realpath(selected));
    execFileSync("git", ["-C", selected, "remote", "set-url", "origin",
      "git@github.com:owner/repo.git"]);
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"),
      await realpath(selected));
    execFileSync("git", ["-C", selected, "remote", "remove", "origin"]);
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"), null);
    execFileSync("git", ["-C", selected, "remote", "add", "origin",
      "https://github.com/owner/repo.git"]);
    for (const remote of ["https://github.com/other/repo.git",
      "https://credential@github.com/owner/repo.git",
      "https://other.example/owner/repo.git"]) {
      execFileSync("git", ["-C", selected, "remote", "set-url", "origin",
        remote]);
      assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/repo"), null);
    }
    execFileSync("git", ["-C", selected, "remote", "set-url", "origin",
      "https://github.com/owner/repo.git"]);
    // A valid-looking parent origin must not make a non-repo child eligible.
    execFileSync("git", ["init", "--quiet", join(root, "owner")]);
    execFileSync("git", ["-C", join(root, "owner"), "remote", "add",
      "origin", "https://github.com/owner/fallback.git"]);
    await mkdir(join(root, "owner", "fallback"));
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/fallback"), null);
    // Gitdir pointer files are refused even if they name a valid local repo.
    await mkdir(join(root, "owner", "pointer"));
    await writeFile(join(root, "owner", "pointer", ".git"),
      `gitdir: ${join(selected, ".git")}\n`);
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/pointer"), null);
    assert.equal(await resolveAmuxV19ClaimCheckoutPath("owner/notdir"), null);
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
