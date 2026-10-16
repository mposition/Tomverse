import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeAmuxTrackedCheckout } from "../lib/amux/ideaTrackedCheckoutMaterialize.ts";

const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", windowsHide: true,
});

test("checkout contains only scanned bytes from the pinned tracked tree", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "amux-materialize-repo-"));
  let checkout;
  try {
    git(repositoryPath, "init", "--quiet");
    git(repositoryPath, "config", "core.autocrlf", "false");
    git(repositoryPath, "config", "user.name", "AMUX Test");
    git(repositoryPath, "config", "user.email", "amux-test@example.invalid");
    await mkdir(join(repositoryPath, "src"));
    await writeFile(join(repositoryPath, "src", "safe.txt"), "safe pinned bytes\n");
    await writeFile(join(repositoryPath, "src", "payload.txt"), `token=${"A".repeat(24)}\n`);
    await writeFile(join(repositoryPath, "src", "late.txt"),
      `${"ordinary text\n".repeat(2_000)}token=${"B".repeat(24)}\n`);
    await writeFile(join(repositoryPath, "src", "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(repositoryPath, ".env"), "path excluded before read\n");
    git(repositoryPath, "add", "--", "src", ".env");
    git(repositoryPath, "commit", "--quiet", "-m", "pinned");
    const pinned = git(repositoryPath, "rev-parse", "HEAD").trim();
    await writeFile(join(repositoryPath, "src", "safe.txt"), "changed worktree bytes\n");
    await writeFile(join(repositoryPath, "untracked.txt"), "not available\n");

    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(() => materializeAmuxTrackedCheckout({
      repositoryPath, commitSha: pinned, digestSecret: "d".repeat(32), signal: stopped.signal,
    }), /invalid_tree/);

    checkout = await materializeAmuxTrackedCheckout({
      repositoryPath, commitSha: pinned, digestSecret: "d".repeat(32),
    });
    assert.deepEqual(checkout.files, ["src/safe.txt"]);
    assert.deepEqual(checkout.excludedReasons, {
      secret_path: 1, secret_content: 2, non_regular: 0, unscannable_content: 1,
    });
    assert.equal(checkout.excludedCount, 4);
    assert.match(checkout.excludedPathDigest, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(checkout.directory, "src", "safe.txt"), "utf8"),
      "safe pinned bytes\n");
    assert.deepEqual(await readdir(join(checkout.directory, "src")), ["safe.txt"]);
  } finally {
    if (checkout) await rm(checkout.directory, { recursive: true, force: true });
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
