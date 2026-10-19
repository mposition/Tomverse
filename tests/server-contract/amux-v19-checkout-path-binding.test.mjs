import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = (path) => pathToFileURL(resolve(import.meta.dirname,
  "..", "..", path)).href;
let hostInput;
mock.module(moduleUrl("lib/amux/ideaTrackedCheckoutHostRunner.mjs"), {
  namedExports: {
    AMUX_V19_TRACKED_CHECKOUT_CLI_ENV: "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI",
    AmuxTrackedCheckoutHostError: class extends Error {},
    runAmuxV19TrackedCheckoutAnalysis: async (input) => {
      hostInput = input;
      return { kind: "outcome_unknown", cliStarted: false };
    },
  },
});
const { runAmuxV19TrackedCheckoutAnalysisWithReceipts } = await import(moduleUrl(
  "lib/amux/ideaLocalTrackedCheckoutAnalysisWithReceipts.mjs"));

test("the claim slug, never the caller path, selects the host checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amux-v19-claim-binding-"));
  const rootEnv = "TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT";
  const originEnv = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
  const v4OriginEnv = "TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN";
  const switchEnv = "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
  const names = [rootEnv, originEnv, v4OriginEnv, switchEnv];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    const selected = join(directory, "owner", "repo");
    await mkdir(selected, { recursive: true });
    execFileSync("git", ["init", "--quiet", selected]);
    execFileSync("git", ["-C", selected, "remote", "add", "origin",
      "https://github.com/owner/repo.git"]);
    process.env[rootEnv] = directory;
    process.env[originEnv] = "https://tomverse.test/";
    process.env[v4OriginEnv] = "https://tomverse.test/";
    process.env[switchEnv] = "enabled";
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const sha = "a".repeat(40);
    const paths = [];
    const input = {
      origin: "https://tomverse.test/",
      agentSecret: "v19_analysis_agent_secret_01234567890123456789",
      ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
      claimId: "ea86a25b-919f-4714-a3d8-45ef5a18b176",
      reservationId: "ea86a25b-919f-4714-a3d8-45ef5a18b177",
      requestId: "ea86a25b-919f-4714-a3d8-45ef5a18b178",
      invocationOrdinal: 0,
      referenceOrdinal: 0, commitSha: sha,
      repositoryPath: join(directory, "wrong"),
      excludedPathDigestKeyId: "checkout-digest-v1",
      fetchImpl: async (url) => {
        const endpoint = new URL(url);
        paths.push(endpoint.pathname);
        if (endpoint.pathname.endsWith("/analysis-budget/claim")) {
          assert.equal(endpoint.searchParams.get("requestId"), input.requestId);
          assert.equal(endpoint.searchParams.get("reservationId"), input.reservationId);
          assert.equal(endpoint.searchParams.get("invocationOrdinal"), "0");
          return Response.json({ status: "committed", claimId: input.claimId,
            claimStatus: "in_flight" });
        }
        return Response.json({ referenceCount: 1,
          kind: "repository", repository: "owner/repo",
          pullRequestNumber: null, pinnedCommitSha: sha });
      },
    };
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysisWithReceipts(input),
      { kind: "outcome_unknown", cliStarted: false });
    assert.equal(hostInput.repositoryPath, await realpath(selected));
    assert.notEqual(hostInput.repositoryPath, input.repositoryPath);
    assert.deepEqual(paths, [
      "/api/internal/amux/v19/analysis-budget/claim",
      "/api/internal/amux/v19/checkout-reference",
    ]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
