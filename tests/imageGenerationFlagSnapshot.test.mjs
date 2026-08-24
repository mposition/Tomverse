import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { imageGenerationEnabledFromValue } from "../lib/imageGenerationAccess.ts";
import {
  invalidatePublicSnapshot,
  readPublicSnapshot,
  resetPublicSnapshotCacheForTests,
} from "../lib/publicSnapshotCache.ts";

const appSettingsSource = readFileSync("lib/appSettings.ts", "utf8");

test("the image flag stays default-off however the row is missing or malformed", () => {
  // The reason it may not share an interpreter with the operational flags:
  // those are default-on kill switches, and reusing `enabledFromValue` here
  // would turn a deployment with no row into one with the feature enabled.
  for (const value of [undefined, null, "", "false", "FALSE", "1", "yes", "TRUE"]) {
    assert.equal(imageGenerationEnabledFromValue(value), false, String(value));
  }
  assert.equal(imageGenerationEnabledFromValue("true"), true);
});

test("the cached reader interprets the flag with the default-off function", () => {
  const cached = appSettingsSource.slice(
    appSettingsSource.indexOf("export async function isImageGenerationEnabledCached")
  );
  const body = cached.slice(0, cached.indexOf("\n}"));
  assert.ok(body.includes('readPublicSnapshot(\n    "image-generation-flag"'));
  assert.ok(body.includes("isImageGenerationEnabled"));
  // The default-on helper must not appear anywhere in this reader's path.
  assert.equal(body.includes("enabledFromValue("), false);
});

test("the admin toggle invalidates the snapshot it feeds", () => {
  // Without this an operator who turns image generation off keeps having it
  // announced to models, and users pointed at it, for the rest of the TTL.
  const setter = appSettingsSource.slice(
    appSettingsSource.indexOf("export async function setImageGenerationEnabled")
  );
  const body = setter.slice(0, setter.indexOf("\n}\n"));
  assert.ok(body.includes('invalidatePublicSnapshot("image-generation-flag")'));
});

test("the snapshot key caches, and invalidation makes the next read reload", async () => {
  resetPublicSnapshotCacheForTests();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return loads === 1;
  };

  const first = await readPublicSnapshot("image-generation-flag", load);
  const second = await readPublicSnapshot("image-generation-flag", load);
  assert.equal(loads, 1, "a second read inside the TTL must not hit the database");
  assert.equal(first.value, true);
  assert.equal(second.value, true);

  invalidatePublicSnapshot("image-generation-flag");
  const third = await readPublicSnapshot("image-generation-flag", load);
  assert.equal(loads, 2);
  assert.equal(third.value, false, "the toggle's new value must be served immediately");
  resetPublicSnapshotCacheForTests();
});

test("the image flag has its own key rather than riding the public app settings", () => {
  // `/api/app-settings` is unauthenticated; this flag is beta rollout state.
  const publicSettings = appSettingsSource.slice(
    appSettingsSource.indexOf("export type PublicAppSettings"),
    appSettingsSource.indexOf("const GUEST_DEFAULT_MODEL_KEY")
  );
  assert.equal(publicSettings.includes("imageGeneration"), false);
});

test("the chat route reads the cached flag, not the row, on every turn", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.ok(route.includes("isImageGenerationEnabledCached()"));
  assert.equal(route.includes("await isImageGenerationEnabled()"), false);
  const preflight = readFileSync("app/api/chat/preflight/route.ts", "utf8");
  assert.ok(preflight.includes("isImageGenerationEnabledCached()"));
  assert.equal(preflight.includes("await isImageGenerationEnabled()"), false);
});
