// Whether a bare partial clone gives the same report as a full checkout.
//
// S0 asks this because the agent's whole claim rests on it: the report is
// computed from two pinned commits in a clone the execution service makes with
// `--filter=blob:none`, and if that clone produced a different answer than a
// developer's own checkout, nobody reading the Admin screen could reproduce it.
//
// Entirely local -- a clone from a fixture repository on disk, over no network
// and with no credential. A partial clone from a local path still exercises the
// thing in question: whether the blobs the judgement reads are fetched on
// demand, and whether the bytes that come back are the same ones.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { gitSupportsPartialClone } from "../lib/productResearchObservationRunnerCore.mjs";
import {
  makeIssueBacklogFixture,
  runIssueBacklogCli,
} from "./support/issueBacklogFixtureRepo.mjs";

const git = (directory, ...argv) => {
  const result = spawnSync("git", argv, {
    cwd: directory,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // A fetch that reached outside this machine would make the result depend
      // on a network, which is the opposite of what this test is for.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * The pinned invocation, pointed at another repository.
 *
 * The CLI takes the first `--repository` it finds, so appending a second does
 * nothing; the value has to be replaced.
 */
const againstRepository = (args, repository) => {
  const next = [...args];
  next[next.indexOf("--repository") + 1] = repository;
  return next;
};

/** A `file://` URL git will accept on either platform. */
const fileUrl = (directory) => `file://${directory.replace(/\\/g, "/")}`;

const partialCloneAvailable = () => {
  const version = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return version.status === 0 && gitSupportsPartialClone(version.stdout);
};

const SKIP = partialCloneAvailable() ? false : "this git cannot make a partial clone";

test("a bare partial clone produces the same report, byte for byte", { skip: SKIP }, () => {
  const fixture = makeIssueBacklogFixture({
    number: 4242,
    title: "An issue the report has an opinion about",
    body: "",
  });
  const workspace = mkdtempSync(join(tmpdir(), "pr-partial-clone-"));

  try {
    // What a person running the CLI in their own checkout would get.
    const direct = runIssueBacklogCli(fixture.pinnedArgs());
    assert.equal(direct.status, 0, direct.stderr);
    assert.ok(direct.stdout.length > 0);

    // And the same report through a bare partial clone, which is how the
    // execution service reads those commits.
    const clone = join(workspace, "bare.git");
    const cloned = git(
      workspace,
      "clone",
      "--bare",
      "--filter=blob:none",
      "--no-tags",
      fileUrl(fixture.directory),
      clone,
    );
    assert.equal(cloned.status, 0, cloned.stderr);

    // The clone must actually hold the pinned commits; otherwise the comparison
    // below is between two runs of the same checkout.
    for (const sha of [fixture.develop, fixture.main]) {
      assert.equal(
        git(clone, "cat-file", "-e", `${sha}^{commit}`).status,
        0,
        `${sha} is not in the partial clone`,
      );
    }
    // And it must really be partial, or this proves nothing about the filter.
    const promisor = git(clone, "config", "--get", "remote.origin.promisor");
    assert.equal(promisor.stdout.trim(), "true", "the clone is not a partial one");

    const throughClone = runIssueBacklogCli(againstRepository(fixture.pinnedArgs(), clone));
    assert.equal(throughClone.status, 0, throughClone.stderr);

    // Byte for byte. A difference here would mean the Admin screen shows a
    // report nobody can reproduce from the commits it names.
    assert.equal(throughClone.stdout, direct.stdout);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    fixture.cleanUp();
  }
});

test("a pinned commit the clone cannot reach is refused, not answered around", { skip: SKIP }, () => {
  // A partial clone is a promisor remote: asking it for an object it does not
  // have fetches it on demand, so "the clone is missing a commit" is not a
  // failure mode while the remote is reachable -- the filter never changes the
  // answer, which is the S0 result worth knowing.
  //
  // The failure mode that remains is a commit that cannot be fetched at all:
  // force-pushed away, or a promisor that has gone. Then the report must refuse
  // rather than compute one release branch's answer and present it as both.
  const fixture = makeIssueBacklogFixture({ number: 7, title: "Another issue", body: "" });
  const workspace = mkdtempSync(join(tmpdir(), "pr-partial-clone-unreachable-"));
  try {
    // A commit of main's own, so it is not merely an ancestor of develop that a
    // develop-only clone would hold anyway.
    fixture.git("checkout", "--quiet", "main");
    writeFileSync(join(fixture.directory, "on-main.txt"), "main only\n");
    fixture.git("add", "-A");
    fixture.git("commit", "--quiet", "-m", "chore: a commit only main has");
    const mainTip = fixture.git("rev-parse", "HEAD");
    fixture.git("checkout", "--quiet", "--detach", fixture.develop);

    const clone = join(workspace, "develop-only.git");
    const cloned = git(
      workspace,
      "clone",
      "--bare",
      "--filter=blob:none",
      "--no-tags",
      "--single-branch",
      "--branch",
      "develop",
      fileUrl(fixture.directory),
      clone,
    );
    assert.equal(cloned.status, 0, cloned.stderr);
    // Take the promisor away: now the clone holds what it holds.
    assert.equal(git(clone, "remote", "remove", "origin").status, 0);

    const result = runIssueBacklogCli(
      againstRepository(fixture.pinnedArgs({ main: mainTip }), clone),
    );
    assert.equal(result.status, 1);
    // Nothing on stdout: a refusal must not also emit a partial report that a
    // caller reading only stdout would store.
    assert.equal(result.stdout, "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    fixture.cleanUp();
  }
});
