import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the orchestrator image is a nested Dockerfile and the web service stays on Node", async () => {
  const [dockerfile, railpack, rootDockerfile] = await Promise.all([
    readRepoFile("apps/tomverse-orchestrator/Dockerfile"),
    readRepoFile("railpack.json"),
    readRepoFile("Dockerfile").then(
      () => "present",
      (error) => {
        if (error?.code === "ENOENT") return "absent";
        throw error;
      },
    ),
  ]);

  assert.equal(JSON.parse(railpack).provider, "node");
  assert.equal(rootDockerfile, "absent");
  assert.match(dockerfile, /FROM rust:1\.98\.1-bookworm AS build/);
  assert.match(
    dockerfile,
    /cargo build --release --locked -p tomverse-orchestrator/,
  );
  assert.match(
    dockerfile,
    /COPY --from=build \/src\/target\/release\/tomverse-orchestrator \/usr\/local\/bin\/tomverse-orchestrator/,
  );
  assert.match(dockerfile, /^CMD \["\/usr\/local\/bin\/tomverse-orchestrator"\]$/m);
  assert.doesNotMatch(dockerfile, /^ENTRYPOINT /m);
  assert.doesNotMatch(dockerfile, /TOMVERSE_AMUX_/);
});
